/**
 * 部屋コア (Cloudflare Workers版シグナリング) の単体テスト
 * 中央サーバー (signaling-server) と同一プロトコルのサブセットを検証
 * 実行: node --import tsx --test --test-force-exit test/room-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createRoomCore, coreAck, coreDisconnect, coreMessage, type OutMessage,
} from '../src/room-core.js';

function newCore(max = 8) {
    return createRoomCore('TEST12', max);
}

function join(core: ReturnType<typeof newCore>, id: string, name?: string) {
    const outs = coreMessage(core, id, { type: 'room:join', payload: { roomCode: 'TEST12', name } });
    return outs;
}

function ids(outs: OutMessage[]): string[] {
    return outs.map(o => o.to);
}

test('接続ack: myIdが払い出される', () => {
    const core = newCore();
    const ack = coreAck(core, 'c1');
    assert.equal(ack.to, 'c1');
    const payload = (ack.data as { payload: { myId: string } }).payload;
    assert.equal(payload.myId, 'c1');
});

test('create: created+joined応答。hostEndpointが電話帳に載る', () => {
    const core = newCore();
    coreAck(core, 'host');
    const outs = coreMessage(core, 'host', {
        type: 'room:create', payload: { name: 'Host', roomCode: 'TEST12', hostEndpoint: '192.168.1.5:8090' },
    });
    const types = outs.map(o => (o.data as { type: string }).type);
    assert.deepEqual(types, ['room:created', 'room:joined']);
    const created = (outs[0].data as { payload: { hostEndpoint?: string } }).payload;
    assert.equal(created.hostEndpoint, '192.168.1.5:8090');
    const joined = (outs[1].data as { payload: { hostEndpoint?: string } }).payload;
    assert.equal(joined.hostEndpoint, '192.168.1.5:8090');
});

test('join: 既存メンバーへpeer:joined、自分へ参加者リスト+電話帳', () => {
    const core = newCore();
    coreAck(core, 'host');
    coreMessage(core, 'host', { type: 'room:create', payload: { name: 'Host', hostEndpoint: 'h:1' } });
    coreAck(core, 'guest');
    const outs = join(core, 'guest', 'Guest');

    const toHost = outs.find(o => o.to === 'host');
    assert.ok(toHost, 'hostへpeer:joinedが届く');
    assert.equal((toHost.data as { type: string }).type, 'peer:joined');

    const toGuest = outs.find(o => o.to === 'guest');
    const payload = (toGuest!.data as { payload: { participants: { id: string }[]; hostEndpoint: string } }).payload;
    assert.deepEqual(payload.participants.map(p => p.id), ['host']);
    assert.equal(payload.hostEndpoint, 'h:1');
});

test('満室: ROOM_FULLエラーで拒否', () => {
    const core = newCore(2);
    coreAck(core, 'a');
    coreMessage(core, 'a', { type: 'room:create', payload: { name: 'a' } });
    coreAck(core, 'b');
    join(core, 'b', 'b');
    coreAck(core, 'c');
    const outs = join(core, 'c', 'c');
    const err = outs[0].data as { type: string; payload: { code: string } };
    assert.equal(err.type, 'error');
    assert.equal(err.payload.code, 'ROOM_FULL');
});

test('offer/ice/relay転送: 同一部屋メンバー間のみ。非メンバー宛はエラー', () => {
    const core = newCore();
    coreAck(core, 'host');
    coreMessage(core, 'host', { type: 'room:create', payload: {} });
    coreAck(core, 'v1');
    join(core, 'v1');
    coreAck(core, 'v2');
    join(core, 'v2');
    coreAck(core, 'v3');
    join(core, 'v3');

    const offer = { type: 'peer:offer', targetId: 'v1', payload: { sdp: 'x' } };
    const out1 = coreMessage(core, 'v2', offer);
    assert.equal(out1.length, 1);
    assert.equal(out1[0].to, 'v1');
    assert.equal((out1[0].data as { senderId: string }).senderId, 'v2');

    const relay = { type: 'relay:h264', targetId: 'v3', payload: { d: 'abc', seq: 1 } };
    const out2 = coreMessage(core, 'v1', relay);
    assert.equal(out2.length, 1);
    assert.equal(out2[0].to, 'v3');
    // 転送は無改変 (署名パススルーの原則)
    assert.deepEqual((out2[0].data as { payload: unknown }).payload, relay.payload);

    // 未所属のクライアント宛 → 拒否
    coreAck(core, 'lone');
    const out3 = coreMessage(core, 'host', { type: 'peer:offer', targetId: 'lone', payload: {} });
    assert.equal(out3.length, 1);
    assert.equal((out3[0].data as { type: string; payload: { code: string } }).type, 'error');
    assert.equal((out3[0].data as { payload: { code: string } }).payload.code, 'PARTICIPANT_UNKNOWN');
});

test('leave/切断: peer:leftが全メンバーへ届く', () => {
    const core = newCore();
    coreAck(core, 'host');
    coreMessage(core, 'host', { type: 'room:create', payload: {} });
    coreAck(core, 'v1');
    join(core, 'v1');

    const outs = coreDisconnect(core, 'v1');
    const left = outs.find(o => (o.data as { type: string }).type === 'peer:left');
    assert.ok(left);
    assert.equal((left.data as { payload: { peerId: string } }).payload.peerId, 'v1');
    // 二回目の切断は無視
    assert.equal(coreDisconnect(core, 'v1').length, 0);
});

test('未知のタイプはUNKNOWN_TYPEエラー', () => {
    const core = newCore();
    coreAck(core, 'c1');
    const outs = coreMessage(core, 'c1', { type: 'totally:unknown' });
    assert.equal((outs[0].data as { payload: { code: string } }).payload.code, 'UNKNOWN_TYPE');
});

// === issue#9/#10: hostToken認可モデル ===

test('issue#9: claim済みルームへの無認可createは拒否され、部屋の状態も変わらない', () => {
    const core = newCore();
    coreAck(core, 'host');
    const created = coreMessage(core, 'host', {
        type: 'room:create', payload: { name: 'Host', hostEndpoint: '192.168.1.5:8090' },
    });
    const token = (created[0].data as { payload: { hostToken?: string } }).payload.hostToken;
    assert.ok(token, '初回createにはhostTokenが発行される');

    // token無し/不一致のcreateはUNAUTHORIZED (メンバーにも電話帳にも載らない)
    for (const payload of [
        { name: 'Attacker' },
        { name: 'Attacker', hostEndpoint: 'evil.example:1234' },
        { name: 'Attacker', hostToken: 'wrong' },
    ]) {
        coreAck(core, 'attacker');
        const outs = coreMessage(core, 'attacker', { type: 'room:create', payload });
        assert.equal((outs[0].data as { type: string; payload: { code?: string } }).payload.code, 'UNAUTHORIZED');
    }
    assert.equal(core.members.size, 1);
    assert.equal(core.hostEndpoint, '192.168.1.5:8090');
    assert.equal(core.hostId, 'host');
});

test('issue#9: 正しいhostTokenでのcreateは再権限 (hostId更新+電話帳更新+room:host配布)', () => {
    const core = newCore();
    coreAck(core, 'host1');
    const created = coreMessage(core, 'host1', { type: 'room:create', payload: { hostEndpoint: 'h1:1' } });
    const token = (created[0].data as { payload: { hostToken?: string } }).payload.hostToken!;
    coreAck(core, 'g1');
    coreMessage(core, 'g1', { type: 'room:join', payload: {} });
    coreDisconnect(core, 'host1');

    // ホストが再接続 (別ID) してtokenを提示 → 在席のg1へroom:hostが配られる
    coreAck(core, 'host2');
    const outs = coreMessage(core, 'host2', {
        type: 'room:create', payload: { hostToken: token, hostEndpoint: 'h2:2' },
    });
    const toG1 = outs.filter(o => o.to === 'g1').map(o => (o.data as { type: string }).type);
    assert.deepEqual(toG1, ['room:host', 'peer:joined']);
    const hostMsg = outs.find(o => o.to === 'g1' && (o.data as { type: string }).type === 'room:host');
    assert.equal((hostMsg!.data as { payload: { hostId?: string } }).payload.hostId, 'host2');
    assert.equal(core.hostId, 'host2');
    assert.equal(core.hostEndpoint, 'h2:2', 'ホストだけが電話帳を更新できる');
});

test('issue#10: joinはhostEndpointを書き換えられない', () => {
    const core = newCore();
    coreAck(core, 'host');
    coreMessage(core, 'host', { type: 'room:create', payload: { hostEndpoint: '192.168.1.5:8090' } });
    coreAck(core, 'guest');
    coreMessage(core, 'guest', {
        type: 'room:join', payload: { roomCode: 'TEST12', hostEndpoint: 'evil.example:1234' },
    });
    assert.equal(core.hostEndpoint, '192.168.1.5:8090');
});

test('issue#9: reclaimしたホストは満員でも復帰できる', () => {
    const core = newCore(2);
    coreAck(core, 'host1');
    const created = coreMessage(core, 'host1', { type: 'room:create', payload: {} });
    const token = (created[0].data as { payload: { hostToken?: string } }).payload.hostToken!;
    coreMessage(core, 'g1', { type: 'room:join', payload: {} });
    coreDisconnect(core, 'host1');
    // ホスト不在のまま2人目の招待者を入れて満員にする
    coreMessage(core, 'g2', { type: 'room:join', payload: {} });

    coreAck(core, 'host2');
    const outs = coreMessage(core, 'host2', { type: 'room:create', payload: { hostToken: token } });
    assert.ok(outs.some(o => o.to === 'host2' && (o.data as { type: string }).type === 'room:joined'));
    assert.equal(core.members.size, 3, '上限2でもホストの復帰は阻害しない');
});

test('issue#10: room:joined / room:created にhostIdが載る', () => {
    const core = newCore();
    coreAck(core, 'host');
    const created = coreMessage(core, 'host', { type: 'room:create', payload: {} });
    assert.equal((created[1].data as { payload: { hostId?: string } }).payload.hostId, 'host');
    coreAck(core, 'guest');
    const joined = coreMessage(core, 'guest', { type: 'room:join', payload: {} });
    assert.equal((joined[0].data as { payload: { hostId?: string } }).payload.hostId, 'host');
});
