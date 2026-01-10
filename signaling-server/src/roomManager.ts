/**
 * P2D シグナリングサーバー - ルーム管理
 */

import type { Room, ViewerInfo } from './types.js';

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

    // ルームのタイムアウト（5分）
    private readonly ROOM_TIMEOUT_MS = 5 * 60 * 1000;

    constructor() {
        // 定期的に期限切れルームをクリーンアップ
        setInterval(() => this.cleanupExpiredRooms(), 60 * 1000);
    }

    /**
     * 新しいルームを作成
     */
    createRoom(hostId: string, hostName?: string): Room {
        // 一意なルームコードを生成
        let code: string;
        do {
            code = generateRoomCode();
        } while (this.codeToId.has(code));

        const roomId = crypto.randomUUID();

        const room: Room = {
            id: roomId,
            code,
            hostId,
            hostName,
            viewers: new Map(),
            createdAt: Date.now(),
        };

        this.rooms.set(roomId, room);
        this.codeToId.set(code, roomId);
        this.clientToRoom.set(hostId, roomId);

        console.log(`[RoomManager] ルーム作成: ${code} (ID: ${roomId}), ホスト: ${hostId}`);

        return room;
    }

    /**
     * ルームコードでルームに参加
     */
    joinRoom(code: string, viewerId: string, viewerName?: string): Room | null {
        const roomId = this.codeToId.get(code.toUpperCase());
        if (!roomId) {
            console.log(`[RoomManager] ルーム未発見: ${code}`);
            return null;
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            return null;
        }

        // ビューアを追加
        const viewerInfo: ViewerInfo = {
            id: viewerId,
            name: viewerName,
            joinedAt: Date.now(),
        };
        room.viewers.set(viewerId, viewerInfo);
        this.clientToRoom.set(viewerId, roomId);

        console.log(`[RoomManager] ビューア参加: ${viewerId} -> ルーム ${code}`);

        return room;
    }

    /**
     * クライアントをルームから削除
     */
    leaveRoom(clientId: string): { room: Room; wasHost: boolean } | null {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) {
            return null;
        }

        const room = this.rooms.get(roomId);
        if (!room) {
            this.clientToRoom.delete(clientId);
            return null;
        }

        const wasHost = room.hostId === clientId;

        if (wasHost) {
            // ホストが退出した場合、ルームを削除
            console.log(`[RoomManager] ホスト退出、ルーム削除: ${room.code}`);
            this.deleteRoom(roomId);
        } else {
            // ビューアが退出
            room.viewers.delete(clientId);
            this.clientToRoom.delete(clientId);
            console.log(`[RoomManager] ビューア退出: ${clientId}`);
        }

        return { room, wasHost };
    }

    /**
     * ルームを削除
     */
    private deleteRoom(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        // 全クライアントの参照を削除
        this.clientToRoom.delete(room.hostId);
        for (const [viewerId] of room.viewers) {
            this.clientToRoom.delete(viewerId);
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
            if (now - room.createdAt > this.ROOM_TIMEOUT_MS) {
                console.log(`[RoomManager] 期限切れルームを削除: ${room.code}`);
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
