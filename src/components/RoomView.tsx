/**
 * P2D - Room View (Full Mesh P2P)
 * 
 * 統合されたルーム画面。
 * 入室前の選択画面と、入室後のビデオグリッド画面を含む。
 */

import { useState, useRef, useEffect } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import { ChatPanel } from './ChatPanel';

// ビデオグリッドアイテム
function VideoGridItem({
    stream,
    label,
    isLocal = false
}: {
    stream?: MediaStream | null;
    label?: string;
    isLocal?: boolean;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    return (
        <div className="relative aspect-video glass-card overflow-hidden group">
            {stream ? (
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={isLocal} // 自分の音声はミュート（ハウリング防止）
                    className="w-full h-full object-cover"
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-white/5 text-gray-500">
                    <span className="text-sm">No Signal</span>
                </div>
            )}

            {/* Label Overlay */}
            <div className="absolute bottom-3 left-3 px-3 py-1 rounded-full bg-black/60 backdrop-blur text-xs font-bold text-white border border-white/10 flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${stream ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}></div>
                {label || 'Unknown'}
                {isLocal && <span className="text-cyan-400 text-[10px] ml-1">(YOU)</span>}
            </div>
        </div>
    );
}

import type { TurnConfig } from '../hooks/useWebRTC';

export function RoomView({ onLeave, signalingUrl, turnConfig }: { onLeave: () => void; signalingUrl?: string; turnConfig?: TurnConfig }) {
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
        stopScreenShare,
        isScreenSharing,
        chatMessages,
        sendChatMessage,
        // Microphone
        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMicEnabled,
        isMuted,
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
    } = useWebRTC({ signalingUrl, turnConfig });

    // 入力ステート
    const [inputCode, setInputCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [mode, setMode] = useState<'menu' | 'join' | 'create'>('menu');
    const [showSettings, setShowSettings] = useState(false);

    // Effect: 初回にオーディオデバイス取得
    useEffect(() => {
        refreshAudioDevices();
    }, [refreshAudioDevices]);

    // クリーンアップ
    useEffect(() => {
        return () => {
            // コンポーネント破棄時に退出
            // leaveRoom(); // useWebRTC内でuseEffect cleanupしてるので不要かもだが念の為
        };
    }, []);

    // 退出ハンドラ
    const handleLeave = () => {
        leaveRoom();
        onLeave();
    };

    // --- 未接続時 (メニュー画面) ---
    if (!isConnected) {
        return (
            <div className="min-h-screen flex items-center justify-center p-8 relative overflow-hidden">
                {/* Backボタン: ダイアログモード時のみ表示 */}
                {mode !== 'menu' && (
                    <button
                        onClick={() => setMode('menu')}
                        className="absolute top-8 left-8 text-gray-400 hover:text-white flex items-center gap-2 transition-colors z-50"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        Back
                    </button>
                )}

                <div className="max-w-md w-full z-10 animate-fade-in">
                    <h1 className="text-5xl font-black text-center mb-12 text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400 drop-shadow-[0_0_15px_rgba(0,240,255,0.3)]">
                        P2D ROOM
                    </h1>

                    {mode === 'menu' && (
                        <div className="grid grid-cols-1 gap-4">
                            <button
                                onClick={() => setMode('create')}
                                className="glass-card p-6 text-left hover:border-cyan-500/50 hover:bg-cyan-500/10 transition-all group"
                            >
                                <h3 className="text-xl font-bold text-white mb-1 group-hover:text-cyan-400">Create Room</h3>
                                <p className="text-sm text-gray-400">Start a new session and share connection code.</p>
                            </button>
                            <button
                                onClick={() => setMode('join')}
                                className="glass-card p-6 text-left hover:border-purple-500/50 hover:bg-purple-500/10 transition-all group"
                            >
                                <h3 className="text-xl font-bold text-white mb-1 group-hover:text-purple-400">Join Room</h3>
                                <p className="text-sm text-gray-400">Connect to an existing session using a code.</p>
                            </button>
                        </div>
                    )}

                    {mode === 'create' && (
                        <div className="glass-card p-8 animate-slide-up">
                            <h2 className="text-xl font-bold text-white mb-6">Create New Room</h2>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-cyan-400 font-bold uppercase tracking-wider block mb-2">Your Name</label>
                                    <input
                                        type="text"
                                        value={displayName}
                                        onChange={e => setDisplayName(e.target.value)}
                                        className="input w-full"
                                        placeholder="Enter your name"
                                    />
                                </div>
                                <div className="flex gap-4 pt-4">
                                    <button onClick={() => setMode('menu')} className="btn-secondary flex-1">Cancel</button>
                                    <button
                                        onClick={() => createRoom(displayName)}
                                        className="btn-primary flex-1"
                                        disabled={!displayName.trim()}
                                    >
                                        Create
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {mode === 'join' && (
                        <div className="glass-card p-8 animate-slide-up">
                            <h2 className="text-xl font-bold text-white mb-6">Join Existing Room</h2>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-purple-400 font-bold uppercase tracking-wider block mb-2">Room Code</label>
                                    <input
                                        type="text"
                                        value={inputCode}
                                        onChange={e => setInputCode(e.target.value.toUpperCase())}
                                        className="input w-full text-center tracking-widest font-mono text-lg"
                                        placeholder="XXXXXX"
                                        maxLength={6}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-purple-400 font-bold uppercase tracking-wider block mb-2">Your Name</label>
                                    <input
                                        type="text"
                                        value={displayName}
                                        onChange={e => setDisplayName(e.target.value)}
                                        className="input w-full"
                                        placeholder="Enter your name"
                                    />
                                </div>
                                <div className="flex gap-4 pt-4">
                                    <button onClick={() => setMode('menu')} className="btn-secondary flex-1">Cancel</button>
                                    <button
                                        onClick={() => joinRoom(inputCode, displayName)}
                                        className="btn-secondary flex-1"
                                        disabled={!inputCode.trim() || !displayName.trim()}
                                    >
                                        Join
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // --- 接続済み (ルーム画面) ---
    return (
        <div className="fixed inset-0 w-full h-full flex flex-col bg-[#0a0a12] overflow-hidden z-50">
            {/* Background Effects */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-cyan-500/5 rounded-full blur-[120px]"></div>
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-purple-500/5 rounded-full blur-[120px]"></div>
            </div>

            {/* Top Bar */}
            <div className="h-16 px-6 flex items-center justify-between border-b border-white/5 bg-black/20 backdrop-blur z-20">
                <div className="flex items-center gap-4">
                    <h1 className="text-xl font-black tracking-tight text-white">P2D <span className="text-cyan-400 font-light">ROOM</span></h1>
                    <div className="h-6 w-px bg-white/10 mx-2"></div>
                    <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-lg border border-white/5 hover:border-white/20 transition-colors group cursor-copy"
                        onClick={() => { navigator.clipboard.writeText(roomCode || ''); }}
                        title="Copy Room Code">
                        <span className="text-xs text-gray-400 uppercase tracking-wider font-bold">CODE:</span>
                        <span className="font-mono font-bold text-white tracking-widest">{roomCode}</span>
                        <svg className="w-3.5 h-3.5 text-gray-500 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    {/* Connection Quality Indicator */}
                    {connectionQuality && (
                        <div className="relative group">
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all cursor-default ${connectionQuality.qualityLevel === 'excellent' ? 'bg-green-500/10 border-green-500/30 text-green-400' :
                                connectionQuality.qualityLevel === 'good' ? 'bg-lime-500/10 border-lime-500/30 text-lime-400' :
                                    connectionQuality.qualityLevel === 'fair' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' :
                                        'bg-red-500/10 border-red-500/30 text-red-400'
                                }`}>
                                <div className="flex gap-0.5">
                                    {[1, 2, 3, 4].map(i => (
                                        <div key={i} className={`w-1 rounded-full transition-all ${(connectionQuality.qualityLevel === 'excellent' && i <= 4) ||
                                            (connectionQuality.qualityLevel === 'good' && i <= 3) ||
                                            (connectionQuality.qualityLevel === 'fair' && i <= 2) ||
                                            (connectionQuality.qualityLevel === 'poor' && i <= 1)
                                            ? 'opacity-100' : 'opacity-20'
                                            }`} style={{ height: `${i * 3 + 4}px`, backgroundColor: 'currentColor' }} />
                                    ))}
                                </div>
                                <span className="text-[10px] font-bold uppercase">{connectionQuality.qualityLevel}</span>
                            </div>
                            {/* Tooltip */}
                            <div className="absolute top-full right-0 mt-2 p-3 bg-black/90 backdrop-blur border border-white/10 rounded-lg text-xs opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 whitespace-nowrap">
                                <div className="space-y-1.5">
                                    <div className="flex justify-between gap-4">
                                        <span className="text-gray-400">Connection</span>
                                        <span className={`font-mono font-bold ${connectionQuality.candidateType === 'relay' ? 'text-orange-400' : 'text-green-400'}`}>
                                            {connectionQuality.candidateType === 'relay' ? 'TURN Relay' : connectionQuality.candidateType === 'srflx' ? 'STUN' : 'Direct'}
                                        </span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-gray-400">RTT</span>
                                        <span className="font-mono text-white">{connectionQuality.rtt}ms</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-gray-400">Bitrate</span>
                                        <span className="font-mono text-white">{connectionQuality.outboundBitrate} kbps</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-gray-400">Packet Loss</span>
                                        <span className="font-mono text-white">{connectionQuality.packetLoss}%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_#22c55e]"></span>
                        <span className="text-xs font-bold text-gray-300">{participants.size + 1} ONLINE</span>
                    </div>
                    <button
                        onClick={handleLeave}
                        className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:text-white transition-all text-sm font-bold flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        LEAVE
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden relative z-10">

                {/* Left Sidebar (Participants & Chat) */}
                <div className="w-80 border-r border-white/5 bg-black/20 backdrop-blur flex flex-col">
                    {/* Participants List */}
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4">Participants</h3>
                        <div className="space-y-2">
                            {/* Me */}
                            <div className={`p-3 rounded-lg bg-white/5 border flex items-center gap-3 transition-all duration-300 ${isSpeaking ? 'border-green-500/50 bg-green-500/5' : 'border-white/5'}`}>
                                <div className={`relative w-8 h-8 rounded-full flex items-center justify-center font-bold border transition-all duration-300 ${isSpeaking ? 'bg-green-500/30 text-green-400 border-green-500/50 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30'}`}>
                                    {isSpeaking && (
                                        <div className="absolute inset-0 rounded-full border-2 border-green-500 animate-ping opacity-75"></div>
                                    )}
                                    {(participants.get(myId || '')?.name?.[0] || 'Me')[0].toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-white truncate">{participants.get(myId || '')?.name || 'Me'} <span className="text-gray-500 text-xs font-normal">(You)</span></div>
                                    <div className="text-[10px] text-gray-500">ID: {myId?.slice(0, 8)}...</div>
                                </div>
                                {isSpeaking && (
                                    <div className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30 animate-pulse">SPEAKING</div>
                                )}
                                {isScreenSharing && (
                                    <div className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">LIVE</div>
                                )}
                            </div>

                            {/* Others */}
                            {Array.from(participants).map(([id, info]) => {
                                if (id === myId) return null;
                                const peerSpeaking = remoteSpeakingStates.get(id) || false;
                                return (
                                    <div key={id} className={`p-3 rounded-lg border flex items-center gap-3 transition-all duration-300 ${peerSpeaking ? 'bg-green-500/5 border-green-500/50' : 'hover:bg-white/5 border-transparent hover:border-white/10'}`}>
                                        <div className={`relative w-8 h-8 rounded-full flex items-center justify-center font-bold border transition-all duration-300 ${peerSpeaking ? 'bg-green-500/30 text-green-400 border-green-500/50 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'bg-purple-500/20 text-purple-400 border-purple-500/30'}`}>
                                            {peerSpeaking && (
                                                <div className="absolute inset-0 rounded-full border-2 border-green-500 animate-ping opacity-75"></div>
                                            )}
                                            {(info.name || 'User')[0].toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-gray-200 truncate">{info.name || 'User'}</div>
                                            <div className="text-[10px] text-gray-600">ID: {id.slice(0, 8)}...</div>
                                        </div>
                                        {peerSpeaking && (
                                            <div className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30 animate-pulse">SPEAKING</div>
                                        )}
                                        {remoteStreams.has(id) && (
                                            <div className="text-[10px] bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded border border-cyan-500/30">VIDEO</div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Chat Panel (Integrated) */}
                    <div className="h-1/2 min-h-[300px] border-t border-white/5 relative">
                        <div className="absolute inset-0">
                            <ChatPanel
                                messages={chatMessages}
                                onSendMessage={sendChatMessage}
                                isConnected={isConnected}
                                myId={myId}
                                className="h-full !rounded-none !bg-transparent border-none"
                            />
                        </div>
                    </div>
                </div>

                {/* Video Grid Area */}
                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-fr">
                        {/* My Stream */}
                        {localStream && (
                            <VideoGridItem
                                stream={localStream}
                                label={participants.get(myId || '')?.name || 'Me'}
                                isLocal={true}
                            />
                        )}

                        {/* Remote Streams */}
                        {Array.from(remoteStreams).map(([peerId, stream]) => (
                            <VideoGridItem
                                key={peerId}
                                stream={stream}
                                label={participants.get(peerId)?.name || peerId}
                            />
                        ))}

                        {/* Empty State if no streams */}
                        {!localStream && remoteStreams.size === 0 && (
                            <div className="col-span-full h-96 flex flex-col items-center justify-center text-gray-500 border-2 border-dashed border-white/5 rounded-2xl bg-black/10">
                                <svg className="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                <p className="text-xl font-bold opacity-50">No Active Video Streams</p>
                                <p className="text-sm mt-2 opacity-50">Start sharing your screen or wait for others to join.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="h-20 bg-black/40 backdrop-blur-md border-t border-white/10 px-8 flex items-center justify-center gap-4 z-20">
                <button
                    onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
                    className={`h-12 px-6 rounded-full font-bold text-sm flex items-center gap-3 transition-all ${isScreenSharing
                        ? 'bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] hover:bg-red-600'
                        : 'bg-white/10 text-white hover:bg-white/20 border border-white/10 hover:border-white/30'
                        }`}
                >
                    {isScreenSharing ? (
                        <>
                            <svg className="w-5 h-5 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
                            STOP SHARING
                        </>
                    ) : (
                        <>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            SHARE SCREEN
                        </>
                    )}
                </button>

                {/* Mic/Audio controls */}
                <div className="h-12 w-px bg-white/10 mx-2"></div>

                {/* Microphone Toggle */}
                <button
                    onClick={() => isMicEnabled ? stopMicrophone() : startMicrophone()}
                    className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${isMicEnabled
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30'
                        : 'bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10'
                        }`}
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
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${isMuted
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30'
                            : 'bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10'
                            }`}
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

                {/* Settings Button */}
                <button
                    onClick={() => setShowSettings(true)}
                    className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                    title="設定"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                </button>
            </div>

            {/* Settings Modal */}
            {showSettings && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
                    <div className="glass-card p-8 max-w-md w-full border-cyan-500/30 shadow-[0_0_50px_rgba(0,0,0,0.5)] animate-slide-up">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-bold text-white">Room Settings</h2>
                            <button
                                onClick={() => setShowSettings(false)}
                                className="text-gray-400 hover:text-white transition-colors"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="space-y-6">
                            {/* Audio Device Selection */}
                            <div>
                                <label className="block text-sm font-medium text-cyan-400 mb-2">Microphone</label>
                                <select
                                    value={selectedDeviceId || ''}
                                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                                    className="input w-full bg-black/50 border-white/10 focus:border-cyan-500/50"
                                >
                                    {audioDevices.length === 0 ? (
                                        <option value="">No audio devices found</option>
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
                                    className="mt-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                                >
                                    ↻ Refresh Devices
                                </button>
                            </div>

                            {/* Microphone Status */}
                            <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-gray-300">Microphone Status</span>
                                    <span className={`px-2 py-1 rounded text-xs font-bold ${isMicEnabled
                                        ? (isMuted ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400')
                                        : 'bg-gray-500/20 text-gray-400'
                                        }`}>
                                        {isMicEnabled ? (isMuted ? 'MUTED' : 'ACTIVE') : 'OFF'}
                                    </span>
                                </div>
                            </div>

                            {/* Advanced Settings */}
                            <div className="pt-4 border-t border-white/10">
                                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Advanced Settings</h4>

                                {/* Adaptive Mode Toggle */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-sm font-medium text-cyan-400">Adaptive Bitrate</div>
                                        <div className="text-xs text-gray-500">Automatically adjust quality based on network</div>
                                    </div>
                                    <button
                                        onClick={() => setAdaptiveModeEnabled(!isAdaptiveModeEnabled)}
                                        className={`w-12 h-6 rounded-full p-1 transition-colors ${isAdaptiveModeEnabled ? 'bg-cyan-500/20 border border-cyan-500/50' : 'bg-white/5 border border-white/10'
                                            }`}
                                    >
                                        <div className={`w-4 h-4 rounded-full transition-transform ${isAdaptiveModeEnabled ? 'translate-x-6 bg-cyan-400' : 'translate-x-0 bg-gray-500'
                                            }`} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end pt-6 mt-6 border-t border-white/10">
                            <button
                                onClick={() => setShowSettings(false)}
                                className="btn-primary px-6 py-2"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>

    );
}
