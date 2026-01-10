/**
 * P2D シグナリングサーバー - 型定義
 */

// メッセージタイプ
export type MessageType =
    | 'room:create'      // ルーム作成
    | 'room:join'        // ルーム参加
    | 'room:leave'       // ルーム退出
    | 'room:created'     // ルーム作成完了
    | 'room:joined'      // ルーム参加完了
    | 'peer:joined'      // 新しいピアが参加
    | 'peer:left'        // ピアが退出
    | 'peer:offer'       // SDP Offer
    | 'peer:answer'      // SDP Answer
    | 'peer:ice'         // ICE候補
    | 'error';           // エラー

// 基本メッセージ
export interface SignalingMessage {
    type: MessageType;
    roomId?: string;
    senderId?: string;
    targetId?: string;
    timestamp: number;
    payload?: unknown;
}

// ルーム作成メッセージ
export interface RoomCreateMessage extends SignalingMessage {
    type: 'room:create';
    payload: {
        hostName?: string;
    };
}

// ルーム作成完了メッセージ
export interface RoomCreatedMessage extends SignalingMessage {
    type: 'room:created';
    payload: {
        roomCode: string;
    };
}

// ルーム参加メッセージ
export interface RoomJoinMessage extends SignalingMessage {
    type: 'room:join';
    payload: {
        roomCode: string;
        viewerName?: string;
    };
}

// ルーム参加完了メッセージ
export interface RoomJoinedMessage extends SignalingMessage {
    type: 'room:joined';
    payload: {
        roomId: string;
        hostId: string;
        peers: string[];
    };
}

// ピア参加通知メッセージ
export interface PeerJoinedMessage extends SignalingMessage {
    type: 'peer:joined';
    payload: {
        peerId: string;
        peerName?: string;
    };
}

// SDP Offerメッセージ
export interface OfferMessage extends SignalingMessage {
    type: 'peer:offer';
    payload: {
        sdp: RTCSessionDescriptionInit;
    };
}

// SDP Answerメッセージ
export interface AnswerMessage extends SignalingMessage {
    type: 'peer:answer';
    payload: {
        sdp: RTCSessionDescriptionInit;
    };
}

// ICE候補メッセージ
export interface IceCandidateMessage extends SignalingMessage {
    type: 'peer:ice';
    payload: {
        candidate: RTCIceCandidateInit;
    };
}

// エラーメッセージ
export interface ErrorMessage extends SignalingMessage {
    type: 'error';
    payload: {
        code: string;
        message: string;
    };
}

// ルーム情報
export interface Room {
    id: string;
    code: string;
    hostId: string;
    hostName?: string;
    viewers: Map<string, ViewerInfo>;
    createdAt: number;
}

// ビューア情報
export interface ViewerInfo {
    id: string;
    name?: string;
    joinedAt: number;
}

// WebRTC関連の型（ブラウザAPIと互換）
export interface RTCSessionDescriptionInit {
    type: 'offer' | 'answer';
    sdp: string;
}

export interface RTCIceCandidateInit {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
}
