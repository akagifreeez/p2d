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

    constructor() {
        // 定期的に期限切れルームをクリーンアップ
        setInterval(() => this.cleanupExpiredRooms(), 60 * 1000);
    }

    /**
     * 新しいルームを作成
     */
    createRoom(creatorId: string, creatorName?: string): Room {
        // 一意なルームコードを生成
        let code: string;
        do {
            code = generateRoomCode();
        } while (this.codeToId.has(code));

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
        };

        this.rooms.set(roomId, room);
        this.codeToId.set(code, roomId);
        this.clientToRoom.set(creatorId, roomId);

        console.log(`[RoomManager] ルーム作成: ${code} (ID: ${roomId}), 作成者: ${creatorId}`);

        return room;
    }

    /**
     * ルームコードでルームに参加
     */
    joinRoom(code: string, clientId: string, clientName?: string): Room | null {
        const roomId = this.codeToId.get(code.toUpperCase());
        if (!roomId) {
            console.log(`[RoomManager] ルーム未発見: ${code}`);
            return null;
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            return null;
        }

        // 既に参加済みの場合は更新だけ（ID重複対策）
        if (room.participants.has(clientId)) {
            console.warn(`[RoomManager] クライアント ${clientId} は既にルームに参加しています`);
            return room;
        }

        // 参加者を追加
        const info: ParticipantInfo = {
            id: clientId,
            name: clientName,
            joinedAt: Date.now(),
        };
        room.participants.set(clientId, info);
        this.clientToRoom.set(clientId, roomId);

        console.log(`[RoomManager] 参加: ${clientId} -> ルーム ${code}, 現在人数: ${room.participants.size}`);

        return room;
    }

    /**
     * クライアントをルームから削除
     */
    leaveRoom(clientId: string): { room: Room | null } {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) {
            return { room: null };
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            this.clientToRoom.delete(clientId); // 整合性のため削除
            return { room: null };
        }

        // 参加者を削除
        room.participants.delete(clientId);
        this.clientToRoom.delete(clientId);
        console.log(`[RoomManager] 退出: ${clientId} from ${room.code}, 残り人数: ${room.participants.size}`);

        // ルームが空になったら削除
        if (room.participants.size === 0) {
            console.log(`[RoomManager] ルームが空になったため削除: ${room.code}`);
            this.deleteRoom(roomId);
            return { room: null }; // ルーム削除済み
        }

        return { room };
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
