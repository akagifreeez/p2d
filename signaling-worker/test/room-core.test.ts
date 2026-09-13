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
