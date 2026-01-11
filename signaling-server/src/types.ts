/**
 * P2D シグナリングサーバー - 型定義 (Full Mesh P2P Update)
 */

// メッセージタイプ
export type MessageType =
    | 'room:create'      // ルーム作成 (実質joinと同じ)
    | 'room:join'        // ルーム参加
    | 'room:leave'       // ルーム退出
    | 'room:created'     // ルーム作成完了 (createへの応答)
    | 'room:joined'      // ルーム参加完了 (joinへの応答)
    | 'peer:joined'      // 他のピアが参加
    | 'peer:left'        // 他のピアが退出
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
        name?: string; // 作成者の名前
    };
}

// ルーム作成完了メッセージ
export interface RoomCreatedMessage extends SignalingMessage {
    type: 'room:created';
    payload: {
        roomCode: string;
        roomId: string;
    };
}

// ルーム参加メッセージ
export interface RoomJoinMessage extends SignalingMessage {
    type: 'room:join';
    payload: {
        roomCode: string;
        name?: string; // 参加者の名前
    };
}

// ルーム参加完了メッセージ
// 自分が参加した時に、既存の参加者一覧を受け取る
export interface RoomJoinedMessage extends SignalingMessage {
    type: 'room:joined';
    payload: {
        roomId: string;
        roomCode: string;
        myId: string;
        participants: ParticipantInfo[]; // 既存参加者リスト (自分以外)
    };
}

// ピア参加通知メッセージ
// 他の誰かが参加してきた時
export interface PeerJoinedMessage extends SignalingMessage {
    type: 'peer:joined';
    payload: {
        peerId: string;
        name?: string;
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
    participants: Map<string, ParticipantInfo>;
    createdAt: number;
}

// 参加者情報
export interface ParticipantInfo {
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
