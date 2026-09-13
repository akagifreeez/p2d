/**
 * DC中継シグナリング経路選択の単体テスト (M2)
 * 実行: node --import tsx --test --test-force-exit test/signalRouter.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    chooseSignalRoute, makeEnvelope, forwardEnvelope, TUNNEL_MAX_HOPS,
} from '../src/lib/signalRouter.js';

test('WSが生きている場合は従来経路 (サーバー) を使う', () => {
    const r = chooseSignalRoute('target', {
        wsOpen: true, myId: 'me', hasDirectDc: true, relayCandidates: ['other'],
    });
    assert.equal(r.via, 'ws');
});

test('WS死亡 + 宛先へDC直結 → dc-direct', () => {
    const r = chooseSignalRoute('target', {
        wsOpen: false, myId: 'me', hasDirectDc: true, relayCandidates: [],
    });
    assert.equal(r.via, 'dc-direct');
});

test('WS死亡 + 宛先DCなし → 決定論的中継ピア経由 (dc-relay)', () => {
    const r = chooseSignalRoute('target', {
        wsOpen: false, myId: 'me', hasDirectDc: false, relayCandidates: ['zeta', 'alpha', 'mid'],
    });
    assert.equal(r.via, 'dc-relay');
    assert.equal(r.relayPeer, 'alpha'); // ソート先頭 — 全員が同じ中継を選ぶ
});

test('誰にも届かない場合は none', () => {
    const r = chooseSignalRoute('target', {
        wsOpen: false, myId: 'me', hasDirectDc: false, relayCandidates: [],
    });
    assert.equal(r.via, 'none');
});

test('自分自身と宛先は中継候補から除外される', () => {
    const r = chooseSignalRoute('target', {
        wsOpen: false, myId: 'alpha', hasDirectDc: false, relayCandidates: ['alpha', 'target', 'mid'],
    });
    assert.equal(r.relayPeer, 'mid');
});

test('envelope: ホップ制限以内で作られ、転送で1消費、0で転送不可', () => {
    const env = makeEnvelope('sender', 'offer', 'target', { sdp: 'x' });
    assert.equal(env.hops, TUNNEL_MAX_HOPS);
    const f1 = forwardEnvelope(env);
    assert.ok(f1);
    assert.equal(f1.hops, TUNNEL_MAX_HOPS - 1);
    const f2 = forwardEnvelope(f1);
    assert.ok(f2);
    assert.equal(f2.hops, 0);
    assert.equal(forwardEnvelope(f2), null); // ホップ枯渇で転送不可
});
