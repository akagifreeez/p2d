/**
 * P2D - DataChannel管理 (Full Mesh P2P Update)
 * 
 * 型定義のみを中心に使用。DataChannelManagerクラスはレガシーサポートまたは削除予定。
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
    | 'screen:start'       // 画面共有開始
    | 'screen:stop'        // 画面共有停止
    | 'chat';              // 簡易チャット (useWebRTCで使用)

// メッセージ基本構造
export interface DataChannelMessage<T = unknown> {
    type: DataChannelMessageType;
    timestamp: number;
    data: T;
}

// チャットメッセージデータ
export interface ChatMessageData {
    id: string;
    senderId: string;
    senderName?: string;
    content: string; // 統一 (text -> content)
    timestamp: number;
    isHost?: boolean; // Legacy support
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

// チャットメッセージ（互換用）
export interface ChatMessage extends DataChannelMessage<ChatMessageData> {
    type: 'chat:message';
}
