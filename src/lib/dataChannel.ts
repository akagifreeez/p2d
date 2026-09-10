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
    | 'input:mouse_button' // マウスボタン Press/Release (ドラッグ)
    | 'input:scroll'       // スクロール
    | 'input:key'          // キー入力 (レガシー: テキスト)
    | 'input:key_event'    // キーイベント (down/up分離・修飾キーは独立イベント)
    | 'control:remote_allowed' // ホスト→ビューア: リモート操作の許可状態 (F-022)
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

export interface MouseButtonData {
    button: 'left' | 'right' | 'middle';
    direction: 'down' | 'up';
}

export interface KeyEventData {
    key: string; // 正規化キー名 (ctrl, shift, enter, a, f5...)
    direction: 'down' | 'up';
}

// KeyboardEvent.key をホスト側で解釈可能な正規化キー名に変換
export function normalizeKeyName(e: KeyboardEvent): string {
    switch (e.key) {
        case 'Control': return 'ctrl';
        case 'Shift': return 'shift';
        case 'Alt': return 'alt';
        case 'Meta': return 'meta';
        case 'Enter': return 'enter';
        case 'Tab': return 'tab';
        case 'Escape': return 'escape';
        case 'Backspace': return 'backspace';
        case 'Delete': return 'delete';
        case ' ': return 'space';
        case 'ArrowUp': return 'up';
        case 'ArrowDown': return 'down';
        case 'ArrowLeft': return 'left';
        case 'ArrowRight': return 'right';
        case 'Home': return 'home';
        case 'End': return 'end';
        case 'PageUp': return 'pageup';
        case 'PageDown': return 'pagedown';
        default:
            if (/^F\d{1,2}$/.test(e.key)) return e.key.toLowerCase();
            if (e.key.length === 1) return e.key.toLowerCase();
            return '';
    }
}

export interface ClipboardData {
    text: string;
}

// チャットメッセージ（互換用）
export interface ChatMessage extends DataChannelMessage<ChatMessageData> {
    type: 'chat:message';
}
