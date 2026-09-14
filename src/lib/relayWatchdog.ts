/**
 * P2D - リレー受信の停滞ウォッチドッグ (配信木計画書 §7 / M5 フェーズA)
 *
 * 親(中継またはホスト)からのメディアが「遅い/止まっている」ことを検知して、
 * 親の切替を促す判定を司る純粋ロジック。Reactに依存しない。
 *
 * 監視対象のアクティビティは2種類:
 * - tick: ホストが共有中、1秒毎に送る生存信号 (relay:tick)
 * - メディア: relay:h264 / relay:frame / relay:audio の着信
 * 「どちらか新しい方」が4秒 (TICK_STALE_MS) 途絶えたら停滞とみなす。
 * メディアだけで判定すると、静止画でエンコード出力が減る正常系を誤検知するため。
 *
 * 発動フロー: 停滞検知 → tree:parent_lost 送信 (RETRY_INTERVAL_MS毎に再送) →
 * 再割当が来なければ GIVE_UP_MS 後に同一親への強制再接続。
 * 切替後は COOLDOWN_MS の間、自発的な切替を起こさない (フラップ防止)。
 */

export const WATCHDOG_DEFAULTS = {
    /** tick/メディアの無音を停滞とみなすしきい値 (ms) */
    tickStaleMs: 4_000,
    /** parent_lost再送の間隔 (ms) */
    retryIntervalMs: 3_000,
    /** 再割当が来ない場合に強制再接続へ切り替えるまで (ms) */
    giveUpMs: 12_000,
    /** 切替後、自発的な切替を抑制する期間 (ms) */
    cooldownMs: 30_000,
} as const;

export type WatchdogPhase = 'idle' | 'watching' | 'stalled' | 'cooldown';

export interface WatchdogState {
    /** idle: まだメディアを受けたことがない / share_stateで解除済み */
    phase: WatchdogPhase;
    /** 最後に何か (tick/メディア) を受けた時刻 */
    lastActivityAt: number;
    /** tree:parent_lost 送信済みの開始時刻 (0 = 未送信) */
    pendingSince: number;
    /** pending中のparent_lost送信回数 */
    pendingAttempts: number;
    /** 最後に切替 (assign受理/強制再接続) をした時刻 (0 = なし) */
    lastSwitchAt: number;
}

export function initWatchdogState(now: number): WatchdogState {
    return { phase: 'idle', lastActivityAt: now, pendingSince: 0, pendingAttempts: 0, lastSwitchAt: 0 };
}

/** アクティビティ (tick/メディア着信) を記録する。停滞待ち (stalled) は解除する。
 * idle (未受信/共有停止) は activity では復帰させない — 復帰は armWatchdog 明示のみ */
export function noteActivity(state: WatchdogState, now: number): WatchdogState {
    const next: WatchdogState = { ...state, lastActivityAt: now };
    if (state.pendingSince !== 0) {
        // 停滞が解消 → pending解除
        next.pendingSince = 0;
        next.pendingAttempts = 0;
    }
    if (state.phase === 'stalled') next.phase = 'watching';
    return next;
}

/** 監視を開始する (share_state {active:true} 受信、または最初のメディア着信時) */
export function armWatchdog(state: WatchdogState, now: number): WatchdogState {
    return noteActivity({ ...state, phase: 'watching' }, now);
}

/** share_state {active:false} を受けた: 監視を解除する (ホスト側で共有停止) */
export function disarmWatchdog(state: WatchdogState, now: number): WatchdogState {
    const next = noteActivity(state, now);
    return { ...next, phase: 'idle', pendingSince: 0, pendingAttempts: 0 };
}

/**
 * 1秒毎の監視判定。
 * 戻り値の action:
 * - 'none'            : 何もしない
 * - 'notify_parent_lost': tree:parent_lost を送信 (初回または再送)
 * - 'force_reconnect'  : 同一親への強制再接続 (再割当が来なかった)
 * - 'switched'         : (参照用) 前回の切替がクールダウン中のため発動を見送り
 */
export type WatchdogAction = 'none' | 'notify_parent_lost' | 'force_reconnect';

export function checkWatchdog(
    state: WatchdogState,
    now: number,
    defaults = WATCHDOG_DEFAULTS,
): { state: WatchdogState; action: WatchdogAction } {
    const { tickStaleMs, retryIntervalMs, giveUpMs, cooldownMs } = defaults;

    // まだメディアを受けたことがない (join直後など) は監視しない
    if (state.phase === 'idle') return { state, action: 'none' };

    const silentFor = now - state.lastActivityAt;
    const stalled = silentFor >= tickStaleMs;
    const cooling = state.lastSwitchAt !== 0 && now - state.lastSwitchAt < cooldownMs;

    if (!stalled) {
        // 注意: ここで lastActivityAt を更新してはいけない (毎秒の監視自身が
        // 無音時間をリセットし、停滞を永久に検知できなくなる)。
        // lastActivityAt は実際の着信 (noteActivity) だけが進める。
        return { state, action: 'none' };
    }

    // 停滞している
    if (state.pendingSince !== 0) {
        const pendingFor = now - state.pendingSince;
        if (pendingFor >= giveUpMs) {
            // 再割当が来ない → 同一親へ強制再接続して最初からやり直す
            const next: WatchdogState = {
                ...state,
                lastSwitchAt: now,
                pendingSince: 0,
                pendingAttempts: 0,
            };
            return { state: next, action: 'force_reconnect' };
        }
        const dueAt = state.pendingSince + (state.pendingAttempts) * retryIntervalMs;
        if (now >= dueAt) {
            const next: WatchdogState = { ...state, pendingAttempts: state.pendingAttempts + 1 };
            return { state: next, action: 'notify_parent_lost' };
        }
        return { state, action: 'none' };
    }

    // 初検知。クールダウン中なら自発的切替を見送る (完全切断はL3経路に任せる)
    if (cooling) {
        return { state: { ...state, phase: 'stalled' }, action: 'none' };
    }
    const next: WatchdogState = {
        ...state,
        phase: 'stalled',
        pendingSince: now,
        pendingAttempts: 1,
    };
    return { state: next, action: 'notify_parent_lost' };
}

/**
 * 停滞・劣化の原因分類 (M5 フェーズB拡張: ホスト健康の可視化)。
 * - 'host-load': 配信元PCが高負荷 (エンコード周期の超過が継続)
 * - 'route'    : ホストは送っているのに受信が少ない (経路の輻輳・ロス)
 * - null       : 原因なし (正常 / 静止画での送信減少という正常系)
 *
 * 判定の考え方: ホストがtickで「直近1秒に送ったメディア量」と「送信周期の
 * 超過」を報告する。視聴者は自分の受信量と突き合わせ、
 * 「送っているのに届いていない」なら経路、「そもそも送れていない」なら配信元、
 * と切り分ける。これで「親が安定している」前提でも、停滞の*責任分界*を見せられる。
 */
export type LinkCause = 'host-load' | 'route' | null;

/** ホスト高負荷とみなす連続tick数 (1秒周期なので3秒相当) */
export const HOST_LOAD_STREAK = 3;
/** 経路劣化とみなす最低送信量 (base64換算バイト/秒)。これ未満は静止画の正常系 */
export const ROUTE_CHECK_MIN_SENT = 50_000;

export function diagnoseLinkCause(opts: {
    /** 直近のtickでホストが報告した周期超過 (load=high) */
    tickLoadHigh: boolean;
    /** load=high の連続回数 */
    highStreak: number;
    /** ホストが報告した直近1秒の送信量 (base64バイト) */
    hostSentLastSec: number;
    /** 視聴者の直近1秒の受信量 (同単位) */
    receivedLastSec: number;
}): LinkCause {
    if (opts.tickLoadHigh && opts.highStreak >= HOST_LOAD_STREAK) return 'host-load';
    if (opts.hostSentLastSec >= ROUTE_CHECK_MIN_SENT
        && opts.receivedLastSec < opts.hostSentLastSec * 0.3) return 'route';
    return null;
}

/** リンク健康レベル (見える化用。mesh/配信木で共通のバッジに使う) */
export type LinkLevel = 'ok' | 'degraded' | 'stalled' | 'idle';

/**
 * 現在のリンク健康を判定する (フェーズB)。
 * - ok: 無音が警告しきい値 (停滞しきい値の半分) 未満
 * - degraded: 警告しきい値以上・停滞しきい値未満 (切替はしない。バッジ黄)
 * - stalled: 停滞しきい値以上 (parent_lost送信対象。バッジ赤)
 * - idle: まだ受信していない / 共有停止で監視解除中
 */
export function classifyLink(
    state: WatchdogState,
    now: number,
    defaults = WATCHDOG_DEFAULTS,
): LinkLevel {
    if (state.phase === 'idle') return 'idle';
    const silentFor = now - state.lastActivityAt;
    if (silentFor >= defaults.tickStaleMs) return 'stalled';
    if (silentFor >= defaults.tickStaleMs / 2) return 'degraded';
    return 'ok';
}

/** 切替 (assign受理/強制再接続) を記録する */
export function noteSwitch(state: WatchdogState, now: number): WatchdogState {
    return {
        ...state,
        lastSwitchAt: now,
        pendingSince: 0,
        pendingAttempts: 0,
        lastActivityAt: now, // 切替直後は無音が正常 (再購読待ち) なので基準を張り直す
    };
}
