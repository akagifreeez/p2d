/**
 * P2D Cloudflare Workers シグナリング — Durable Object (1ルーム=1インスタンス)
 *
 * URLの ?room=<コード> でDOが特定され、同じ部屋の全員がこのDO上の
 * WebSocketに集約される。部屋状態はこのクラスのインスタンスフィールド
 * (接続が開いている間はDOが稼働し続けることが保証される)。
 */

import { RoomDurableObject } from './room';

export { RoomDurableObject };

export interface Env {
    ROOM: DurableObjectNamespace;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return new Response('ok');
        }

        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            const code = (url.searchParams.get('room') ?? '').toUpperCase();
            if (!/^[A-Z0-9]{4,8}$/.test(code)) {
                return new Response('room code required (?room=XXXXXX)', { status: 400 });
            }
            const id = env.ROOM.idFromName(code);
            return env.ROOM.get(id).fetch(request);
        }

        return new Response('P2D signaling worker (WebSocket endpoint: /?room=XXXXXX)', {
            status: 200,
        });
    },
};
