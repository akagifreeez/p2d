import { create } from 'zustand';

// 接続状態の型定義
export type ConnectionState =
    | 'disconnected'  // 未接続
    | 'connecting'    // 接続中
    | 'connected'     // シグナリングサーバー接続済み
    | 'peer-connecting' // P2P接続確立中
    | 'peer-connected'; // P2P接続済み

// ストアの型定義
interface ConnectionStore {
    // 状態
    connectionState: ConnectionState;
    roomCode: string | null;
    isHost: boolean;
    error: string | null;

    // 統計情報
    stats: {
        latency: number;
        bitrate: number;
        fps: number;
    } | null;

    // アクション
    setConnectionState: (state: ConnectionState) => void;
    setRoomCode: (code: string | null) => void;
    setIsHost: (isHost: boolean) => void;
    setError: (error: string | null) => void;
    setStats: (stats: ConnectionStore['stats']) => void;
    reset: () => void;
}

// 初期状態
const initialState = {
    connectionState: 'disconnected' as ConnectionState,
    roomCode: null,
    isHost: false,
    error: null,
    stats: null,
};

// Zustandストア作成
export const useConnectionStore = create<ConnectionStore>((set) => ({
    ...initialState,

    setConnectionState: (state) => set({ connectionState: state }),
    setRoomCode: (code) => set({ roomCode: code }),
    setIsHost: (isHost) => set({ isHost }),
    setError: (error) => set({ error }),
    setStats: (stats) => set({ stats }),

    reset: () => set(initialState),
}));
