/**
 * P2D シグナリングサーバー - 型定義 (Full Mesh P2P Update)
 */

// メッセージタイプ
export type MessageType =
    | 'room:create'      // ルーム作成 (既存ルームへはhostToken保有者のみ再権限として受理)
    | 'room:join'        // ルーム参加
    | 'room:leave'       // ルーム退出
    | 'room:created'     // ルーム作成完了 (createへの応答)
    | 'room:joined'      // ルーム参加完了 (joinへの応答)
    | 'room:host'        // ホスト接続IDの通知 (issue#10: reclaim時に全員へ配布)
    | 'peer:joined'      // 他のピアが参加
    | 'peer:left'        // 他のピアが退出
    | 'peer:offer'       // SDP Offer
    | 'peer:answer'      // SDP Answer
    | 'peer:ice'         // ICE候補
    | 'peer:tunnel'      // DC中継シグナリング (レンデブー最小化M2: 封筒転送)
    | 'error'            // エラー
    // WSリレー (WebRTC非対応エンジン向けフォールバック経路・targetId指定で転送)
    | 'relay:frame'
    | 'relay:subscribe'
    | 'relay:unsubscribe'
    | 'relay:chat'
    | 'relay:input'
    | 'relay:control_allowed';

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
        roomCode?: string; // 指定があればそれを使う (サーバーレス参加とコードを揃えるため)
        hostEndpoint?: string; // ホスト内蔵WSサーバーの住所 (電話帳登録)
        hostToken?: string; // 再権限トークン (issue#9: 既存ルームへのcreateはこれ必須)
    };
}

// ルーム作成完了メッセージ
export interface RoomCreatedMessage extends SignalingMessage {
    type: 'room:created';
    payload: {
        roomCode: string;
        roomId: string;
        hostToken?: string; // ホストだけが受け取る再権限トークン (再接続時のcreateに提示)
        hostId?: string; // ホストの接続ID (issue#10: tree:*/鍵配布の権威チェック用)
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
        hostEndpoint?: string; // 電話帳: ホスト内蔵サーバーの住所 (M2)
        hostId?: string; // ホストの接続ID (issue#10)
    };
}

// ホスト接続ID通知 (issue#10: ホストのreclaimでIDが変わったことを全員へ)
export interface RoomHostMessage extends SignalingMessage {
    type: 'room:host';
    payload: {
        hostId: string;
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
    // レンデブー最小化 (M2): ホスト内蔵WSサーバーの住所 (host:port)。
    // サーバーは「電話帳」としてこれを参加者に配布するだけで、以後の
    // シグナリング/メディアには関与しない。
    // 更新はホストのcreate/reclaim時のみ (issue#10: joinでは書き換え不可)
    hostEndpoint?: string;
    // issue#9: ホスト再権限トークン。created応答で作成者へ1度だけ渡す
    hostToken: string;
    // issue#10: ホストの接続ID。tree:*/鍵配布の権威チェックに使われる
    hostId: string;
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
