/**
 * 名簿ゴシップ単体テスト (レンデブー最小化計画 M1)
 * 受け入れ基準: split-brain (2台同時参加) の合流テスト — 名簿が収束すること
 * 実行: node --import tsx --test --test-force-exit test/roster.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initRoster, mergeEntry, applyDepart, mergeRosters, rostersConverged,
    rosterEntries, shouldInitiateTo,
    type RosterState,
} from '../src/lib/roster.js';

function entry(id: string, joinedAt: number, name?: string, hostEndpoint?: string) {
    return { id, joinedAt, name, hostEndpoint };
}

test('エントリ追加と単純マージ: 和集合に収束する', () => {
    const a = initRoster();
    const b = initRoster();
    mergeEntry(a, entry('alice', 1000, 'Alice'));
    mergeEntry(b, entry('bob', 1001, 'Bob'));

    const ab = mergeRosters(a, b);
    const ba = mergeRosters(b, a);

    assert.equal(rosterEntries(ab).length, 2);
    assert.ok(rostersConverged(ab, ba), 'A→B と B→A のマージ結果が一致する');
});

test('同一ID衝突はjoinedAtが新しい方を採用する (決定論的)', () => {
    const a = initRoster();
    const b = initRoster();
    mergeEntry(a, entry('p1', 1000, 'OldName'));
    mergeEntry(b, entry('p1', 2000, 'NewName'));

    const ab = mergeRosters(a, b);
    const ba = mergeRosters(b, a);
    assert.equal(ab.entries.get('p1')?.name, 'NewName');
    assert.ok(rostersConverged(ab, ba));
});

test('joinedAtが完全に同時の衝突も名前の辞書順で決定論的に片方に決まる', () => {
    const a = initRoster();
    const b = initRoster();
    mergeEntry(a, entry('p1', 1000, 'zeta'));
    mergeEntry(b, entry('p1', 1000, 'alpha'));

    const ab = mergeRosters(a, b);
    const ba = mergeRosters(b, a);
    assert.equal(ab.entries.get('p1')?.name, 'alpha'); // 辞書順 小さい方
    assert.ok(rostersConverged(ab, ba));
});

test('split-brain: 2台が同時参加して名簿が割れても1回の交換で収束する', () => {
    // ノードH (ホスト) とノードG (ゲスト) が同時に参加し、
    // お互いの存在を知らない状態から始まる (同時参加の割れ)
    const h = initRoster();
    const g = initRoster();
    mergeEntry(h, entry('host-id', 100, 'Host', '192.168.1.10:8090'));
    mergeEntry(h, entry('witness-x', 105, 'X')); // Hだけが知る第三者
    mergeEntry(g, entry('guest-id', 100, 'Guest'));
    mergeEntry(g, entry('witness-y', 105, 'Y')); // Gだけが知る第三者

    // お互いの名簿を交換 (roster:sync を1回ずつ送り合う)
    const h2 = mergeRosters(h, g);
    const g2 = mergeRosters(g, h);

    assert.ok(rostersConverged(h2, g2), '交換後に両者の名簿が完全一致する');
    assert.equal(rosterEntries(h2).length, 4); // host + guest + x + y
});

test('split-brain: 同じピアの離脱と再参加が絡んでも収束する', () => {
    const a = initRoster();
    const b = initRoster();

    // 共通認識: p1 が時刻100に参加
    mergeEntry(a, entry('p1', 100));
    mergeEntry(b, entry('p1', 100));

    // Aだけが p1 の離脱を検知 (時刻200)
    applyDepart(a, 'p1', 200);

    // Bは古い情報 (離脱前のコピー) を持ち続ける
    const a2 = mergeRosters(a, b);
    // BのentryはjoinedAt=100なので墓石(200)に負けて消える
    assert.equal(a2.entries.has('p1'), false);

    // p1が時刻300に再参加 → 墓石より新しいため復活する
    const a3 = cloneOf(a2);
    mergeEntry(a3, entry('p1', 300, 'rejoined'));
    assert.equal(a3.entries.has('p1'), true);
    assert.ok(!rostersConverged(a3, a2)); // 再参加は収束を崩す (正常)
});

test('墓石より古い参加は復活させない (遅延ゴシップ耐性)', () => {
    const a = initRoster();
    applyDepart(a, 'p1', 500); // すでに離脱を知っている
    const changed = mergeEntry(a, entry('p1', 100)); // 古いjoinが遅れて届く
    assert.equal(changed, false);
    assert.equal(a.entries.has('p1'), false);
});

test('離脱したメンバーのkillが全名簿に反映される (depart合流)', () => {
    const host = initRoster();
    const g1 = initRoster();
    const g2 = initRoster();
    for (const r of [host, g1, g2]) {
        mergeEntry(r, entry('host', 10, 'H'));
        mergeEntry(r, entry('g1', 20, 'A'));
        mergeEntry(r, entry('g2', 30, 'B'));
    }
    // g2がkillされる → hostが最初に検知してdepartをゴシップ
    applyDepart(host, 'g2', 999);
    applyDepart(g1, 'g2', 999);

    const hostM = mergeRosters(host, g1);
    const g1M = mergeRosters(g1, host);
    const g2M = mergeRosters(g2, g1M); // g2は死んでいるが最後に知っていたstate

    assert.ok(rostersConverged(hostM, g1M));
    assert.equal(g2M.entries.has('g2'), false, 'killされたメンバーが全員の名簿から消える');
    assert.equal(rosterEntries(g2M).length, 2);
});

test('マージは非破壊 (元のstateを書き換えない)', () => {
    const a = initRoster();
    const b = initRoster();
    mergeEntry(a, entry('x', 1));
    mergeEntry(b, entry('y', 2));
    mergeRosters(a, b);
    assert.equal(a.entries.size, 1);
    assert.equal(rosterEntries(b).length, 1);
});

test('shouldInitiateTo: ID辞書順でglareを防ぐ規約が対称', () => {
    const a = 'aaaa';
    const b = 'bbbb';
    assert.equal(shouldInitiateTo(a, b), false);
    assert.equal(shouldInitiateTo(b, a), true);
    // 同一IDなら必ず片側だけ (相等は両側trueになりうるが同一IDは自分自身なので対象外)
});

test('境界: 不正エントリ・上限超過でも落ちない', () => {
    const r: RosterState = initRoster();
    assert.equal(mergeEntry(r, { id: '', joinedAt: 1 }), false);
    assert.equal(mergeEntry(r, { id: 'x', joinedAt: Number.NaN }), false);
    assert.equal(applyDepart(r, '', 1), false);
    for (let i = 0; i < 300; i++) {
        mergeEntry(r, { id: `peer-${i}`, joinedAt: i });
    }
    assert.ok(r.entries.size <= 256);
});

function cloneOf(s: RosterState): RosterState {
    return { entries: new Map(s.entries), tombstones: new Map(s.tombstones) };
}
