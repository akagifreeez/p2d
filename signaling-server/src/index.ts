/**
 * P2D シグナリングサーバー - メインエントリー
 * 
 * WebSocketを使用してWebRTC接続のシグナリングを中継する。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './roomManager.js';
import type {
    SignalingMessage,
    RoomCreateMessage,
    RoomJoinMessage,
    OfferMessage,
    AnswerMessage,
    IceCandidateMessage,
} from './types.js';

// サーバー設定
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// クライアント管理
const clients = new Map<string, WebSocket>();
const roomManager = new RoomManager();

// WebSocketサーバー作成
const wss = new WebSocketServer({
    port: PORT,
    host: HOST,
});

console.log(`🚀 P2D シグナリングサーバー起動: ws://${HOST}:${PORT}`);

// クライアント接続時
wss.on('connection', (ws: WebSocket) => {
    const clientId = crypto.randomUUID();
    clients.set(clientId, ws);

    console.log(`[Server] クライアント接続: ${clientId}`);

    // メッセージ受信時
    ws.on('message', (data: Buffer) => {
        try {
            const message = JSON.parse(data.toString()) as SignalingMessage;
            handleMessage(clientId, message);
        } catch (error) {
            console.error(`[Server] メッセージパースエラー:`, error);
            sendError(ws, 'PARSE_ERROR', 'メッセージの解析に失敗しました');
        }
    });

    // 接続終了時
    ws.on('close', () => {
        console.log(`[Server] クライアント切断: ${clientId}`);
        handleDisconnect(clientId);
        clients.delete(clientId);
    });

    // エラー時
    ws.on('error', (error) => {
        console.error(`[Server] WebSocketエラー (${clientId}):`, error);
    });

    // 接続確認メッセージを送信
    sendMessage(ws, {
        type: 'room:joined', // 接続確認用に再利用
        timestamp: Date.now(),
        payload: {
            roomId: '',
            hostId: '',
            peers: [],
        },
    });
});

/**
 * メッセージハンドラ
 */
function handleMessage(clientId: string, message: SignalingMessage): void {
    const ws = clients.get(clientId);
    if (!ws) return;

    console.log(`[Server] メッセージ受信 (${clientId}): ${message.type}`);

    switch (message.type) {
        case 'room:create':
            handleRoomCreate(clientId, ws, message as RoomCreateMessage);
            break;

        case 'room:join':
            handleRoomJoin(clientId, ws, message as RoomJoinMessage);
            break;

        case 'room:leave':
            handleRoomLeave(clientId);
            break;

        case 'peer:offer':
            handleOffer(clientId, message as OfferMessage);
            break;

        case 'peer:answer':
            handleAnswer(clientId, message as AnswerMessage);
            break;

        case 'peer:ice':
            handleIceCandidate(clientId, message as IceCandidateMessage);
            break;

        default:
            sendError(ws, 'UNKNOWN_TYPE', `不明なメッセージタイプ: ${message.type}`);
    }
}

/**
 * ルーム作成ハンドラ
 */
function handleRoomCreate(clientId: string, ws: WebSocket, message: RoomCreateMessage): void {
    const hostName = message.payload?.hostName;
    const room = roomManager.createRoom(clientId, hostName);

    sendMessage(ws, {
        type: 'room:created',
        roomId: room.id,
        senderId: clientId,
        timestamp: Date.now(),
        payload: {
            roomCode: room.code,
        },
    });
}

/**
 * ルーム参加ハンドラ
 */
function handleRoomJoin(clientId: string, ws: WebSocket, message: RoomJoinMessage): void {
    const roomCode = message.payload?.roomCode;
    if (!roomCode) {
        sendError(ws, 'INVALID_CODE', 'ルームコードが指定されていません');
        return;
    }

    const viewerName = message.payload?.viewerName;
    const room = roomManager.joinRoom(roomCode, clientId, viewerName);

    if (!room) {
        sendError(ws, 'ROOM_NOT_FOUND', 'ルームが見つかりません');
        return;
    }

    // 参加者に通知
    sendMessage(ws, {
        type: 'room:joined',
        roomId: room.id,
        senderId: clientId,
        timestamp: Date.now(),
        payload: {
            roomId: room.id,
            hostId: room.hostId,
            peers: [room.hostId, ...Array.from(room.viewers.keys())],
        },
    });

    // ホストに新しいビューアを通知
    const hostWs = clients.get(room.hostId);
    if (hostWs) {
        sendMessage(hostWs, {
            type: 'peer:joined',
            roomId: room.id,
            senderId: clientId,
            timestamp: Date.now(),
            payload: {
                peerId: clientId,
                peerName: viewerName,
            },
        });
    }
}

/**
 * ルーム退出ハンドラ
 */
function handleRoomLeave(clientId: string): void {
    const result = roomManager.leaveRoom(clientId);
    if (!result) return;

    const { room, wasHost } = result;

    if (wasHost) {
        // 全ビューアに通知
        for (const [viewerId] of room.viewers) {
            const viewerWs = clients.get(viewerId);
            if (viewerWs) {
                sendMessage(viewerWs, {
                    type: 'peer:left',
                    roomId: room.id,
                    senderId: room.hostId,
                    timestamp: Date.now(),
                    payload: {
                        peerId: room.hostId,
                    },
                });
            }
        }
    } else {
        // ホストと他のビューアに通知
        const hostWs = clients.get(room.hostId);
        if (hostWs) {
            sendMessage(hostWs, {
                type: 'peer:left',
                roomId: room.id,
                senderId: clientId,
                timestamp: Date.now(),
                payload: {
                    peerId: clientId,
                },
            });
        }
    }
}

/**
 * SDP Offerハンドラ
 */
function handleOffer(clientId: string, message: OfferMessage): void {
    const targetId = message.targetId;
    if (!targetId) {
        console.error(`[Server] Offer: targetIdがありません`);
        return;
    }

    const targetWs = clients.get(targetId);
    if (targetWs) {
        sendMessage(targetWs, {
            ...message,
            senderId: clientId,
            timestamp: Date.now(),
        });
    }
}

/**
 * SDP Answerハンドラ
 */
function handleAnswer(clientId: string, message: AnswerMessage): void {
    const targetId = message.targetId;
    if (!targetId) {
        console.error(`[Server] Answer: targetIdがありません`);
        return;
    }

    const targetWs = clients.get(targetId);
    if (targetWs) {
        sendMessage(targetWs, {
            ...message,
            senderId: clientId,
            timestamp: Date.now(),
        });
    }
}

/**
 * ICE候補ハンドラ
 */
function handleIceCandidate(clientId: string, message: IceCandidateMessage): void {
    const targetId = message.targetId;
    if (!targetId) {
        console.error(`[Server] ICE: targetIdがありません`);
        return;
    }

    const targetWs = clients.get(targetId);
    if (targetWs) {
        sendMessage(targetWs, {
            ...message,
            senderId: clientId,
            timestamp: Date.now(),
        });
    }
}

/**
 * クライアント切断ハンドラ
 */
function handleDisconnect(clientId: string): void {
    handleRoomLeave(clientId);
}

/**
 * メッセージ送信ユーティリティ
 */
function sendMessage(ws: WebSocket, message: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

/**
 * エラー送信ユーティリティ
 */
function sendError(ws: WebSocket, code: string, message: string): void {
    sendMessage(ws, {
        type: 'error',
        timestamp: Date.now(),
        payload: { code, message },
    });
}

// 定期的に統計を出力
setInterval(() => {
    const stats = roomManager.getStats();
    console.log(`[Server] 統計: ルーム数=${stats.roomCount}, クライアント数=${stats.clientCount}`);
}, 60 * 1000);

// グレースフルシャットダウン
process.on('SIGINT', () => {
    console.log('\n[Server] シャットダウン中...');
    wss.close(() => {
        console.log('[Server] サーバー停止完了');
        process.exit(0);
    });
});
