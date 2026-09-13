/**
 * P2D - シグナリングクライアント (Full Mesh P2P Update)
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
    // DC中継シグナリング (レンデブー最小化M2): サーバー死亡時にピア経由でSDP/ICEを届ける封筒
    | 'peer:tunnel'
    | 'error'
    // WSリレー (WebRTC非対応エンジン向けフォールバック経路)
    | 'relay:frame'
    | 'relay:subscribe'
    | 'relay:unsubscribe'
    | 'relay:chat'
    | 'relay:input'
    | 'relay:control_allowed';

export interface SignalingMessage {
    type: MessageType;
    roomId?: string;
    senderId?: string;
    targetId?: string;
    timestamp: number;
    payload?: unknown;
}

// 参加者情報
export interface ParticipantInfo {
    id: string;
    name?: string;
    joinedAt: number;
    // ホスト内蔵サーバーの住所 (電話帳が配布する、M2以降)
    hostEndpoint?: string;
}

// DC中継シグナリングの封筒 (src/lib/signalRouter.ts と同期)
export interface TunnelEnvelope {
    originalSender: string;
    kind: 'offer' | 'answer' | 'ice';
    targetId: string;
    payload: unknown;
    hops: number;
}

// シグナリングクライアントのイベント
export interface SignalingEvents {
    onConnected: () => void;
    onDisconnected: () => void;
    onRoomCreated: (roomCode: string, roomId: string) => void;
    // 更新: peersリストではなくParticipantInfo[]を受け取る
    onRoomJoined: (roomId: string, roomCode: string, myId: string, participants: ParticipantInfo[], hostEndpoint?: string | null) => void;
    onPeerJoined: (peerId: string, peerName?: string) => void;
    onPeerLeft: (peerId: string) => void;
    onOffer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onAnswer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onIceCandidate: (senderId: string, candidate: RTCIceCandidateInit) => void;
    // peer:tunnel 受信 (senderId=転送者, payload=封筒 {originalSender, kind, targetId, payload, hops})
    onTunneledMessage?: (senderId: string, envelope: TunnelEnvelope) => void;
    onError: (code: string, message: string) => void;
    // WSリレー: relay:* をすべて1つのハンドラへ集約 (type は 'relay:' を除去したもの)
    onRelayMessage?: (senderId: string, type: string, payload: unknown) => void;
}

export class SignalingClient {
    private ws: WebSocket | null = null;
    private events: Partial<SignalingEvents> = {};
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    // 移行 (内蔵サーバーへの切替) 時に古いクライアントの再接続を止めるためのフラグ
    private disposed = false;

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
     * 切断 + 再接続ループの停止 (サーバー移行時に旧クライアントを捨てる)
     */
    dispose(): void {
        this.disposed = true;
        this.disconnect();
    }

    /**
     * メッセージをハンドル
     */
    private handleMessage(message: SignalingMessage): void {
        if (message.type !== 'peer:ice' && message.type !== 'relay:frame') {
            console.log('[Signaling] 受信:', message.type);
        }

        // WSリレー: peer系ハンドラと独立した経路
        if (message.type.startsWith('relay:')) {
            this.events.onRelayMessage?.(message.senderId || '', message.type.slice('relay:'.length), message.payload);
            return;
        }

        switch (message.type) {
            case 'room:created': {
                const payload = message.payload as { roomCode: string, roomId: string };
                this.events.onRoomCreated?.(payload.roomCode, payload.roomId);
                break;
            }

            case 'room:joined': {
                const payload = message.payload as { roomId: string; roomCode: string; myId: string; participants: ParticipantInfo[]; hostEndpoint?: string };
                if (payload.roomId) { // 空でない場合のみ
                    this.events.onRoomJoined?.(payload.roomId, payload.roomCode, payload.myId, payload.participants, payload.hostEndpoint);
                }
                break;
            }

            case 'peer:joined': {
                const payload = message.payload as { peerId: string; name?: string };
                // peerName プロパティで来るか name プロパティで来るか要確認。サーバー側は name で送っている。
                this.events.onPeerJoined?.(payload.peerId, payload.name);
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

            case 'peer:tunnel': {
                const envelope = message.payload as TunnelEnvelope;
                if (envelope && typeof envelope.originalSender === 'string') {
                    this.events.onTunneledMessage?.(message.senderId || '', envelope);
                }
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
     * ルームを作成 (レンデブー最小化 M2: ローカル生成コードと内蔵サーバー住所を電話帳へ登録)
     */
    createRoom(name?: string, roomCode?: string, hostEndpoint?: string): void {
        this.send({
            type: 'room:create',
            payload: { name, roomCode, hostEndpoint },
        });
    }

    /**
     * ルームに参加
     */
    joinRoom(roomCode: string, name?: string): void {
        this.send({
            type: 'room:join',
            payload: { roomCode, name },
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
     * WSリレーメッセージを特定ピアへ送信 (type は 'relay:' を除いたもの)
     */
    sendRelay(targetId: string, type: string, payload: unknown): void {
        this.send({
            type: `relay:${type}` as MessageType,
            targetId,
            payload,
        });
    }

    /**
     * DC中継シグナリングの封筒を宛先ピアへ転送依頼する (M2)
     */
    sendTunnel(targetId: string, envelope: TunnelEnvelope): void {
        this.send({
            type: 'peer:tunnel',
            targetId,
            payload: envelope,
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
        if (this.disposed) return;
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
