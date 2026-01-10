/**
 * P2D - DataChannel管理
 * 
 * WebRTC DataChannelを使用したピア間通信を管理する。
 * チャットメッセージ、統計情報交換などに使用。
 */

// メッセージタイプ
export type DataChannelMessageType =
    | 'chat:message'       // チャットメッセージ
    | 'stats:request'      // 統計情報リクエスト
    | 'stats:response'     // 統計情報レスポンス
    | 'control:pause'      // 一時停止
    | 'control:resume'     // 再開
    | 'input:mouse_move'   // マウス移動
    | 'input:click'        // クリック
    | 'input:scroll'       // スクロール
    | 'input:key'          // キー入力
    | 'clipboard:update'   // クリップボード更新
    | 'screen:start'       // 画面共有開始 (NEW)
    | 'screen:stop';       // 画面共有停止 (NEW)

// メッセージ基本構造
export interface DataChannelMessage<T = unknown> {
    type: DataChannelMessageType;
    timestamp: number;
    data: T;
}

// チャットメッセージデータ
export interface ChatMessageData {
    id: string;
    sender: 'host' | 'viewer';
    senderName?: string;
    text: string;
}

// 入力データ型定義
export interface MouseMoveData {
    x: number; // 0.0 - 1.0 (正規化座標)
    y: number; // 0.0 - 1.0 (正規化座標)
}

export interface ClickData {
    button: 'left' | 'right' | 'middle';
}

export interface ScrollData {
    deltaX: number;
    deltaY: number;
}

export interface KeyData {
    key: string;
}

export interface ClipboardData {
    text: string;
}

// チャットメッセージ
export interface ChatMessage extends DataChannelMessage<ChatMessageData> {
    type: 'chat:message';
}

// DataChannelイベントハンドラ
export interface DataChannelHandlers {
    onMessage?: (message: DataChannelMessage) => void;
    onChatMessage?: (message: ChatMessage) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (error: Event) => void;
}

/**
 * DataChannelを作成・管理するクラス
 */
export class DataChannelManager {
    private channel: RTCDataChannel | null = null;
    private handlers: DataChannelHandlers = {};
    private isHost: boolean;

    constructor(isHost: boolean, handlers: DataChannelHandlers = {}) {
        this.isHost = isHost;
        this.handlers = handlers;
    }

    /**
     * ホスト側: DataChannelを作成
     */
    createChannel(peerConnection: RTCPeerConnection): RTCDataChannel {
        const channel = peerConnection.createDataChannel('p2d-control', {
            ordered: true,  // メッセージ順序保証
        });

        this.setupChannel(channel);
        return channel;
    }

    /**
     * ビューア側: DataChannelを受信
     */
    setupOnDataChannel(peerConnection: RTCPeerConnection): void {
        peerConnection.ondatachannel = (event) => {
            console.log('[DataChannel] チャンネル受信:', event.channel.label);
            this.setupChannel(event.channel);
        };
    }

    /**
     * チャンネルの共通セットアップ
     */
    private setupChannel(channel: RTCDataChannel): void {
        this.channel = channel;

        channel.onopen = () => {
            console.log('[DataChannel] 接続開始');
            this.handlers.onOpen?.();
        };

        channel.onclose = () => {
            console.log('[DataChannel] 接続終了');
            this.handlers.onClose?.();
        };

        channel.onerror = (event) => {
            console.error('[DataChannel] エラー:', event);
            this.handlers.onError?.(event);
        };

        channel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data) as DataChannelMessage;
                console.log('[DataChannel] メッセージ受信:', message.type);

                // 汎用ハンドラ
                this.handlers.onMessage?.(message);

                // タイプ別ハンドラ
                if (message.type === 'chat:message') {
                    this.handlers.onChatMessage?.(message as ChatMessage);
                }
            } catch (error) {
                console.error('[DataChannel] メッセージパースエラー:', error);
            }
        };
    }

    /**
     * メッセージを送信
     */
    send<T>(type: DataChannelMessageType, data: T): boolean {
        if (!this.channel || this.channel.readyState !== 'open') {
            console.warn('[DataChannel] チャンネルが開いていません');
            return false;
        }

        const message: DataChannelMessage<T> = {
            type,
            timestamp: Date.now(),
            data,
        };

        try {
            this.channel.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('[DataChannel] 送信エラー:', error);
            return false;
        }
    }

    /**
     * チャットメッセージを送信
     */
    sendChatMessage(text: string, senderName?: string): boolean {
        const data: ChatMessageData = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            sender: this.isHost ? 'host' : 'viewer',
            senderName,
            text,
        };

        return this.send('chat:message', data);
    }

    /**
     * チャンネルの状態を取得
     */
    get isOpen(): boolean {
        return this.channel?.readyState === 'open';
    }

    /**
     * クリーンアップ
     */
    close(): void {
        if (this.channel) {
            this.channel.close();
            this.channel = null;
        }
    }
}
