/**
 * 配信木 割り当てコアの単体テスト (配信木計画書 M1/M3)
 * 受け入れ基準: 10ノード割り当てシミュレーションで深さ≤3・fan-out≤上限、
 * 中継者kill→孤児再割り当てが成立すること
 * 実行: node --import tsx --test --test-force-exit test/treeAssign.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createRoot, attach, attachUnder, promote, pickParent, detachSubtree, reassignOrphans,
    validateInvariants, findNode, flatten, findPromoteCandidate, findDownlinkRelay,
    ROOT_FANOUT, RELAY_FANOUT, MAX_DEPTH,
} from '../src/lib/treeAssign.js';

test('M1: 10ノード割り当てシミュレーション — 深さ≤3・fan-out≤上限を満たす', () => {
    const root = createRoot('host', ROOT_FANOUT);
    // ホスト直結は4人まで
    for (let i = 1; i <= 4; i++) {
        const n = attach(root, { id: `v${i}`, addr: null, depth: 0, fanout: 0, children: [] });
        assert.ok(n, `v${i} はホスト直結で入る`);
        assert.equal(n.depth, 1);
    }
    // 5人目: ホスト直結は満杯で中継がいない → 追加不可
    assert.equal(pickParent(root), null, '中継がいない状態で5人目は入らない');

    // v1を中継に昇格 (fan-out 2) → 空きスロット誕生
    promote(findNode(root, 'v1')!, { host: '192.168.1.10', port: 9001 });
    for (let i = 5; i <= 6; i++) {
        const n = attach(root, { id: `v${i}`, addr: null, depth: 0, fanout: 0, children: [] });
        assert.ok(n, `v${i} は v1 の子に入る`);
        assert.equal(n.depth, 2);
    }
    assert.equal(findNode(root, 'v1')!.children.length, RELAY_FANOUT, '中継fan-out=2で満杯');

    // v7: 枠なし → v2を中継に昇格して収容
    assert.equal(pickParent(root), null);
    promote(findNode(root, 'v2')!, { host: '192.168.1.11', port: 9002 });
    const v7 = attach(root, { id: 'v7', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(v7);
    assert.equal(v7.depth, 2);

    // v8, v9: v3を中継に昇格して収容 → 合計10ノード
    promote(findNode(root, 'v3')!, { host: '192.168.1.12', port: 9003 });
    attach(root, { id: 'v8', addr: null, depth: 0, fanout: 0, children: [] });
    attach(root, { id: 'v9', addr: null, depth: 0, fanout: 0, children: [] });

    const inv = validateInvariants(root);
    assert.ok(inv.ok, `不変条件違反: ${inv.violations.join(', ')}`);
    assert.equal(flatten(root).length, 10, 'ホスト+視聴者9人=10ノード');
});

test('M3: 中継者kill → subtree一括孤児化+再割り当てで全員復帰', () => {
    const root = createRoot('host');
    // host直結: a,b,c,d / cを中継にして c1,c2 / dを中継にして d1 (dは空き1枠)
    attach(root, { id: 'a', addr: null, depth: 0, fanout: 0, children: [] });
    attach(root, { id: 'b', addr: null, depth: 0, fanout: 0, children: [] });
    promote(attachUnder(root, 'host', { id: 'c', addr: null, depth: 0, fanout: 0, children: [] })!,
        { host: '10.0.0.3', port: 9003 });
    attachUnder(root, 'c', { id: 'c1', addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'c', { id: 'c2', addr: null, depth: 0, fanout: 0, children: [] });
    promote(attachUnder(root, 'host', { id: 'd', addr: null, depth: 0, fanout: 0, children: [] })!,
        { host: '10.0.0.4', port: 9004 });
    attachUnder(root, 'd', { id: 'd1', addr: null, depth: 0, fanout: 0, children: [] });

    // c がkillされる → c1,c2 が孤児
    const orphans = detachSubtree(root, 'c');
    assert.deepEqual(orphans.map(o => o.id).sort(), ['c1', 'c2']);
    assert.equal(findNode(root, 'c1'), null);

    // 空きスロットへ再割り当て (cのスロットとdの空き等)
    const plan = reassignOrphans(root, orphans.map(o => o.id));
    assert.equal(plan.size, 2);
    for (const [, parent] of plan) {
        assert.notEqual(parent.id, 'c', '死んだ中継を親に選ばない');
    }
    const inv = validateInvariants(root);
    assert.ok(inv.ok, `再割り当て後に不変条件違反: ${inv.violations.join(', ')}`);
});

test('M3: 連鎖離脱 — 中継の子の中継が消えても subtree一括で処理する', () => {
    const root = createRoot('host');
    attach(root, { id: 'a', addr: null, depth: 0, fanout: 0, children: [] });
    promote(attachUnder(root, 'host', { id: 'b', addr: null, depth: 0, fanout: 0, children: [] })!,
        { host: '10.0.0.2', port: 9002 });
    promote(attachUnder(root, 'b', { id: 'b1', addr: null, depth: 0, fanout: 0, children: [] })!,
        { host: '10.0.0.21', port: 9021 });
    attachUnder(root, 'b1', { id: 'b1x', addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'b1', { id: 'b1y', addr: null, depth: 0, fanout: 0, children: [] });

    const orphans = detachSubtree(root, 'b1');
    assert.deepEqual(orphans.map(o => o.id).sort(), ['b1x', 'b1y']);
    assert.equal(findNode(root, 'b1')?.children.length ?? 0, 0);
    // b は生き残っている
    assert.ok(findNode(root, 'b'));
});

test('根 (ホスト) の消失は再割り当て対象外', () => {
    const root = createRoot('host');
    attach(root, { id: 'a', addr: null, depth: 0, fanout: 0, children: [] });
    assert.deepEqual(detachSubtree(root, 'host'), []);
});

test('深さ上限: 深さ3まで奥深く作れ、それ以上は拒否される', () => {
    const root = createRoot('host');
    // host(0) → r1(1) → r2(2) → leaf(3) が最大 (各段階で中継を昇格しながら奥へ)
    const chain = (parent: string, id: string, port: number) => {
        promote(attachUnder(root, parent, { id, addr: null, depth: 0, fanout: 0, children: [] })!,
            { host, port }, 1);
    };
    const host = 'h0';
    chain('host', 'r1', 1);
    chain('r1', 'r2', 2);
    chain('r2', 'r3', 3);
    assert.equal(findNode(root, 'r3')!.depth, MAX_DEPTH, '深さ3までは構築できる');
    // 深さ4は作れない: pickParentは深さ3のノードを親に選ばない (他に空きがあれば
    // 浅い親を返す=幅優先どおり。空きが全くない場合のみnull)
    promote(findNode(root, 'r3')!, { host: 'h4', port: 4 }, 1);
    const p = pickParent(root);
    if (p) {
        assert.ok(p.depth + 1 <= MAX_DEPTH, `深さ${p.depth + 1}の割り当ては許可されない`);
    }
    const inv = validateInvariants(root);
    assert.ok(inv.ok, `不変条件違反: ${inv.violations.join(', ')}`);
});

test('幅優先: 浅いノードから順に満たす', () => {
    const root = createRoot('host', 2);
    promote(attach(root, { id: 'r1', addr: null, depth: 0, fanout: 0, children: [] })!,
        { host: 'h1', port: 1 });
    const p = pickParent(root);
    assert.ok(p);
    // ホスト直結(深さ1)がまだ空き → そちらが優先される
    assert.equal(p.id, 'host');
});

test('issue#7: fanout=2で9視聴者 — BFS昇格により全員がfan-out/深さ上限内で収容される', () => {
    const root = createRoot('host', 2);
    let portSeq = 9000;
    const promoteShallowest = () => {
        const cand = findPromoteCandidate(root, 3);
        if (!cand) return false;
        promote(cand, { host: 'h' + cand.id, port: portSeq++ }, 2);
        return true;
    };
    let assigned = 0;
    for (let i = 1; i <= 9; i++) {
        const id = 'v' + i;
        let parent = pickParent(root, 3);
        if (!parent) {
            if (promoteShallowest()) parent = pickParent(root, 3);
        }
        assert.ok(parent, `v${i}: 割り当て先が見つかるべき (assigned=${assigned})`);
        attach(root, { id, addr: null, depth: 0, fanout: 0, children: [] });
        assigned++;
    }
    assert.equal(assigned, 9);
    const inv = validateInvariants(root, 3);
    assert.ok(inv.ok, `不変条件違反: ${inv.violations.join(', ')}`);
    // 中継のfan-outは全て上限2以内 (validateInvariantsが検証済み)
});

test('issue#7: fanout=1でも鎖が深さ3まで構築され、以降は拒否される', () => {
    const root = createRoot('host', 1);
    let portSeq = 9000;
    for (let i = 1; i <= 5; i++) {
        const id = 'c' + i;
        let parent = pickParent(root, 3);
        if (!parent) {
            const cand = findPromoteCandidate(root, 3);
            if (!cand) { assert.ok(i > 3, `c${i} は深さ上限までの間なら割り当てられるべき`); break; }
            promote(cand, { host: 'h' + cand.id, port: portSeq++ }, 1);
            parent = pickParent(root, 3);
        }
        assert.ok(parent, `c${i}: 割り当て成功するべき`);
        attach(root, { id, addr: null, depth: 0, fanout: 0, children: [] });
    }
    assert.equal(flatten(root).length, 4); // host + c1..c3 (深さ上限=3なのでc4以降は拒否)
    const inv = validateInvariants(root, 3);
    assert.ok(inv.ok);
});

// === issue#8: findDownlinkRelay (配信木経由の視聴者への通知経路) ===

test('findDownlinkRelay: 直結ノードは自分自身、深い場所は深さ1の中継、root/不明はnull', () => {
    const root = createRoot('host');
    // 直結: r1(中継) と v1(視聴者)
    const r1 = attach(root, { id: 'r1', addr: null, depth: 0, fanout: 0, children: [] })!;
    promote(r1, { host: '10.0.0.2', port: 8090 });
    const v1 = attach(root, { id: 'v1', addr: null, depth: 0, fanout: 0, children: [] });
    // r1配下: r2(中継) とその子 v2
    attachUnder(root, 'r1', { id: 'r2', addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'r2', { id: 'v2', addr: null, depth: 0, fanout: 0, children: [] });

    assert.equal(findDownlinkRelay(root, 'host'), null, 'root自身は通知不要');
    assert.equal(findDownlinkRelay(root, 'r1')?.id, 'r1', '直結中継は自分自身');
    assert.equal(findDownlinkRelay(root, 'v1')?.id, 'v1', '直結視聴者は自分自身 (直接送れる)');
    assert.equal(findDownlinkRelay(root, 'v2')?.id, 'r1', '奥の視聴者への下りリンクは直結中継r1');
    assert.equal(findDownlinkRelay(root, 'r2')?.id, 'r1', '奥の中継への下りリンクも直結中継r1');
    assert.equal(findDownlinkRelay(root, 'unknown'), null);
    assert.ok(v1);
});

// === M5§7: 親停滞の再割り当て用 detachNode ===
import { detachNode, pickParentScored } from '../src/lib/treeAssign.js';

test('detachNode: 深い位置の葉を取り除ける (根・中継は壊さない)', () => {
    const root = createRoot('host');
    const relay = attach(root, { id: 'relay', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(relay);
    promote(relay, { host: 'h', port: 1 });
    const grandchild = attachUnder(root, 'relay', { id: 'gc', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(grandchild);

    assert.equal(detachNode(root, 'gc'), true);
    assert.equal(findNode(root, 'gc'), null);
    assert.equal(findNode(root, 'relay') !== null, true, '中継は残る');
    assert.equal(detachNode(root, 'host'), false, '根は取り除けない');
    assert.equal(detachNode(root, 'unknown'), false);
});

test('M5§7: pickParent/attach の skip で不健康な中継を親候補から外せる', () => {
    const root = createRoot('host');
    const relay = attach(root, { id: 'relay', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(relay);
    promote(relay, { host: 'h', port: 1 });
    // root直結 (fanout4) を中継1 + 直結2でほぼ満員にする (残り1枠)
    for (const id of ['g1', 'g2']) attachUnder(root, 'host', { id, addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'host', { id: 'g3', addr: null, depth: 0, fanout: 0, children: [] });
    assert.equal(root.children.length, 4, 'root直結は満員');

    // skip無し → 幅優先で中継が選ばれる
    const p2 = pickParent(root, 3);
    assert.equal(p2?.id, 'relay');

    // 中継を不健康扱いする skip → 候補ゼロ (他に空きがない)
    const p1 = pickParent(root, 3, (n) => n.id === 'relay');
    assert.equal(p1, null);
});

test('M5§7: pickParentScored — 同一深さ内では健康スコア、深さは最優先', () => {
    const root = createRoot('host');
    // root直結を1枠だけ空けて満員にする (中継2台が直結に付く)
    const r1 = attach(root, { id: 'relay1', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(r1);
    promote(r1, { host: 'h', port: 1 });
    const r2 = attach(root, { id: 'relay2', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(r2);
    promote(r2, { host: 'h', port: 2 });
    attachUnder(root, 'host', { id: 'g1', addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'host', { id: 'g2', addr: null, depth: 0, fanout: 0, children: [] });
    attachUnder(root, 'host', { id: 'g3', addr: null, depth: 0, fanout: 0, children: [] });

    // 同一深さ(深さ1)で relay2 の方が健康 → relay2が選ばれる
    const score = (n: { id: string }) => (n.id === 'relay1' ? 3 : n.id === 'relay2' ? 1 : 2);
    assert.equal(pickParentScored(root, 3, { score })?.id, 'relay2');
    // スコア逆転 → relay1
    assert.equal(pickParentScored(root, 3, { score: (n) => (n.id === 'relay1' ? 1 : 3) })?.id, 'relay1');
    // 両方不健康 (skip) → 候補ゼロ
    assert.equal(pickParentScored(root, 3, { skip: (n) => n.id === 'relay1' || n.id === 'relay2' }), null);
    // 深さ優先: 深さ1に空きがあれば、スコアの悪い深さ2より深さ1が選ばれる
    const child1 = attachUnder(root, 'relay1', { id: 'c1', addr: null, depth: 0, fanout: 0, children: [] });
    assert.ok(child1);
    promote(child1, { host: 'h', port: 3 }); // fanout2 → c1配下に空き (深さ2)
    const r1node = r1; // relay1はfanout2でc1を1人収容 → 残り1枠
    const p = pickParentScored(root, 3, {
        score: (n) => (n.id === 'c1' ? 1 : n.id === 'relay1' ? 3 : 9),
    });
    assert.equal(p?.id, 'relay1', '深さ1(relay1, score3)は深さ2(c1, score1)より優先');
    void r1node;
});
