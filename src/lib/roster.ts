/**
 * P2D - 名簿ゴシップ (レンデブー最小化計画 M1)
 *
 * サーバーが権威だったメンバー名簿を、DataChannel上のゴシップで全員が
 * 同一名簿を持つ構成へ移行する。書き込み権威は存在しないため、合流は
 * 「joinedAt が新しい方を採用する決定論的 union」+「depart墓石 (tombstone)
 * より古い参加は復活させない」で収束させる (計画書 §3.1)。
 *
 * このモジュールはReactに依存しない純関数群。単体テストの対象
 * (node --import tsx --test で実行、split-brain合流を含む)。
 */

// 1名分の参加者エントリ。hostEndpoint はホストが内蔵WSサーバーをlistenしている
// 場合の住所 (host:port) — サーバー死亡後の再合流・サーバーレス参加に使う (M2/M4)
export interface RosterEntry {
    id: string;
    name?: string;
    joinedAt: number;
    hostEndpoint?: string;
}

// 離脱の墓石。departedAt より古い joinedAt のエントリは復活させない
export interface RosterTombstone {
    id: string;
    departedAt: number;
}

export interface RosterState {
    entries: Map<string, RosterEntry>;
    tombstones: Map<string, RosterTombstone>;
}

// 名簿・墓石の上限 (悪意ある/バグったピアによる無制限増殖の防御)
export const ROSTER_MAX_ENTRIES = 256;
export const ROSTER_MAX_TOMBSTONES = 512;

export function initRoster(): RosterState {
    return { entries: new Map(), tombstones: new Map() };
}

/**
 * エントリ1件をマージする (決定論的union)。
 * 同一IDの衝突は joinedAt が大きい (新しい) 方を採用し、完全に同時刻のときは
 * name の辞書順が小さい方を採用する — 全ノードが同じ結果に収束する。
 * 戻り値: 名簿に変化があったか (ゴシップ再送の判断に使う)
 */
export function mergeEntry(state: RosterState, entry: RosterEntry): boolean {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return false;
    if (typeof entry.joinedAt !== 'number' || !Number.isFinite(entry.joinedAt)) return false;

    // 墓石より古い (または同時刻の) 参加は復活させない
    const tomb = state.tombstones.get(entry.id);
    if (tomb && entry.joinedAt <= tomb.departedAt) return false;

    const existing = state.entries.get(entry.id);
    if (existing) {
        const preferNew =
            entry.joinedAt > existing.joinedAt ||
            (entry.joinedAt === existing.joinedAt && compareName(entry.name, existing.name) < 0);
        if (!preferNew) return false;
    }

    state.entries.set(entry.id, {
        id: entry.id,
        name: entry.name,
        joinedAt: entry.joinedAt,
        hostEndpoint: entry.hostEndpoint,
    });
    trimOldest(state.entries, ROSTER_MAX_ENTRIES);
    return true;
}

/**
 * 離脱をマージする。departedAt が既存墓石より新しい場合のみ記録し、
 * その時刻以前に参加したエントリを名簿から取り除く。
 * 戻り値: 変化があったか
 */
export function applyDepart(state: RosterState, id: string, departedAt: number): boolean {
    if (typeof id !== 'string' || id.length === 0) return false;
    if (typeof departedAt !== 'number' || !Number.isFinite(departedAt)) return false;

    const existingTomb = state.tombstones.get(id);
    if (existingTomb && departedAt <= existingTomb.departedAt) return false;

    state.tombstones.set(id, { id, departedAt });
    trimOldest(state.tombstones, ROSTER_MAX_TOMBSTONES);

    const entry = state.entries.get(id);
    if (entry && entry.joinedAt <= departedAt) {
        state.entries.delete(id);
        return true;
    }
    return true; // 墓石自体は更新されたので変化あり扱い
}

/**
 * 名簿全体をマージする (roster:sync 受信側)。両stateは破壊せず新しいstateを返す。
 * split-brain (2台が同時に参加して名簿が割れた) からの合流は、
 * 両者が同じ入力に対して必ず同じ出力を得るこの関数の決定論性で担保される。
 */
export function mergeRosters(mine: RosterState, theirs: RosterState): RosterState {
    const merged: RosterState = {
        entries: new Map(mine.entries),
        tombstones: new Map(mine.tombstones),
    };
    for (const t of theirs.tombstones.values()) {
        applyDepart(merged, t.id, t.departedAt);
    }
    for (const e of theirs.entries.values()) {
        mergeEntry(merged, e);
    }
    return merged;
}

/**
 * 自分の知る名簿が相手と一致するか (収束確認・テスト用)。
 * entries と tombstones の両方が同一内容なら true。
 */
export function rostersConverged(a: RosterState, b: RosterState): boolean {
    const keyOf = (s: RosterState) => JSON.stringify({
        e: [...s.entries.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
        t: [...s.tombstones.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
    });
    return keyOf(a) === keyOf(b);
}

export function rosterEntries(state: RosterState): RosterEntry[] {
    return [...state.entries.values()];
}

export function cloneRoster(state: RosterState): RosterState {
    return {
        entries: new Map(state.entries),
        tombstones: new Map(state.tombstones),
    };
}

function compareName(a?: string, b?: string): number {
    const av = a ?? '';
    const bv = b ?? '';
    return av < bv ? -1 : av > bv ? 1 : 0;
}

/** 上限超過時は joinedAt (tombstoneは departedAt) が古いものから落とす */
function trimOldest(map: Map<string, { joinedAt?: number; departedAt?: number }>, max: number): void {
    if (map.size <= max) return;
    const sorted = [...map.entries()].sort((x, y) => {
        const xv = x[1].joinedAt ?? x[1].departedAt ?? 0;
        const yv = y[1].joinedAt ?? y[1].departedAt ?? 0;
        return xv - yv;
    });
    while (sorted.length > max) {
        const [oldestId] = sorted.shift()!;
        map.delete(oldestId);
    }
}

/**
 * ゴシップ経由で未知のピアを発見したとき、自分から接続を開始すべきかを決める。
 * 双方が同時に接続するとglareになるため、IDの辞書順で片側だけが開始する
 * (既存のICE再起動グレア対策と同じ規約)。
 */
export function shouldInitiateTo(myId: string, peerId: string): boolean {
    return myId >= peerId;
}
