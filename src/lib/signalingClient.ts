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
    | 'room:host'
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
    // 更新: room:created 応答に hostToken (再権限トークン, issue#9) が載る
    onRoomCreated: (roomCode: string, roomId: string, hostToken?: string) => void;
    // 更新: room:joined 応答に hostId (issue#10) が載る
    onRoomJoined: (roomId: string, roomCode: string, myId: string, participants: ParticipantInfo[], hostEndpoint?: string | null, hostId?: string | null) => void;
    // room:host (issue#10): ホストの再接続でホスト接続IDが変わった通知
    onHostChanged?: (hostId: string) => void;
    onPeerJoined: (peerId: string, peerName?: string) => void;
    onPeerLeft: (peerId: string) => void;
    onOffer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onAnswer: (senderId: string, sdp: RTCSessionDescriptionInit) => void;
    onIceCandidate: (senderId: string, candidate: RTCIceCandidateInit) => void;
    // peer:tunnel 受信 (senderId=転送者, payload=封筒 {originalSender, kind, targetId, payload, hops})
    onTunneledMessage?: (senderId: string, envelope: TunnelEnvelope) => void;
    onError: (code: string, message: string) => void;
    /** M5: 自動再接続を打ち切った (手動再参加が必要)。reason: 15分経過 / 部屋が存在しない */
    onRetryGaveUp?: (reason: 'timeout' | 'room-not-found') => void;
    // WSリレー: relay:* をすべて1つのハンドラへ集約 (type は 'relay:' を除去したもの)
    onRelayMessage?: (senderId: string, type: string, payload: unknown) => void;
}

export class SignalingClient {
    private ws: WebSocket | null = null;
    private events: Partial<SignalingEvents> = {};
    private reconnectAttempts = 0;
    private reconnectDelay = 1000;
    // M5: 段階的再接続 — 0〜2分は積極的 (1〜5秒)、2〜15分は緩やか (20〜30秒)、
    // 15分で打ち切り。サーバーが「部屋がない」(ROOM_NOT_FOUND) と明示した場合は
    // 早めに諦める。いずれもジッター付きで全員の同時再接続 (ストーム) を崩す
    private retryStartedAt = 0;
    private roomNotFoundCount = 0;
    private gaveUp = false;

    /** 自動再接続を打ち切ったか (true = 手動再参加が必要) */
    get isRetryGaveUp(): boolean {
        return this.gaveUp;
    }
    // 移行 (内蔵サーバーへの切替) 時に古いクライアントの再接続を止めるためのフラグ
    private disposed = false;
    // room:created 応答で受け取ったホスト再権限トークン (issue#9)。
    // 同一接続が切れて再接続する際、createRoomへ自動で添付される
    private hostToken: string | null = null;

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
                    this.retryStartedAt = 0;
                    this.roomNotFoundCount = 0;
                    this.gaveUp = false;
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
                const payload = message.payload as { roomCode: string, roomId: string, hostToken?: string };
                // 再権限トークンを覚えておく (再接続時のcreateに添付される, issue#9)
                if (payload.hostToken) this.hostToken = payload.hostToken;
                this.events.onRoomCreated?.(payload.roomCode, payload.roomId, payload.hostToken);
                break;
            }

            case 'room:host': {
                const payload = message.payload as { hostId: string };
                if (payload.hostId) this.events.onHostChanged?.(payload.hostId);
                break;
            }

            case 'room:joined': {
                const payload = message.payload as { roomId: string; roomCode: string; myId: string; participants: ParticipantInfo[]; hostEndpoint?: string; hostId?: string };
                if (payload.roomId) { // 空でない場合のみ
                    this.events.onRoomJoined?.(payload.roomId, payload.roomCode, payload.myId, payload.participants, payload.hostEndpoint, payload.hostId);
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
                // M5: 部屋が存在しない明示的な応答は再接続の早期打ち切り判定に使う
                if (payload.code === 'ROOM_NOT_FOUND') this.roomNotFoundCount++;
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
     * issue#9: 既存ルームへの再作成 (再接続/移行) では hostToken の提示が必須。
     * 省略時はこのクライアントが記憶しているトークンを自動で使う
     */
    createRoom(name?: string, roomCode?: string, hostEndpoint?: string, hostToken?: string): void {
        this.send({
            type: 'room:create',
            payload: { name, roomCode, hostEndpoint, hostToken: hostToken ?? this.hostToken ?? undefined },
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
     * 再接続を試行 (M5: 段階的。打ち切りは onRetryGaveUp で通知)
     */
    private attemptReconnect(): void {
        if (this.disposed || this.gaveUp) return;
        const now = Date.now();
        if (this.retryStartedAt === 0) this.retryStartedAt = now;
        const elapsed = now - this.retryStartedAt;

        // サーバーが部屋の不在を明示している場合は、ホストが戻る可能性より
        // 「セッションが終わった」可能性が高いので早めに諦める
        if (this.roomNotFoundCount >= 3) {
            this.gaveUp = true;
            console.log('[Signaling] 部屋が見つからないため自動再接続を停止 (手動で再参加してください)');
            this.events.onRetryGaveUp?.('room-not-found');
            return;
        }
        if (elapsed >= 15 * 60_000) {
            this.gaveUp = true;
            console.log('[Signaling] 自動再接続を打ち切り (15分経過)。手動で再参加してください');
            this.events.onRetryGaveUp?.('timeout');
            return;
        }

        let delay: number;
        if (elapsed < 2 * 60_000) {
            this.reconnectAttempts++;
            delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 5000);
        } else {
            delay = 20_000;
        }
        delay = Math.round(delay * (0.9 + Math.random() * 0.3)); // ±ジッター

        console.log(`[Signaling] ${delay}ms後に再接続を試行 (経過${Math.round(elapsed / 1000)}秒)`);

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
