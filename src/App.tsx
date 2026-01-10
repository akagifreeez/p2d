import { useState, useEffect } from 'react';
import { useConnectionStore } from './stores/connectionStore';
import { HostView } from './components/HostView';
import { ViewerView } from './components/ViewerView';

// ビュータイプ
type ViewType = 'select' | 'host' | 'viewer';

function App() {
    const [view, setView] = useState<ViewType>('select');
    const { connectionState } = useConnectionStore();

    // 設定
    const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
    const [showSettings, setShowSettings] = useState(false);
    const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);

    useEffect(() => {
        const saved = localStorage.getItem('p2d_signaling_url');
        if (saved) setSignalingUrl(saved);
    }, []);

    const saveSettings = () => {
        localStorage.setItem('p2d_signaling_url', signalingUrl);
        setShowSettings(false);
        window.location.reload();
    };

    const resetSettings = () => {
        localStorage.removeItem('p2d_signaling_url');
        setSignalingUrl(DEFAULT_SIGNALING_URL);
    };

    // ホスト画面
    if (view === 'host') {
        return <HostView onBack={() => setView('select')} />;
    }

    // ビューア画面
    if (view === 'viewer') {
        return <ViewerView onBack={() => setView('select')} />;
    }

    // モード選択画面
    return (
        <div className="min-h-screen flex items-center justify-center p-8 relative">
            {/* 設定ボタン */}
            <button
                onClick={() => setShowSettings(true)}
                className="absolute top-4 right-4 p-2 text-white/50 hover:text-white transition-colors"
                title="設定"
            >
                ⚙️
            </button>

            {/* 設定モーダル */}
            {showSettings && (
                <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
                    <div className="bg-gray-800 p-6 rounded-xl max-w-md w-full border border-white/10 space-y-4">
                        <h2 className="text-xl font-bold text-white mb-4">設定</h2>

                        <div className="space-y-2">
                            <label className="text-sm text-gray-400">シグナリングサーバー URL</label>
                            <input
                                type="text"
                                value={signalingUrl}
                                onChange={(e) => setSignalingUrl(e.target.value)}
                                className="w-full bg-black/50 border border-white/20 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-primary-500"
                                placeholder="ws://localhost:8080"
                            />
                            <p className="text-xs text-gray-500">
                                別のPCから接続する場合は、ホストPCのIPを指定してください。<br />
                                例: ws://192.168.1.10:8080
                            </p>
                        </div>

                        <div className="flex gap-3 pt-4">
                            <button
                                onClick={resetSettings}
                                className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 text-sm"
                            >
                                初期化
                            </button>
                            <div className="flex-1"></div>
                            <button
                                onClick={() => setShowSettings(false)}
                                className="px-4 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
                            >
                                キャンセル
                            </button>
                            <button
                                onClick={saveSettings}
                                className="px-4 py-2 rounded-lg bg-primary-600 text-white hover:bg-primary-500 transition-colors font-bold"
                            >
                                保存して再起動
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-md w-full space-y-8">
                {/* ロゴ・タイトル */}
                <div className="text-center">
                    <h1 className="text-4xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
                        P2D
                    </h1>
                    <p className="mt-2 text-dark-400">
                        P2P Desktop Sharing
                    </p>
                </div>

                {/* モード選択 */}
                <div className="space-y-4">
                    <button
                        onClick={() => setView('host')}
                        className="w-full card p-6 hover:border-primary-500 transition-all duration-200 group"
                    >
                        <div className="flex items-center space-x-4">
                            <div className="w-12 h-12 rounded-full bg-primary-600/20 flex items-center justify-center group-hover:bg-primary-600/30 transition-colors">
                                <svg className="w-6 h-6 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                            </div>
                            <div className="text-left">
                                <h2 className="text-lg font-semibold text-white">画面を共有する</h2>
                                <p className="text-sm text-dark-400">ホストとして画面を配信</p>
                            </div>
                        </div>
                    </button>

                    <button
                        onClick={() => setView('viewer')}
                        className="w-full card p-6 hover:border-primary-500 transition-all duration-200 group"
                    >
                        <div className="flex items-center space-x-4">
                            <div className="w-12 h-12 rounded-full bg-primary-600/20 flex items-center justify-center group-hover:bg-primary-600/30 transition-colors">
                                <svg className="w-6 h-6 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                            </div>
                            <div className="text-left">
                                <h2 className="text-lg font-semibold text-white">画面を視聴する</h2>
                                <p className="text-sm text-dark-400">ルームコードで参加</p>
                            </div>
                        </div>
                    </button>
                </div>

                {/* 接続状態 */}
                <div className="text-center text-sm text-dark-500">
                    <div className="flex items-center justify-center space-x-2">
                        <span className={connectionState === 'connected' ? 'status-connected' : 'status-disconnected'} />
                        <span>
                            {connectionState === 'connected' ? 'サーバー接続済み' : 'サーバー未接続'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;
