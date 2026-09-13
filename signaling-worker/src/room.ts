/**
 * P2D Cloudflare Workers シグナリング — 部屋DO (1ルーム=1インスタンス)
 */

import {
    createRoomCore, coreAck, coreDisconnect, coreMessage,
    type OutMessage, type RoomCoreState,
} from './room-core';

export class RoomDurableObject {
    private readonly state: DurableObjectState;
    private readonly core: RoomCoreState;
    private readonly sockets: Map<string, WebSocket> = new Map();

    constructor(state: DurableObjectState, env: { MAX_PARTICIPANTS?: string }) {
        this.state = state;
        // DO名 = ルームコード (index.ts の idFromName で付与)
        const code = state.id.name || 'ROOM';
        const max = Number(env?.MAX_PARTICIPANTS ?? '8');
        this.core = createRoomCore(code, Number.isFinite(max) && max > 0 ? max : 8);
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('websocket required', { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();

        const myId = crypto.randomUUID();
        this.sockets.set(myId, server);

        // 接続確認 (ダミーroom:joined, myId付与)
        this.emit([coreAck(this.core, myId)]);

        server.addEventListener('message', (ev) => {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(String(ev.data));
            } catch {
                this.send(myId, {
                    type: 'error',
                    timestamp: Date.now(),
                    payload: { code: 'PARSE_ERROR', message: 'メッセージの解析に失敗しました' },
                });
                return;
            }
            this.emit(coreMessage(this.core, myId, parsed as unknown as Parameters<typeof coreMessage>[2]));
        });

        server.addEventListener('close', () => {
            this.sockets.delete(myId);
            this.emit(coreDisconnect(this.core, myId));
        });

        server.addEventListener('error', () => {
            this.sockets.delete(myId);
            this.emit(coreDisconnect(this.core, myId));
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    private emit(outs: OutMessage[]): void {
        for (const out of outs) {
            if (out.to === null) {
                // メンバー全員 (部屋にいる接続のみ)
                for (const id of this.core.members.keys()) {
                    this.send(id, out.data);
                }
            } else {
                this.send(out.to, out.data);
            }
        }
    }

    private send(to: string, data: unknown): void {
        const ws = this.sockets.get(to);
        if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
            ws.send(JSON.stringify(data));
        }
    }
}
