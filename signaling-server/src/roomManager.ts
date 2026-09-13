/**
 * P2D シグナリングサーバー - ルーム管理 (Full Mesh P2P Update)
 */

import type { Room, ParticipantInfo } from './types.js';

// 6桁のルームコードを生成
function generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// joinRoomの結果 (NOT_FOUND / FULL は現在の所属を変更しない)
export type JoinRoomResult =
    | { ok: true; room: Room; oldRoom: Room | null }
    | { ok: false; reason: 'NOT_FOUND' | 'FULL' };

// ルーム管理クラス
export class RoomManager {
    // ルームID -> ルーム情報
    private rooms: Map<string, Room> = new Map();
    // ルームコード -> ルームID
    private codeToId: Map<string, string> = new Map();
    // クライアントID -> ルームID
    private clientToRoom: Map<string, string> = new Map();

    // ルームのタイムアウト（5分）- 誰もいないルームが放置された場合の安全策
    private readonly ROOM_TIMEOUT_MS = 5 * 60 * 1000;

    // 1ルームの参加者上限 (監査#6: Full Meshの帯域・接続数暴走をサーバー側で拒否)
    private readonly maxParticipants: number;

    constructor(maxParticipants?: number) {
        this.maxParticipants = maxParticipants ??
            parseInt(process.env.P2D_MAX_PARTICIPANTS || '8', 10);
        if (!Number.isFinite(this.maxParticipants) || this.maxParticipants < 1) {
            throw new Error(`P2D_MAX_PARTICIPANTS が不正です: ${process.env.P2D_MAX_PARTICIPANTS}`);
        }
        // 定期的に期限切れルームをクリーンアップ (サーバー本体はWSで生き続けるためunrefでよい)
        setInterval(() => this.cleanupExpiredRooms(), 60 * 1000).unref?.();
    }

    /**
     * 新しいルームを作成
     * 監査#4: 既存ルーム所属がある場合は必ず先に退室させる (幽霊参加者防止)
     * 戻り値の oldRoom は退室後の移動元ルーム (呼び出し元が peer:left を通知するのに使う。
     * 空になって削除された場合は null)
     */
    createRoom(
        creatorId: string,
        creatorName?: string,
        requestedCode?: string,
        hostEndpoint?: string,
    ): { room: Room; oldRoom: Room | null } {
        const oldRoom = this.removeFromCurrentRoom(creatorId).room;

        // ルームコード: 指定があればそれを使う (レンデブー最小化 M2/M4:
        // ホストがローカル生成したコードとサーバー登録を一致させる)。
        // 指定コードが既に使われていた場合は新規生成にフォールバック
        let code: string;
        if (requestedCode && /^[A-Z0-9]{4,8}$/.test(requestedCode) && !this.codeToId.has(requestedCode)) {
            code = requestedCode;
        } else {
            do {
                code = generateRoomCode();
            } while (this.codeToId.has(code));
        }

        const roomId = crypto.randomUUID();

        // 最初の参加者（作成者）を作成
        const creator: ParticipantInfo = {
            id: creatorId,
            name: creatorName,
            joinedAt: Date.now()
        };

        const room: Room = {
            id: roomId,
            code,
            participants: new Map([[creatorId, creator]]),
            createdAt: Date.now(),
            hostEndpoint,
        };

        this.rooms.set(roomId, room);
        this.codeToId.set(code, roomId);
        this.clientToRoom.set(creatorId, roomId);

        console.log(`[RoomManager] ルーム作成: ${code} (ID: ${roomId}), 作成者: ${creatorId}`);

        return { room, oldRoom };
    }

    /**
     * ルームコードでルームに参加
     * 監査#4: 失敗時 (NOT_FOUND/FULL) は現在の所属を一切変更しない原子的操作。
     * 成功時は移動元があれば先に退室させてから参加する。
     */
    joinRoom(code: string, clientId: string, clientName?: string): JoinRoomResult {
        const roomId = this.codeToId.get(code.toUpperCase());
        const room = roomId ? this.rooms.get(roomId) : undefined;
        if (!room) {
            console.log(`[RoomManager] ルーム未発見: ${code}`);
            return { ok: false, reason: 'NOT_FOUND' };
        }

        // 既に参加済みの場合は何もしない (ID重複対策・peer:left誤通知も起こさない)
        if (room.participants.has(clientId)) {
            console.warn(`[RoomManager] クライアント ${clientId} は既にルームに参加しています`);
            return { ok: true, room, oldRoom: null };
        }

        // 上限チェックは退室の前に行う (失敗時に元の所属を壊さない)
        if (room.participants.size >= this.maxParticipants) {
            console.warn(`[RoomManager] ルーム ${room.code} は満員です (${this.maxParticipants}人)`);
            return { ok: false, reason: 'FULL' };
        }

        // 別のルームに所属していた場合は退室させてから参加 (監査#4)
        const oldRoom = this.removeFromCurrentRoom(clientId).room;

        const info: ParticipantInfo = {
            id: clientId,
            name: clientName,
            joinedAt: Date.now(),
        };
        room.participants.set(clientId, info);
        this.clientToRoom.set(clientId, room.id);

        console.log(`[RoomManager] 参加: ${clientId} -> ルーム ${room.code}, 現在人数: ${room.participants.size}`);

        return { ok: true, room, oldRoom };
    }

    /**
     * クライアントをルームから削除
     */
    leaveRoom(clientId: string): { room: Room | null } {
        return { room: this.removeFromCurrentRoom(clientId).room };
    }

    /**
     * クライアントの現在のルーム所属を解除する共通処理
     * 戻り値の room は参加者削除後のルーム (空になって削除された場合は null)
     */
    private removeFromCurrentRoom(clientId: string): { room: Room | null; info: ParticipantInfo | null } {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) {
            return { room: null, info: null };
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            this.clientToRoom.delete(clientId); // 整合性のため削除
            return { room: null, info: null };
        }

        const info = room.participants.get(clientId) ?? null;

        // 参加者を削除
        room.participants.delete(clientId);
        this.clientToRoom.delete(clientId);
        console.log(`[RoomManager] 退出: ${clientId} from ${room.code}, 残り人数: ${room.participants.size}`);

        // ルームが空になったら削除
        if (room.participants.size === 0) {
            console.log(`[RoomManager] ルームが空になったため削除: ${room.code}`);
            this.deleteRoom(roomId);
            return { room: null, info };
        }

        return { room, info };
    }

    /**
     * ルームを削除
     */
    private deleteRoom(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        // 全クライアントの参照を削除（念の為）
        for (const [id] of room.participants) {
            this.clientToRoom.delete(id);
        }

        this.codeToId.delete(room.code);
        this.rooms.delete(roomId);
    }

    /**
     * クライアントIDからルームを取得
     */
    getRoomByClientId(clientId: string): Room | null {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        return this.rooms.get(roomId) || null;
    }

    /**
     * ルームコードからルームを取得
     */
    getRoomByCode(code: string): Room | null {
        const roomId = this.codeToId.get(code.toUpperCase());
        if (!roomId) return null;
        return this.rooms.get(roomId) || null;
    }

    /**
     * 期限切れルームをクリーンアップ
     */
    private cleanupExpiredRooms(): void {
        const now = Date.now();
        for (const [roomId, room] of this.rooms) {
            // 作成から時間が経っており、かつ誰もいない場合は削除
            // (通常leaveRoomで消えるが、サーバー再起動後などのゴミ掃除)
            if (room.participants.size === 0 && now - room.createdAt > this.ROOM_TIMEOUT_MS) {
                console.log(`[RoomManager] 期限切れ空ルームを削除: ${room.code}`);
                this.deleteRoom(roomId);
            }
        }
    }

    /**
     * 統計情報を取得
     */
    getStats(): { roomCount: number; clientCount: number } {
        return {
            roomCount: this.rooms.size,
            clientCount: this.clientToRoom.size,
        };
    }
}
