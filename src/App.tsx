import { useState, useEffect } from 'react';
import { useConnectionStore } from './stores/connectionStore';
import { RoomView } from './components/RoomView';

function App() {
    const { connectionState } = useConnectionStore();

    // 設定
    const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';
    const [showSettings, setShowSettings] = useState(false);
    const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);

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
        <div className="min-h-screen bg-black text-white relative font-sans">
            {/* 設定ボタン (未接続時のみ表示) */}
            {connectionState === 'disconnected' && (
                <button
                    onClick={() => setShowSettings(true)}
                    className="fixed top-6 right-6 p-3 rounded-full bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-all duration-300 backdrop-blur-sm z-50 group"
                    title="設定"
                >
                    <svg className="w-6 h-6 group-hover:rotate-90 transition-transform duration-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                </button>
            )}

            {/* 設定モーダル */}
            {showSettings && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
                    <div className="glass-card p-8 max-w-md w-full border-cyan-500/30 shadow-[0_0_50px_rgba(0,0,0,0.5)] animate-slide-up transform transition-all">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-bold text-white text-glow">Settings</h2>
                            <button
                                onClick={() => setShowSettings(false)}
                                className="text-gray-400 hover:text-white transition-colors"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="space-y-6">
                            {/* Signaling Server */}
                            <div>
                                <label className="block text-sm font-medium text-cyan-400 mb-2">Signaling Server URL</label>
                                <input
                                    type="text"
                                    value={signalingUrl}
                                    onChange={(e) => setSignalingUrl(e.target.value)}
                                    className="input w-full bg-black/50 border-white/10 focus:border-cyan-500/50"
                                    placeholder="ws://localhost:8080"
                                />
                                <p className="mt-2 text-xs text-gray-500">
                                    Local: <span className="font-mono text-gray-400">ws://localhost:8080</span> |
                                    LAN: <span className="font-mono text-gray-400">ws://192.168.x.x:8080</span>
                                </p>
                            </div>

                            {/* TURN Server */}
                            <div className="pt-4 border-t border-white/5">
                                <label className="block text-sm font-medium text-purple-400 mb-2">TURN Server (Optional)</label>
                                <p className="text-xs text-gray-500 mb-3">
                                    NAT越えが必要な場合に設定。自前のサーバーまたはTwilio等のサービスを使用。
                                </p>
                                <input
                                    type="text"
                                    value={turnUrl}
                                    onChange={(e) => setTurnUrl(e.target.value)}
                                    className="input w-full bg-black/50 border-white/10 focus:border-purple-500/50 mb-2"
                                    placeholder="turn:example.com:3478"
                                />
                                <div className="grid grid-cols-2 gap-2">
                                    <input
                                        type="text"
                                        value={turnUsername}
                                        onChange={(e) => setTurnUsername(e.target.value)}
                                        className="input bg-black/50 border-white/10 focus:border-purple-500/50"
                                        placeholder="Username"
                                    />
                                    <input
                                        type="password"
                                        value={turnCredential}
                                        onChange={(e) => setTurnCredential(e.target.value)}
                                        className="input bg-black/50 border-white/10 focus:border-purple-500/50"
                                        placeholder="Credential"
                                    />
                                </div>
                                {turnUrl && (
                                    <div className="mt-2 text-xs text-green-400 flex items-center gap-1">
                                        <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                                        TURN server configured
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-4 pt-8 border-t border-white/5">
                            <button
                                onClick={resetSettings}
                                className="px-4 py-2.5 rounded-lg text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors border border-transparent hover:border-red-500/20"
                            >
                                Reset to Default
                            </button>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setShowSettings(false)}
                                    className="px-5 py-2.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors border border-white/10"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={saveSettings}
                                    className="btn-primary px-6 py-2.5 text-sm"
                                >
                                    Save & Reload
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Main Room View */}
            {/* useWebRTCにoptionsとしてURLを渡すために、RoomView経由ではなくContext経由か、
               あるいは useWebRTC の呼び出し側で inject する必要があるが、
               RoomView 内部で useWebRTC を呼んでいるため、今のままでは渡せない。
               
               修正案: RoomView に props で url を渡し、RoomView 内部で useWebRTC({ signalingUrl: props.url }) する。
               RoomViewの修正漏れがあったので、次のステップで修正する。
               ここでは一旦、URLを渡さずにレンダリングする（デフォルトURLで動作させる）。
            */}
            {/* Passed signalingUrl and turnConfig props */}
            <RoomView onLeave={() => { }} signalingUrl={signalingUrl} turnConfig={turnConfig} />

            <div className="fixed bottom-4 left-0 w-full text-center pointer-events-none z-0 opacity-50">
                <div className="text-[10px] text-gray-600 font-mono tracking-widest">
                    P2D v0.2.0 (Full Mesh Beta)
                </div>
            </div>
        </div>
    );
}

export default App;
