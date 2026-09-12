/**
 * P2D - Room View (Full Mesh P2P)
 * 
 * 統合されたルーム画面。
 * 入室前の選択画面と、入室後のビデオグリッド画面を含む。
 */

import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useWebRTC } from '../hooks/useWebRTC';
import { ChatPanel } from './ChatPanel';
import { MonitorPicker } from './MonitorPicker';
import { QrModal, QrScannerModal } from './QrJoin';
import { normalizeKeyName } from '../lib/dataChannel';
import { addRecentRoom, getRecentRooms, RecentRoom } from '../lib/history';
import { clearPresence, getStoredDiscordClientId, resolveDiscordClientId, setStoredDiscordClientId, updatePresence } from '../lib/discord';

// ビデオグリッドアイテム
interface RemoteControlBinding {
    peerId: string;
    allowed: boolean;
    send: (type: string, payload: unknown) => void;
    onHoverChange: (peerId: string | null) => void;
}

function VideoGridItem({
    stream,
    label,
    isLocal = false,
    control
}: {
    stream?: MediaStream | null;
    label?: string;
    isLocal?: boolean;
    control?: RemoteControlBinding;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const lastMoveSentRef = useRef(0);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    return (
        <div className="relative aspect-video overflow-hidden group rounded-xl bg-[var(--md-surface-lowest,var(--md-surface))] border border-[var(--md-outline-variant)]/50">
            {stream ? (
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={isLocal} // 自分の音声はミュート（ハウリング防止）
                    className={`w-full h-full object-cover ${control?.allowed ? 'cursor-crosshair' : ''}`}
                    onMouseMove={(e) => {
                        if (!control?.allowed || !videoRef.current) return;
                        const now = Date.now();
                        if (now - lastMoveSentRef.current < 16) return; // ~60イベント/sにスロットル
                        lastMoveSentRef.current = now;
                        const rect = videoRef.current.getBoundingClientRect();
                        const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                        const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                        control.send('input:mouse_move', { x, y });
                    }}
                    onMouseDown={(e) => {
                        if (!control?.allowed) return;
                        const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
                        control.send('input:mouse_button', { button, direction: 'down' });
                    }}
                    onMouseUp={(e) => {
                        if (!control?.allowed) return;
                        const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
                        control.send('input:mouse_button', { button, direction: 'up' });
                    }}
                    onContextMenu={(e) => {
                        if (control?.allowed) e.preventDefault();
                    }}
                    onWheel={(e) => {
                        if (!control?.allowed) return;
                        control.send('input:scroll', { deltaX: e.deltaX, deltaY: e.deltaY });
                    }}
                    onMouseEnter={() => control?.onHoverChange(control.peerId)}
                    onMouseLeave={() => control?.onHoverChange(null)}
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]">
                    <span className="text-sm">信号なし</span>
                </div>
            )}

            {/* Label Overlay */}
            <div className="absolute bottom-3 left-3 px-3 py-1 rounded-full bg-black/60 text-xs font-medium text-white flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${stream ? 'bg-[var(--md-primary)]' : 'bg-[var(--md-outline)]'}`}></div>
                {label || '不明'}
                {isLocal && <span className="text-[var(--md-on-surface-variant)] text-[10px] ml-1">(自分)</span>}
            </div>
        </div>
    );
}

import type { TurnConfig } from '../hooks/useWebRTC';
import { runE2E, type E2eConfig, type E2eDeps } from '../lib/e2eRunner';

export function RoomView({ onLeave, signalingUrl, turnConfig, e2eConfig, onOpenSettings }: { onLeave: () => void; signalingUrl?: string; turnConfig?: TurnConfig; e2eConfig?: E2eConfig | null; onOpenSettings?: () => void }) {
    const {
        localStream,
        remoteStreams,
        participants,
        myId,
        createRoom,
        joinRoom,
        leaveRoom,
        isConnected,
        roomCode,
        startScreenShare,
        startCustomScreenShare,
        stopScreenShare,
        isScreenSharing,
        localStreams,
        chatMessages,
        // リモート操作 (F-022)
        remoteControlAllowed,
        setRemoteControlAllowed,
        peerControlAllowed,
        sendInputToPeer,
        sendChatMessage,
        // Microphone
        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMicEnabled,
        isMuted,
        // System Audio (F-031)
        startSystemAudio,
        stopSystemAudio,
        isSystemAudioEnabled,
        // Audio devices
        audioDevices,
        selectedDeviceId,
        setSelectedDeviceId,
        refreshAudioDevices,
        // Speaking
        isSpeaking,
        remoteSpeakingStates,
        // Adaptive Bitrate
        connectionQuality,
        isAdaptiveModeEnabled,
        setAdaptiveModeEnabled,
        // E2Eテスト用統計
        getPeerStats,
    } = useWebRTC({ signalingUrl, turnConfig });

    // E2E自己テストランナー (P2D_E2E_ROLE 環境変数がある起動でのみ動作)
    const e2eDepsRef = useRef<E2eDeps | null>(null);
    e2eDepsRef.current = {
        createRoom, joinRoom, roomCode, myId, participants, remoteStreams,
        chatMessages, peerControlAllowed,
        startCustomScreenShare, stopScreenShare: () => stopScreenShare(),
        setRemoteControlAllowed, startSystemAudio, stopSystemAudio,
        sendChatMessage, getPeerStats,
    };
    const e2eStartedRef = useRef(false);
    useEffect(() => {
        if (!e2eConfig?.enabled || e2eStartedRef.current) return;
        e2eStartedRef.current = true;
        const liveDeps = new Proxy({} as E2eDeps, {
            get: (_t, prop) => (e2eDepsRef.current as unknown as Record<PropertyKey, unknown>)[prop],
        });
        void runE2E(e2eConfig, liveDeps);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [e2eConfig]);

    // 入力ステート
    const [inputCode, setInputCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [showSourcePicker, setShowSourcePicker] = useState(false);
    const [controlPeer, setControlPeer] = useState<string | null>(null);

    // Effect: 初回にオーディオデバイス取得
    useEffect(() => {
        refreshAudioDevices();
    }, [refreshAudioDevices]);

    // リモート操作: ホバー中のリモート画面へのキーボード転送 (入力欄では無効)
    useEffect(() => {
        if (!controlPeer) return;
        const handleKey = (direction: 'down' | 'up') => (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (!peerControlAllowed.get(controlPeer)) return;
            const key = normalizeKeyName(e);
            if (!key) return;
            e.preventDefault();
            sendInputToPeer(controlPeer, 'input:key_event', { key, direction });
        };
        const onDown = handleKey('down');
        const onUp = handleKey('up');
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, [controlPeer, peerControlAllowed, sendInputToPeer]);

    // クリーンアップ
    useEffect(() => {
        return () => {
            // コンポーネント破棄時に退出
            // leaveRoom(); // useWebRTC内でuseEffect cleanupしてるので不要かもだが念の為
            void clearPresence(); // Discord Rich Presenceも掃除 (F-050)
        };
    }, []);

    // --- Discord Rich Presence (F-050): ルーム内の状態をDiscordステータスへ反映 ---
    const [discordClientId, setDiscordClientId] = useState<string | null>(null);
    const [discordIdInput, setDiscordIdInput] = useState(getStoredDiscordClientId());
    useEffect(() => {
        void resolveDiscordClientId().then(setDiscordClientId);
    }, []);
    useEffect(() => {
        if (!isConnected || !roomCode || !discordClientId) return;
        void updatePresence(discordClientId, {
            roomCode,
            details: isScreenSharing ? '画面共有中' : 'ルーム待機中',
            viewers: participants.size,
        });
    }, [isConnected, roomCode, isScreenSharing, participants.size, discordClientId]);

    // --- ディープリンク参加 (F-051): p2d://join/CODE ---
    useEffect(() => {
        // 冷却起動 (アプリが閉じた状態でURLを開いた場合) は起動引数から復元
        void (async () => {
            try {
                const code = await invoke<string | null>('get_launch_join');
                if (code && !isConnected) joinRoom(code).catch(() => { /* 部屋が無い等 */ });
            } catch {
                // ignore
            }
        })();
        // 実行中インスタンスへの2インスタンス目転送はイベントで届く
        const unlisten = listen<string>('p2d-join-url', (e) => {
            if (e.payload && !isConnected) joinRoom(e.payload).catch(() => { /* 部屋が無い等 */ });
        });
        return () => { void unlisten.then((f) => f()); };
        // joinRoom は安定したuseCallback、isConnected は起動直後 false 固定でハンドラ内のみ参照
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 退出ハンドラ
    const handleLeave = () => {
        void clearPresence();
        leaveRoom();
        onLeave();
    };

    // --- QR接続 (F-012) / 接続履歴 (F-013) ---
    const [showQr, setShowQr] = useState(false);
    const [showQrScan, setShowQrScan] = useState(false);
    const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
    useEffect(() => {
        // ルームから戻ってきたタイミングで履歴を再読込
        if (!isConnected) setRecentRooms(getRecentRooms());
    }, [isConnected]);
    useEffect(() => {
        if (isConnected && roomCode) {
            addRecentRoom(roomCode);
        }
    }, [isConnected, roomCode]);

    // --- 未接続時 (ランチャー) ---
    if (!isConnected) {
        return (
            <div className="min-h-screen flex flex-col relative overflow-hidden">
                {/* アプリバー */}
                <header className="h-16 px-4 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3 px-2">
                        <div className="w-8 h-8 rounded-lg bg-[var(--md-primary-container)] flex items-center justify-center text-[var(--md-on-primary-container)]">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        </div>
                        <div className="leading-tight">
                            <div className="text-base font-semibold">P2D</div>
                            <div className="text-[11px] text-[var(--md-on-surface-variant)]">P2P画面共有</div>
                        </div>
                    </div>
                    <button className="md-icon-btn" onClick={() => onOpenSettings?.()} title="設定">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    </button>
                </header>

                <main className="flex-1 w-full max-w-xl mx-auto px-6 pt-8 pb-16 animate-fade-in">
                    <h1 className="text-[28px] leading-snug font-semibold mb-1">セッションを開始</h1>
                    <p className="text-sm text-[var(--md-on-surface-variant)] mb-8">
                        サーバーを介さない直接接続。コードを共有して相手を招待できます。
                    </p>

                    {/* 表示名 */}
                    <div className="md-card p-5 mb-4">
                        <label className="block text-[13px] font-medium text-[var(--md-on-surface-variant)] mb-2">表示名</label>
                        <input
                            type="text"
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            className="input"
                            placeholder="あなたの名前"
                        />
                    </div>

                    {/* 開始 / 参加 */}
                    <div className="md-card p-5 mb-4">
                        <button
                            onClick={() => createRoom(displayName)}
                            className="btn-primary w-full h-12 text-[15px]"
                            disabled={!displayName.trim()}
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                            新しいセッションを開始
                        </button>

                        <div className="flex items-center gap-3 my-5">
                            <div className="h-px flex-1 bg-[var(--md-outline-variant)]"></div>
                            <span className="text-xs text-[var(--md-on-surface-variant)]">またはコードで参加</span>
                            <div className="h-px flex-1 bg-[var(--md-outline-variant)]"></div>
                        </div>

                        <div className="flex gap-3">
                            <input
                                type="text"
                                value={inputCode}
                                onChange={e => setInputCode(e.target.value.toUpperCase())}
                                className="input flex-1 tracking-[0.3em] font-mono text-base text-center"
                                placeholder="XXXXXX"
                                maxLength={6}
                            />
                            <button
                                onClick={() => setShowQrScan(true)}
                                className="md-icon-btn border border-[var(--md-outline-variant)]"
                                title="QRコードで読み取る"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            </button>
                            <button
                                onClick={() => joinRoom(inputCode, displayName)}
                                className="btn-secondary px-6"
                                disabled={!inputCode.trim() || !displayName.trim()}
                            >
                                参加
                            </button>
                        </div>
                    </div>

                    {/* 最近のセッション */}
                    {recentRooms.length > 0 && (
                        <section>
                            <h2 className="text-[13px] font-medium text-[var(--md-on-surface-variant)] mb-2 px-1">最近のセッション</h2>
                            <div className="md-card overflow-hidden divide-y divide-[var(--md-outline-variant)]/50">
                                {recentRooms.map(r => (
                                    <button
                                        key={r.code}
                                        onClick={() => setInputCode(r.code)}
                                        className="md-list-item"
                                        title={new Date(r.at).toLocaleString()}
                                    >
                                        <div className="w-8 h-8 rounded-full bg-[var(--md-surface-high)] flex items-center justify-center text-[11px] text-[var(--md-on-surface-variant)]">
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        </div>
                                        <span className="font-mono tracking-[0.2em] text-sm">{r.code}</span>
                                        <span className="ml-auto text-xs text-[var(--md-on-surface-variant)]">
                                            {new Date(r.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                        <svg className="w-4 h-4 text-[var(--md-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                </main>
                {showQrScan && (
                    <QrScannerModal
                        onScan={(code) => {
                            setShowQrScan(false);
                            setInputCode(code);
                        }}
                        onClose={() => setShowQrScan(false)}
                    />
                )}
            </div>
        );
    }

    // --- 接続済み (ルーム画面) ---
    return (
        <div className="fixed inset-0 w-full h-full flex flex-col bg-[var(--md-surface)] overflow-hidden z-50">
            {/* Top App Bar */}
            <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--md-outline-variant)]/60 bg-[var(--md-surface-low)] shrink-0 z-20">
                <div className="flex items-center gap-4">
                    <h1 className="text-base font-semibold">P2D</h1>
                    <div className="h-6 w-px bg-[var(--md-outline-variant)]"></div>
                    <button
                        className="chip font-mono tracking-[0.2em] text-[var(--md-on-surface)] hover:bg-[color-mix(in_srgb,var(--md-on-surface)_8%,transparent)]"
                        onClick={() => { navigator.clipboard.writeText(roomCode || ''); }}
                        title="部屋コードをコピー"
                    >
                        <span className="text-[11px] text-[var(--md-on-surface-variant)] tracking-normal">CODE</span>
                        {roomCode}
                        <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </button>
                </div>

                <div className="flex items-center gap-3">
                    {/* Connection Quality Indicator */}
                    {connectionQuality && (
                        <div className="relative group">
                            <div className="chip gap-2">
                                <span className={`w-2 h-2 rounded-full ${connectionQuality.qualityLevel === 'excellent' ? 'bg-[var(--md-primary)]' :
                                    connectionQuality.qualityLevel === 'good' ? 'bg-[#a8d08d]' :
                                        connectionQuality.qualityLevel === 'fair' ? 'bg-[#e8c468]' :
                                            'bg-[var(--md-error)]'
                                    }`}></span>
                                <span className="text-[12px]">{connectionQuality.qualityLevel}</span>
                            </div>
                            {/* Tooltip */}
                            <div className="absolute top-full right-0 mt-2 p-4 md-dialog text-xs opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 whitespace-nowrap">
                                <div className="space-y-2">
                                    <div className="flex justify-between gap-6">
                                        <span className="text-[var(--md-on-surface-variant)]">接続経路</span>
                                        <span className={`font-mono ${connectionQuality.candidateType === 'relay' ? 'text-[var(--md-error)]' : 'text-[var(--md-on-surface)]'}`}>
                                            {connectionQuality.candidateType === 'relay' ? 'TURN Relay' : connectionQuality.candidateType === 'srflx' ? 'STUN' : 'Direct'}
                                        </span>
                                    </div>
                                    <div className="flex justify-between gap-6">
                                        <span className="text-[var(--md-on-surface-variant)]">RTT</span>
                                        <span className="font-mono">{connectionQuality.rtt}ms</span>
                                    </div>
                                    <div className="flex justify-between gap-6">
                                        <span className="text-[var(--md-on-surface-variant)]">ビットレート</span>
                                        <span className="font-mono">{connectionQuality.outboundBitrate} kbps</span>
                                    </div>
                                    <div className="flex justify-between gap-6">
                                        <span className="text-[var(--md-on-surface-variant)]">パケットロス</span>
                                        <span className="font-mono">{connectionQuality.packetLoss}%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    <span className="text-xs text-[var(--md-on-surface-variant)]">{participants.size + 1}人が接続中</span>
                    <button
                        onClick={handleLeave}
                        className="btn-danger h-9 px-4 text-[13px]"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        退出
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden relative z-10">

                {/* Left Sidebar (Participants & Chat) */}
                <div className="w-80 border-r border-[var(--md-outline-variant)]/60 bg-[var(--md-surface-low)] flex flex-col">
                    {/* Participants List */}
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                        <h3 className="text-[11px] font-medium text-[var(--md-on-surface-variant)] uppercase tracking-widest mb-3 px-1">Participants</h3>
                        <div className="space-y-1">
                            {/* Me */}
                            <div className={`p-3 rounded-xl flex items-center gap-3 transition-colors ${isSpeaking ? 'bg-[var(--md-primary-container)]/40' : 'bg-transparent hover:bg-[var(--md-surface-container)]'}`}>
                                <div className={`relative w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${isSpeaking ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]'}`}>
                                    {(participants.get(myId || '')?.name?.[0] || 'Me')[0].toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{participants.get(myId || '')?.name || 'Me'} <span className="text-[var(--md-on-surface-variant)] text-xs font-normal">(自分)</span></div>
                                    <div className="text-[10px] text-[var(--md-on-surface-variant)]">ID: {myId?.slice(0, 8)}...</div>
                                </div>
                                {isScreenSharing && (
                                    <div className="text-[10px] text-[var(--md-error)] flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--md-error)] animate-pulse"></span>LIVE
                                    </div>
                                )}
                            </div>

                            {/* Others */}
                            {Array.from(participants).map(([id, info]) => {
                                if (id === myId) return null;
                                const peerSpeaking = remoteSpeakingStates.get(id) || false;
                                return (
                                    <div key={id} className={`p-3 rounded-xl flex items-center gap-3 transition-colors ${peerSpeaking ? 'bg-[var(--md-primary-container)]/40' : 'hover:bg-[var(--md-surface-container)]'}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${peerSpeaking ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]'}`}>
                                            {(info.name || 'User')[0].toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate">{info.name || 'User'}</div>
                                            <div className="text-[10px] text-[var(--md-on-surface-variant)]">ID: {id.slice(0, 8)}...</div>
                                        </div>
                                        {peerSpeaking && (
                                            <div className="text-[10px] text-[var(--md-primary)]">話しています</div>
                                        )}
                                        {remoteStreams.has(id) && (
                                            <div className="text-[10px] text-[var(--md-on-surface-variant)]">映像</div>
                                        )}
                                        {peerControlAllowed.get(id) && (
                                            <div className="text-[10px] text-[var(--md-error)]" title="このピアがあなたの画面をリモート操作できます">操作可</div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Chat Panel (Integrated) — 下端に固定 */}
                    <div className="h-1/2 min-h-[280px] border-t border-[var(--md-outline-variant)]/60 relative">
                        <div className="absolute inset-0">
                            <ChatPanel
                                messages={chatMessages}
                                onSendMessage={sendChatMessage}
                                isConnected={isConnected}
                                myId={myId}
                                className="h-full"
                            />
                        </div>
                    </div>
                </div>

                {/* Video Grid Area */}
                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-fr">
                        {/* My Streams (マルチ共有対応) */}
                        {localStreams.size > 0 ? (
                            Array.from(localStreams).map(([streamId, stream], i) => (
                                <VideoGridItem
                                    key={streamId}
                                    stream={stream}
                                    label={`My Screen ${localStreams.size > 1 ? i + 1 : ''}`.trim()}
                                    isLocal={true}
                                />
                            ))
                        ) : localStream && (
                            <VideoGridItem
                                stream={localStream}
                                label={participants.get(myId || '')?.name || 'Me'}
                                isLocal={true}
                            />
                        )}

                        {/* Remote Streams (リモート操作対応) */}
                        {Array.from(remoteStreams).map(([peerId, stream]) => (
                            <VideoGridItem
                                key={peerId}
                                stream={stream}
                                label={participants.get(peerId)?.name || peerId}
                                control={{
                                    peerId,
                                    allowed: peerControlAllowed.get(peerId) === true,
                                    send: (type, payload) => sendInputToPeer(peerId, type, payload),
                                    onHoverChange: setControlPeer,
                                }}
                            />
                        ))}

                        {/* Empty State if no streams */}
                        {!localStream && localStreams.size === 0 && remoteStreams.size === 0 && (
                            <div className="col-span-full h-96 flex flex-col items-center justify-center text-[var(--md-on-surface-variant)] border-2 border-dashed border-[var(--md-outline-variant)] rounded-xl bg-[var(--md-surface-low)]">
                                <svg className="w-12 h-12 mb-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                <p className="text-base font-medium">まだ共有はありません</p>
                                <p className="text-sm mt-1 opacity-70">下の「画面を共有」から開始できます。</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="h-20 bg-[var(--md-surface-low)] border-t border-[var(--md-outline-variant)]/60 px-8 flex items-center justify-center gap-4 z-20">
                <button
                    onClick={() => isScreenSharing ? stopScreenShare() : setShowSourcePicker(true)}
                    className={`h-12 px-6 rounded-full text-sm font-medium flex items-center gap-3 transition-colors ${isScreenSharing
                        ? 'bg-[var(--md-error-container)] text-[var(--md-on-error-container)] hover:brightness-110'
                        : 'bg-[var(--md-primary)] text-[var(--md-on-primary)] hover:brightness-105'
                        }`}
                >
                    {isScreenSharing ? (
                        <>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
                            共有を停止
                        </>
                    ) : (
                        <>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            画面を共有
                        </>
                    )}
                </button>

                {/* Mic/Audio controls */}
                <div className="h-12 w-px bg-[var(--md-outline-variant)]"></div>

                {/* Microphone Toggle */}
                <button
                    onClick={() => isMicEnabled ? stopMicrophone() : startMicrophone()}
                    className={`md-icon-btn !w-12 !h-12 ${isMicEnabled ? 'md-icon-btn-active' : ''}`}
                    title={isMicEnabled ? "マイクをオフにする" : "マイクをオンにする"}
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                </button>

                {/* Mute Toggle (only when mic is enabled) */}
                {isMicEnabled && (
                    <button
                        onClick={toggleMute}
                        className={`md-icon-btn !w-12 !h-12 ${isMuted ? 'md-icon-btn-active' : ''}`}
                        title={isMuted ? "ミュート解除" : "ミュート"}
                    >
                        {isMuted ? (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                            </svg>
                        ) : (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                            </svg>
                        )}
                    </button>
                )}

                {/* System Audio Toggle (F-031) */}
                <button
                    onClick={() => isSystemAudioEnabled ? stopSystemAudio() : startSystemAudio()}
                    className={`md-icon-btn !w-12 !h-12 ${isSystemAudioEnabled ? 'md-icon-btn-active' : ''}`}
                    title="システム音声を共有 — スピーカーから出ている音がそのまま相手に流れます。エコー防止のためヘッドホン推奨"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5L6 9H2v6h4l5 4V5z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728" />
                    </svg>
                </button>

                {/* QR Share Button (F-012) */}
                {roomCode && (
                    <button
                        onClick={() => setShowQr(true)}
                        className="md-icon-btn !w-12 !h-12"
                        title="QRコードで招待"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM16 16h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" />
                        </svg>
                    </button>
                )}

                {/* Settings Button */}
                <button
                    onClick={() => setShowSettings(true)}
                    className="md-icon-btn !w-12 !h-12"
                    title="設定"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                </button>
            </div>

            {/* Source Picker (ネイティブ/カスタムキャプチャ選択) */}
            {showSourcePicker && (
                <MonitorPicker
                    onSelect={(sourceId, isMonitor) => {
                        setShowSourcePicker(false);
                        startCustomScreenShare(sourceId, isMonitor);
                    }}
                    onNativeCapture={() => {
                        setShowSourcePicker(false);
                        startScreenShare();
                    }}
                    onCancel={() => setShowSourcePicker(false)}
                />
            )}

            {/* Settings Modal */}
            {showSettings && (
                <div className="md-scrim">
                    <div className="md-dialog p-6 max-w-md w-full animate-slide-up max-h-[85vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-semibold">設定</h2>
                            <button
                                onClick={() => setShowSettings(false)}
                                className="md-icon-btn"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" /></svg>
                            </button>
                        </div>

                        <div className="space-y-6">
                            {/* Audio Device Selection */}
                            <div>
                                <label className="block text-[13px] font-medium text-[var(--md-on-surface-variant)] mb-2">マイクデバイス</label>
                                <select
                                    value={selectedDeviceId || ''}
                                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                                    className="input w-full"
                                >
                                    {audioDevices.length === 0 ? (
                                        <option value="">デバイスが見つかりません</option>
                                    ) : (
                                        audioDevices.map(device => (
                                            <option key={device.deviceId} value={device.deviceId}>
                                                {device.label || `Device ${device.deviceId.slice(0, 8)}`}
                                            </option>
                                        ))
                                    )}
                                </select>
                                <button
                                    onClick={refreshAudioDevices}
                                    className="btn-text mt-2 text-xs"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
                                    デバイスを再読込
                                </button>
                            </div>

                            {/* Microphone Status */}
                            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-[var(--md-on-surface-variant)]">マイクの状態</span>
                                    <span className={`text-xs font-medium ${isMicEnabled
                                        ? (isMuted ? 'text-[#e8c468]' : 'text-[var(--md-primary)]')
                                        : 'text-[var(--md-on-surface-variant)]'
                                        }`}>
                                        {isMicEnabled ? (isMuted ? 'ミュート' : 'オン') : 'オフ'}
                                    </span>
                                </div>
                            </div>

                            {/* Advanced Settings */}
                            <div className="pt-4 border-t border-[var(--md-outline-variant)]/60">
                                <h4 className="text-[11px] font-medium text-[var(--md-on-surface-variant)] uppercase tracking-widest mb-4">詳細</h4>

                                {/* Adaptive Mode Toggle */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-sm font-medium">適応ビットレート</div>
                                        <div className="text-xs text-[var(--md-on-surface-variant)]">回線品質に応じて画質を自動調整</div>
                                    </div>
                                    <button
                                        role="switch"
                                        aria-checked={isAdaptiveModeEnabled}
                                        onClick={() => setAdaptiveModeEnabled(!isAdaptiveModeEnabled)}
                                        className={`md-switch ${isAdaptiveModeEnabled ? 'on' : ''}`}
                                    />
                                </div>

                                {/* リモート操作許可 (F-022: デフォルトOFF) */}
                                <div className="flex items-center justify-between mt-5">
                                    <div>
                                        <div className="text-sm font-medium">リモート操作を許可</div>
                                        <div className="text-xs text-[var(--md-on-surface-variant)]">相手があなたのマウス/キーボードを操作できるようにする</div>
                                    </div>
                                    <button
                                        role="switch"
                                        aria-checked={remoteControlAllowed}
                                        onClick={() => setRemoteControlAllowed(!remoteControlAllowed)}
                                        className={`md-switch ${remoteControlAllowed ? 'on' : ''}`}
                                    />
                                </div>

                                {/* Discord Rich Presence (F-050) */}
                                <div className="mt-5">
                                    <label className="block text-sm font-medium mb-2">Discord Application ID</label>
                                    <div className="flex gap-2">
                                        <input
                                            value={discordIdInput}
                                            onChange={(e) => setDiscordIdInput(e.target.value)}
                                            placeholder="例: 1234567890123456789"
                                            className="input flex-1 font-mono text-sm"
                                        />
                                        <button
                                            onClick={() => {
                                                setStoredDiscordClientId(discordIdInput);
                                                setDiscordClientId(discordIdInput.trim() || null);
                                            }}
                                            className="btn-secondary px-4 text-xs whitespace-nowrap"
                                        >
                                            保存
                                        </button>
                                    </div>
                                    <div className="text-xs text-[var(--md-on-surface-variant)] mt-2">
                                        discord.com/developers/applications で作成したApplication IDを設定すると、
                                        ルーム中のDiscordステータスに「参加する」ボタン付きで表示されます (F-050/F-051)
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end pt-6 mt-6 border-t border-[var(--md-outline-variant)]/60">
                            <button
                                onClick={() => setShowSettings(false)}
                                className="btn-primary px-6 py-2"
                            >
                                閉じる
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* QR Share (F-012) */}
            {showQr && roomCode && (
                <QrModal roomCode={roomCode} onClose={() => setShowQr(false)} />
            )}
            {showQrScan && (
                <QrScannerModal
                    onScan={(code) => {
                        setShowQrScan(false);
                        setInputCode(code);
                    }}
                    onClose={() => setShowQrScan(false)}
                />
            )}
        </div>

    );
}
