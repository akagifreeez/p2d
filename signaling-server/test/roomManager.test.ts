/**
 * RoomManager 単体テスト (監査#4 幽霊参加者・監査#6 上限)
 * 実行: node --import tsx --test test/roomManager.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/roomManager.js';

test('createRoomは旧ルームから退室させる (幽霊参加者防止 #4)', () => {
    const rm = new RoomManager(8);
    const { room: roomA } = rm.createRoom('alice');
    rm.joinRoom(roomA.code, 'bob');

    // aliceが部屋Aに所属したまま新規作成 → 自動的にAから退室する
    const { room: roomB, oldRoom } = rm.createRoom('alice');
    assert.equal(oldRoom?.id, roomA.id);
    assert.equal(rm.getRoomByClientId('alice')?.id, roomB.id);

    // 部屋Aにはbobだけ残り、aliceの幽霊は残らない
    const a = rm.getRoomByCode(roomA.code);
    assert.ok(a);
    assert.equal(a.participants.size, 1);
    assert.ok(a.participants.has('bob'));
    assert.ok(!a.participants.has('alice'));

    // aliceが切断 → 移動先だけが掃除され、Aの状態は壊れない
    rm.leaveRoom('alice');
    assert.equal(rm.getRoomByClientId('alice'), null);
    assert.equal(rm.getRoomByCode(roomB.code), null); // 空になったので削除済み
    assert.equal(rm.getRoomByCode(roomA.code)?.participants.size, 1);
});

test('joinRoom移動時はoldRoomが返り、移動元の人数が減る (#4)', () => {
    const rm = new RoomManager(8);
    const { room: roomA } = rm.createRoom('a');
    rm.joinRoom(roomA.code, 'b');
    const { room: roomB } = rm.createRoom('c');

    const r = rm.joinRoom(roomB.code, 'b');
    assert.ok(r.ok);
    if (r.ok) {
        assert.equal(r.room.id, roomB.id);
        assert.equal(r.oldRoom?.id, roomA.id);
    }
    assert.equal(rm.getRoomByCode(roomA.code)?.participants.size, 1); // a のみ
    assert.equal(rm.getRoomByCode(roomB.code)?.participants.size, 2); // c + b
});

test('joinRoom失敗時 (NOT_FOUND) は現在の所属を変更しない (#4)', () => {
    const rm = new RoomManager(8);
    const { room } = rm.createRoom('alice');

    const r = rm.joinRoom('ZZZZ99', 'alice');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'NOT_FOUND');
    assert.equal(rm.getRoomByClientId('alice')?.id, room.id);
});

test('満室ルームはFULLで拒否され、移動元の所属も壊れない (#6)', () => {
    const rm = new RoomManager(2);
    const { room: full } = rm.createRoom('a');
    rm.joinRoom(full.code, 'b');
    assert.equal(full.participants.size, 2);

    // cは別ルームに所属した状態で満室部屋へ移動しようとする
    const { room: other } = rm.createRoom('c');
    const r = rm.joinRoom(full.code, 'c');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'FULL');
    assert.equal(rm.getRoomByClientId('c')?.id, other.id);
    assert.equal(full.participants.size, 2); // 増えていない
});

test('同一ルームへの再参加はno-op (oldRoom=null, 誤退室しない) (#4)', () => {
    const rm = new RoomManager(8);
    const { room } = rm.createRoom('a');
    rm.joinRoom(room.code, 'b');

    const r = rm.joinRoom(room.code, 'b');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.oldRoom, null);
    assert.equal(room.participants.size, 2);
});

test('不正なP2D_MAX_PARTICIPANTSは起動時に弾く (#6)', () => {
    const prev = process.env.P2D_MAX_PARTICIPANTS;
    process.env.P2D_MAX_PARTICIPANTS = 'abc';
    try {
        assert.throws(() => new RoomManager());
    } finally {
        if (prev === undefined) delete process.env.P2D_MAX_PARTICIPANTS;
        else process.env.P2D_MAX_PARTICIPANTS = prev;
    }
});

// === issue#9/#10: ホスト再権限 (hostToken) の認可モデル ===

test('reclaimRoom: 正しいhostTokenでのみホスト再権限が成立する (#9)', () => {
    const rm = new RoomManager(8);
    const { room } = rm.createRoom('host1', 'Host', 'ABC123', '10.0.0.1:8090');
    rm.joinRoom(room.code, 'guest1');

    // トークン無し/不一致は拒否され、所属も部屋の状態も変わらない
    assert.equal(rm.reclaimRoom(room.code, 'attacker').ok, false);
    assert.equal(rm.reclaimRoom(room.code, 'attacker', 'A', 'wrong-token').ok, false);
    assert.equal(rm.getRoomByClientId('attacker'), null);
    assert.equal(room.participants.has('attacker'), false);
    assert.equal(room.hostEndpoint, '10.0.0.1:8090');
    assert.equal(room.hostId, 'host1');

    // 正しいトークンなら復帰 + hostEndpoint更新 + hostId付け替え
    const r = rm.reclaimRoom(room.code, 'host2', 'Host2', room.hostToken, '10.0.0.9:8090');
    assert.ok(r.ok);
    assert.equal(room.participants.has('host2'), true);
    assert.equal(room.hostId, 'host2');
    assert.equal(room.hostEndpoint, '10.0.0.9:8090');
});

test('reclaimRoom: 満員でもホストは復帰できる (招待者で締め出されない) (#9)', () => {
    const rm = new RoomManager(2);
    const { room } = rm.createRoom('host1', 'Host');
    rm.joinRoom(room.code, 'g1');
    assert.equal(room.participants.size, 2);

    const r = rm.reclaimRoom(room.code, 'host2', 'Host2', room.hostToken);
    assert.ok(r.ok);
    assert.equal(room.participants.size, 3);
    assert.equal(room.hostId, 'host2');
});

test('reclaimRoom: 古い所属ルームからは退出扱い (oldRoom通知用) (#4)', () => {
    const rm = new RoomManager(8);
    const { room: home } = rm.createRoom('host1', 'Host', 'AAA111');
    rm.joinRoom(home.code, 'g1');
    const { room: other } = rm.createRoom('wanderer', 'W', 'BBB222');
    rm.joinRoom(other.code, 'helper');

    const r = rm.reclaimRoom(home.code, 'wanderer', 'W', home.hostToken);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.oldRoom?.id, other.id);
    assert.equal(other.participants.size, 1, 'helperのみ残る');
});

test('createRoom: hostToken/hostIdが発行され、コード指定でも既存と衝突しない (#9)', () => {
    const rm = new RoomManager(8);
    const { room: r1 } = rm.createRoom('a', 'A', 'ABC123');
    assert.ok(r1.hostToken);
    assert.equal(r1.hostId, 'a');

    // 同じコードでのcreateRoom直接呼び出しは新コード生成にフォールバック
    // (index.tsのhandleRoomCreateが既存コードをreclaimへ迂回させるため通常起きない)
    const { room: r2 } = rm.createRoom('b', 'B', 'ABC123');
    assert.notEqual(r2.code, r1.code);
});
