/**
 * P2D - シグナリングクライアント
 * 
 * WebSocketを使用してシグナリングサーバーと通信する。
 */

// メッセージタイプ（サーバーと同期）
export type MessageType =
    | 'room:create'
    | 'room:join'
    | 'room:leave'
    | 'room:created'
    | 'room:joined'
    | 'peer:joined'
    | 'peer:left'
    | 'peer:offer'
    | 'peer:answer'
    | 'peer:ice'
    | 'error';

export interface SignalingMessage {
    type: MessageType;
    roomId?: string;
    senderId?: string;
    targetId?: string;
    timestamp: number;
    payload?: unknown;
}

// シグナリングクライアントのイベント
export interface SignalingEvents {
    onConnected: () => void;
    onDisconnected: () => void;
    onRoomCreated: (roomCode: string) => void;
    onRoomJoined: (roomId: string, hostId: string, peers: string[]) => void;
    onPeerJoined: (peerId: string, peerName?: string) => void;
    onPeerLeft: (peerId: string) => void;
    onOffer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onAnswer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onIceCandidate: (senderId: string, candidate: RTCIceCandidateInit) => void;
    onError: (code: string, message: string) => void;
}

export class SignalingClient {
    private ws: WebSocket | null = null;
    private events: Partial<SignalingEvents> = {};
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000;

    constructor(private serverUrl: string) { }

    /**
     * イベントリスナーを設定
     */
    on<K extends keyof SignalingEvents>(event: K, handler: SignalingEvents[K]): void {
        this.events[event] = handler;
    }

    /**
     * サーバーに接続
     */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.serverUrl);

                this.ws.onopen = () => {
                    console.log('[Signaling] 接続完了');
                    this.reconnectAttempts = 0;
                    this.events.onConnected?.();
                    resolve();
                };

                this.ws.onclose = () => {
                    console.log('[Signaling] 接続終了');
                    this.events.onDisconnected?.();
                    this.attemptReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('[Signaling] エラー:', error);
                    reject(error);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data) as SignalingMessage;
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('[Signaling] メッセージパースエラー:', error);
                    }
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 接続を閉じる
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * メッセージをハンドル
     */
    private handleMessage(message: SignalingMessage): void {
        console.log('[Signaling] 受信:', message.type);

        switch (message.type) {
            case 'room:created': {
                const payload = message.payload as { roomCode: string };
                this.events.onRoomCreated?.(payload.roomCode);
                break;
            }

            case 'room:joined': {
                const payload = message.payload as { roomId: string; hostId: string; peers: string[] };
                if (payload.roomId) { // 空でない場合のみ
                    this.events.onRoomJoined?.(payload.roomId, payload.hostId, payload.peers);
                }
                break;
            }

            case 'peer:joined': {
                const payload = message.payload as { peerId: string; peerName?: string };
                this.events.onPeerJoined?.(payload.peerId, payload.peerName);
                break;
            }

            case 'peer:left': {
                const payload = message.payload as { peerId: string };
                this.events.onPeerLeft?.(payload.peerId);
                break;
            }

            case 'peer:offer': {
                const payload = message.payload as { sdp: RTCSessionDescriptionInit };
                this.events.onOffer?.(message.senderId!, payload.sdp);
                break;
            }

            case 'peer:answer': {
                const payload = message.payload as { sdp: RTCSessionDescriptionInit };
                this.events.onAnswer?.(message.senderId!, payload.sdp);
                break;
            }

            case 'peer:ice': {
                const payload = message.payload as { candidate: RTCIceCandidateInit };
                this.events.onIceCandidate?.(message.senderId!, payload.candidate);
                break;
            }

            case 'error': {
                const payload = message.payload as { code: string; message: string };
                this.events.onError?.(payload.code, payload.message);
                break;
            }
        }
    }

    /**
     * メッセージを送信
     */
    private send(message: Omit<SignalingMessage, 'timestamp'>): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const fullMessage: SignalingMessage = {
                ...message,
                timestamp: Date.now(),
            };
            this.ws.send(JSON.stringify(fullMessage));
        }
    }

    /**
     * ルームを作成
     */
    createRoom(hostName?: string): void {
        this.send({
            type: 'room:create',
            payload: { hostName },
        });
    }

    /**
     * ルームに参加
     */
    joinRoom(roomCode: string, viewerName?: string): void {
        this.send({
            type: 'room:join',
            payload: { roomCode, viewerName },
        });
    }

    /**
     * ルームから退出
     */
    leaveRoom(): void {
        this.send({
            type: 'room:leave',
        });
    }

    /**
     * SDP Offerを送信
     */
    sendOffer(targetId: string, sdp: RTCSessionDescriptionInit): void {
        this.send({
            type: 'peer:offer',
            targetId,
            payload: { sdp },
        });
    }

    /**
     * SDP Answerを送信
     */
    sendAnswer(targetId: string, sdp: RTCSessionDescriptionInit): void {
        this.send({
            type: 'peer:answer',
            targetId,
            payload: { sdp },
        });
    }

    /**
     * ICE候補を送信
     */
    sendIceCandidate(targetId: string, candidate: RTCIceCandidateInit): void {
        this.send({
            type: 'peer:ice',
            targetId,
            payload: { candidate },
        });
    }

    /**
     * 再接続を試行
     */
    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('[Signaling] 再接続上限に達しました');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;

        console.log(`[Signaling] ${delay}ms後に再接続を試行 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect().catch((error) => {
                console.error('[Signaling] 再接続失敗:', error);
            });
        }, delay);
    }

    /**
     * 接続状態を取得
     */
    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
}
