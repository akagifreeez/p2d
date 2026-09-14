/**
 * P2D シグナリングサーバー - メインエントリー (Full Mesh P2P Update)
 * 
 * WebSocketを使用してWebRTC接続のシグナリングを中継する。
 */

import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import https from 'node:https';
import { RoomManager } from './roomManager.js';
import type {
    SignalingMessage,
    RoomCreateMessage,
    RoomJoinMessage,
    OfferMessage,
    AnswerMessage,
    IceCandidateMessage,
    ParticipantInfo,
    Room,
} from './types.js';

// サーバー設定
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
// issue#3: ネイティブTLS (Caddy等のリバースプロキシを使わない構成用)。
// 両方の環境変数が揃ったら https サーバーの上で WebSocket を受け、wss:// になる
const TLS_CERT = process.env.P2D_TLS_CERT || '';
const TLS_KEY = process.env.P2D_TLS_KEY || '';
const useTls = !!(TLS_CERT && TLS_KEY);

// クライアント管理
const clients = new Map<string, WebSocket>();
const roomManager = new RoomManager();

// WebSocketサーバー作成
// issue#3: P2D_TLS_CERT / P2D_TLS_KEY が揃ったら https の上で WebSocket を受け、
// wss:// になる (リバースプロキシなしでTLSを終端する構成用)。
// 未設定なら従来どおり ws:// で listen (LAN用・Caddyで終端する構成でもwsのまま)
const wsOptions = { maxPayload: 4 * 1024 * 1024 } as const;

const wss: WebSocketServer = useTls
    ? (() => {
        const server = https.createServer({
            cert: fs.readFileSync(TLS_CERT),
            key: fs.readFileSync(TLS_KEY),
        });
        const w = new WebSocketServer({ ...wsOptions, server });
        server.listen(PORT, HOST);
        return w;
    })()
    : new WebSocketServer({ ...wsOptions, port: PORT, host: HOST });

console.log(`🚀 P2D シグナリングサーバー起動: ${useTls ? 'wss' : 'ws'}://${HOST}:${PORT}${useTls ? ' (TLS: P2D_TLS_CERT/P2D_TLS_KEY)' : ''}`);

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
        type: 'room:joined', // 接続確認用に再利用(ダミー)
        timestamp: Date.now(),
        payload: {
            roomId: '',
            roomCode: '',
            myId: clientId,
            participants: [],
        },
    });
});

/**
 * メッセージハンドラ
 */
function handleMessage(clientId: string, message: SignalingMessage): void {
    const ws = clients.get(clientId);
    if (!ws) return;

    if (message.type !== 'peer:ice' && message.type !== 'relay:frame') { // ICEとフレームは大量に来るのでログ除外
        console.log(`[Server] メッセージ受信 (${clientId}): ${message.type}`);
    }

    switch (message.type) {
        case 'room:create':
            handleRoomCreate(clientId, ws, message as RoomCreateMessage);
            break;

        case 'peer:tunnel':
            handleTunnelForward(clientId, message);
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

        default: {
            // WSリレー: relay:* は targetId 宛てにそのまま転送
            if (message.type.startsWith('relay:')) {
                handleRelayForward(clientId, message);
                break;
            }
            sendError(ws, 'UNKNOWN_TYPE', `不明なメッセージタイプ: ${message.type}`);
        }
    }
}

/**
 * ルーム移動時: 移動元ルームの残存参加者に退出を通知する (監査#4)
 * oldRoom は当該クライアント削除済みのルーム。空で削除済みなら null (通知不要)。
 */
function notifyOldRoomLeft(oldRoom: Room | null, leftClientId: string): void {
    if (!oldRoom) return;
    oldRoom.participants.forEach((_, peerId) => {
        const peerWs = clients.get(peerId);
        if (peerWs) {
            sendMessage(peerWs, {
                type: 'peer:left',
                roomId: oldRoom.id,
                senderId: leftClientId,
                timestamp: Date.now(),
                payload: {
                    peerId: leftClientId,
                },
            });
        }
    });
}

/**
 * 送信者と宛先が同一ルームに所属しているか検証する (監査#1 部屋外中継対策)
 * 退出後もclient IDを知っている攻撃者が部屋外からOffer等を送れないようにする。
 */
function canForward(senderId: string, targetId: string): boolean {
    const senderRoom = roomManager.getRoomByClientId(senderId);
    const targetRoom = roomManager.getRoomByClientId(targetId);
    if (!senderRoom || !targetRoom || senderRoom.id !== targetRoom.id) {
        console.warn(`[Server] ルーム外中継を拒否: ${senderId} -> ${targetId}`);
        return false;
    }
    return true;
}

/**
 * ルーム作成ハンドラ
 * issue#9/#10: 既存ルームコードへの room:create は正しいhostTokenの保有者
 * (= ホスト) のみ受理。無認可のcreateは参加者にも電話帳にも載らない。
 */
function handleRoomCreate(clientId: string, ws: WebSocket, message: RoomCreateMessage): void {
    const name = message.payload?.name;
    const requestedCode = message.payload?.roomCode;
    const hostEndpoint = message.payload?.hostEndpoint;

    // 既存ルームへのcreate → ホスト再権限のみ
    if (requestedCode && roomManager.getRoomByCode(requestedCode)) {
        const result = roomManager.reclaimRoom(
            requestedCode, clientId, name, message.payload?.hostToken, hostEndpoint,
        );
        if (!result.ok) {
            sendError(ws, 'UNAUTHORIZED', 'このルームの作成者ではありません');
            return;
        }
        const { room, oldRoom } = result;
        notifyOldRoomLeft(oldRoom, clientId);
        broadcastHostChanged(room, clientId);

        sendMessage(ws, {
            type: 'room:created',
            roomId: room.id,
            senderId: clientId,
            timestamp: Date.now(),
            payload: {
                roomCode: room.code,
                roomId: room.id,
                hostToken: room.hostToken,
                hostId: room.hostId,
            },
        });
        sendMessage(ws, {
            type: 'room:joined',
            roomId: room.id,
            senderId: clientId,
            timestamp: Date.now(),
            payload: {
                roomId: room.id,
                roomCode: room.code,
                myId: clientId,
                participants: participantListOf(room, clientId),
                hostEndpoint: room.hostEndpoint,
                hostId: room.hostId,
            },
        });
        return;
    }

    const { room, oldRoom } = roomManager.createRoom(
        clientId, name, requestedCode, hostEndpoint,
    );
    notifyOldRoomLeft(oldRoom, clientId);

    sendMessage(ws, {
        type: 'room:created',
        roomId: room.id,
        senderId: clientId,
        timestamp: Date.now(),
        payload: {
            roomCode: room.code,
            roomId: room.id,
            hostEndpoint: room.hostEndpoint,
            hostToken: room.hostToken,
            hostId: room.hostId,
        },
    });

    // 暗黙的にJoin済みとして扱うため、RoomJoinedを送る
    // (createRoom内部ですでにparticipantとして登録されている)
    sendMessage(ws, {
        type: 'room:joined',
        roomId: room.id,
        senderId: clientId,
        timestamp: Date.now(),
        payload: {
            roomId: room.id,
            roomCode: room.code,
            myId: clientId,
            participants: [], // 作成直後は自分だけなので空
            hostId: room.hostId,
        },
    });
}

/** ルームの参加者リスト (exceptIdを除く) */
function participantListOf(room: Room, exceptId: string): ParticipantInfo[] {
    const list: ParticipantInfo[] = [];
    room.participants.forEach((info, id) => {
        if (id !== exceptId) list.push(info);
    });
    return list;
}

/**
 * ホスト接続IDの変更をメンバーへ配布 (issue#10)。
 * クライアントは tree:*系・鍵配布の権威チェックにこのhostIdを使う。
 */
function broadcastHostChanged(room: Room, exceptHostId: string): void {
    room.participants.forEach((_, peerId) => {
        if (peerId === exceptHostId) return;
        const peerWs = clients.get(peerId);
        if (peerWs) {
            sendMessage(peerWs, {
                type: 'room:host',
                roomId: room.id,
                senderId: exceptHostId,
                timestamp: Date.now(),
                payload: { hostId: room.hostId },
            });
        }
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

    const name = message.payload?.name;
    const result = roomManager.joinRoom(roomCode, clientId, name);

    if (!result.ok) {
        if (result.reason === 'FULL') {
            sendError(ws, 'ROOM_FULL', 'ルームが満員です');
        } else {
            sendError(ws, 'ROOM_NOT_FOUND', 'ルームが見つかりません');
        }
        return;
    }
    const { room, oldRoom } = result;
    notifyOldRoomLeft(oldRoom, clientId);

    // 1. 新しい参加者に「既存の参加者リスト」を送る
    const participants = participantListOf(room, clientId);

    sendMessage(ws, {
        type: 'room:joined',
        roomId: room.id,
        senderId: clientId, // System
        timestamp: Date.now(),
        payload: {
            roomId: room.id,
            roomCode: room.code,
            myId: clientId,
            participants: participants,
            hostEndpoint: room.hostEndpoint,
            hostId: room.hostId,
        },
    });

    // 2. 既存の参加者全員に「新しい参加者」を通知
    room.participants.forEach((_, peerId) => {
        if (peerId !== clientId) {
            const peerWs = clients.get(peerId);
            if (peerWs) {
                sendMessage(peerWs, {
                    type: 'peer:joined',
                    roomId: room.id,
                    senderId: clientId,
                    timestamp: Date.now(),
                    payload: {
                        peerId: clientId,
                        name: name,
                    },
                });
            }
        }
    });
}

/**
 * ルーム退出ハンドラ
 */
function handleRoomLeave(clientId: string): void {
    const { room } = roomManager.leaveRoom(clientId);
    if (!room) return; // 既に削除されたか、参加していなかった

    // 残っている参加者全員に通知
    room.participants.forEach((_, peerId) => {
        const peerWs = clients.get(peerId);
        if (peerWs) {
            sendMessage(peerWs, {
                type: 'peer:left',
                roomId: room.id,
                senderId: clientId,
                timestamp: Date.now(),
                payload: {
                    peerId: clientId,
                },
            });
        }
    });
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
    if (!canForward(clientId, targetId)) return;

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
    if (!canForward(clientId, targetId)) return;

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
        // console.error(`[Server] ICE: targetIdがありません`);
        return;
    }
    if (!canForward(clientId, targetId)) return;

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
 * DC中継シグナリング転送ハンドラ (レンデブー最小化 M2)
 * 転送者と宛先の同一ルーム所属のみ検証する (中身はクライアント間の封筒)。
 * サーバー死亡後にピア経由でSDP/ICEを届けるための最小限の電話帳機能。
 */
function handleTunnelForward(clientId: string, message: SignalingMessage): void {
    const targetId = message.targetId;
    if (!targetId) return;
    if (!canForward(clientId, targetId)) return;

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
 * WSリレー転送ハンドラ (relay:* / WebRTC非対応エンジン向けフォールバック経路)
 */
function handleRelayForward(clientId: string, message: SignalingMessage): void {
    const targetId = message.targetId;
    if (!targetId) return;
    if (!canForward(clientId, targetId)) return;

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
