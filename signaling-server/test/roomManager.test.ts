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
