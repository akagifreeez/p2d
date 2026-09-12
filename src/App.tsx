import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RoomView } from './components/RoomView';
import { useWindowPosition } from './hooks/useWindowPosition';
import type { E2eConfig } from './lib/e2eRunner';

function App() {
    // ウィンドウ位置管理 (起動時復元・終了時保存・Ctrl+Shift+←/→でモニター間移動)
    useWindowPosition();

    // 設定
    const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
    const [showSettings, setShowSettings] = useState(false);
    const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
    const [e2eConfig, setE2eConfig] = useState<E2eConfig | null>(null);

    // TURNサーバー設定
    const [turnUrl, setTurnUrl] = useState('');
    const [turnUsername, setTurnUsername] = useState('');
    const [turnCredential, setTurnCredential] = useState('');

    useEffect(() => {
        const savedSignaling = localStorage.getItem('p2d_signaling_url');
        if (savedSignaling) setSignalingUrl(savedSignaling);

        const savedTurnUrl = localStorage.getItem('p2d_turn_url');
        const savedTurnUsername = localStorage.getItem('p2d_turn_username');
        const savedTurnCredential = localStorage.getItem('p2d_turn_credential');
        if (savedTurnUrl) setTurnUrl(savedTurnUrl);
        if (savedTurnUsername) setTurnUsername(savedTurnUsername);
        if (savedTurnCredential) setTurnCredential(savedTurnCredential);

        // E2E自己テストモード (P2D_E2E_ROLE 環境変数がある起動でのみ有効)
        // --p2d-signaling-url= があれば設定画面の保存値より優先して初期URLにする
        invoke<E2eConfig>('get_e2e_config')
            .then(cfg => {
                if (cfg.signalingUrl) setSignalingUrl(cfg.signalingUrl);
                if (cfg.enabled) setE2eConfig(cfg);
            })
            .catch(() => { });
    }, []);

    const saveSettings = () => {
        localStorage.setItem('p2d_signaling_url', signalingUrl);
        localStorage.setItem('p2d_turn_url', turnUrl);
        localStorage.setItem('p2d_turn_username', turnUsername);
        localStorage.setItem('p2d_turn_credential', turnCredential);
        setShowSettings(false);
        window.location.reload();
    };

    const resetSettings = () => {
        localStorage.removeItem('p2d_signaling_url');
        localStorage.removeItem('p2d_turn_url');
        localStorage.removeItem('p2d_turn_username');
        localStorage.removeItem('p2d_turn_credential');
        setSignalingUrl(DEFAULT_SIGNALING_URL);
        setTurnUrl('');
        setTurnUsername('');
        setTurnCredential('');
    };

    // TURN設定オブジェクト（URLが空ならundefined）
    const turnConfig = turnUrl ? {
        url: turnUrl,
        username: turnUsername || undefined,
        credential: turnCredential || undefined,
    } : undefined;

    return (
        <div className="min-h-screen bg-[var(--md-surface)] text-[var(--md-on-surface)] relative">
            {/* 設定モーダル */}
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
                            {/* Signaling Server */}
                            <div>
                                <label className="block text-[13px] font-medium text-[var(--md-on-surface-variant)] mb-2">シグナリングサーバーURL</label>
                                <input
                                    type="text"
                                    value={signalingUrl}
                                    onChange={(e) => setSignalingUrl(e.target.value)}
                                    className="input w-full"
                                    placeholder="ws://localhost:8080"
                                />
                                <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
                                    ローカル: <span className="font-mono">ws://localhost:8080</span> /
                                    LAN: <span className="font-mono">ws://192.168.x.x:8080</span>
                                </p>
                            </div>

                            {/* TURN Server */}
                            <div className="pt-4 border-t border-[var(--md-outline-variant)]/60">
                                <label className="block text-[13px] font-medium text-[var(--md-on-surface-variant)] mb-2">TURNサーバー (任意)</label>
                                <p className="text-xs text-[var(--md-on-surface-variant)] mb-3">
                                    NAT越えが必要な場合に設定します。
                                </p>
                                <input
                                    type="text"
                                    value={turnUrl}
                                    onChange={(e) => setTurnUrl(e.target.value)}
                                    className="input w-full mb-2"
                                    placeholder="turn:example.com:3478"
                                />
                                <div className="grid grid-cols-2 gap-2">
                                    <input
                                        type="text"
                                        value={turnUsername}
                                        onChange={(e) => setTurnUsername(e.target.value)}
                                        className="input"
                                        placeholder="Username"
                                    />
                                    <input
                                        type="password"
                                        value={turnCredential}
                                        onChange={(e) => setTurnCredential(e.target.value)}
                                        className="input"
                                        placeholder="Credential"
                                    />
                                </div>
                                {turnUrl && (
                                    <div className="mt-2 text-xs text-[var(--md-primary)] flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 bg-[var(--md-primary)] rounded-full"></span>
                                        TURNサーバー設定済み
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-4 pt-6 mt-6 border-t border-[var(--md-outline-variant)]/60">
                            <button
                                onClick={resetSettings}
                                className="btn-text text-sm"
                            >
                                デフォルトに戻す
                            </button>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setShowSettings(false)}
                                    className="btn-secondary text-sm"
                                >
                                    キャンセル
                                </button>
                                <button
                                    onClick={saveSettings}
                                    className="btn-primary text-sm"
                                >
                                    保存して再起動
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Main Room View */}
            <RoomView onLeave={() => { }} signalingUrl={signalingUrl} turnConfig={turnConfig} e2eConfig={e2eConfig} onOpenSettings={() => setShowSettings(true)} />

            <div className="fixed bottom-4 left-0 w-full text-center pointer-events-none z-0 opacity-50">
                <div className="text-[10px] text-[var(--md-on-surface-variant)] font-mono tracking-widest">
                    P2D v0.2.0 (Full Mesh Beta)
                </div>
            </div>
        </div>
    );
}

export default App;
