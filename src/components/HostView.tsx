/**
 * P2D - ホスト画面コンポーネント
 * 
 * 画面共有を開始し、ルームコードを表示する。
 */

import { useEffect, useRef, useState } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import { QualitySettings, QualityConfig, loadQualityConfig, saveQualityConfig } from './QualitySettings';
import { ChatPanel } from './ChatPanel';
import { StatsOverlay } from './StatsOverlay';
import { VoiceChatPanel } from './VoiceChatPanel';

interface HostViewProps {
    onBack: () => void;
}

export function HostView({ onBack }: HostViewProps) {
    const {
        localStream,
        connect,
        disconnect,
        createRoom,
        startScreenShare,
        stopScreenShare,
        roomCode,
        isConnected,
        error,
        // チャット
        chatMessages,
        sendChatMessage,
        isDataChannelOpen,
        connectedPeers,
        isRemoteControlEnabled,
        toggleRemoteControl,
        stats,
        monitors,
        selectedMonitorName,
        setSelectedMonitorName,
        // ボイスチャット
        isMicEnabled,
        remoteAudioStream,
        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMuted,
        audioDevices,
        selectedDeviceId,
        setSelectedDeviceId,
        refreshAudioDevices,
        isSpeaking,
        isRemoteSpeaking,
        // 双方向画面共有
        remoteScreenStream,
    } = useWebRTC({ isHost: true });

    const videoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const [isSharing, setIsSharing] = useState(false);
    const [copied, setCopied] = useState(false);
    const [qualityConfig, setQualityConfig] = useState<QualityConfig>(loadQualityConfig);

    // シグナリングサーバーに接続（マウント時のみ）
    useEffect(() => {
        const init = async () => {
            await connect();
            // 少し待ってからルーム作成（接続完了を待つ）
            setTimeout(() => {
                if (!roomCode) {
                    createRoom('ホスト');
                }
            }, 500);
        };
        init().catch(console.error);

        return () => {
            // アンマウント時に切断（これでルームも削除される）
            disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ローカルストリームをビデオ要素にセット
    useEffect(() => {
        if (videoRef.current && localStream) {
            videoRef.current.srcObject = localStream;
        }
    }, [localStream]);

    // 相手の画面共有ストリームをビデオ要素にセット
    useEffect(() => {
        if (remoteVideoRef.current && remoteScreenStream) {
            remoteVideoRef.current.srcObject = remoteScreenStream;
        }
    }, [remoteScreenStream]);

    // 品質設定変更時にlocalStorageに保存
    const handleQualityChange = (config: QualityConfig) => {
        setQualityConfig(config);
        saveQualityConfig(config);
    };

    // 画面共有開始
    const handleStartSharing = async () => {
        // ルームがない場合は作成（念のため）
        if (!roomCode) {
            createRoom('ホスト');
        }
        await startScreenShare(qualityConfig);
        setIsSharing(true);
    };

    // 画面共有停止
    const handleStopSharing = () => {
        stopScreenShare();
        setIsSharing(false);
    };

    // ルームコードをコピー
    const handleCopyCode = async () => {
        if (roomCode) {
            await navigator.clipboard.writeText(roomCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div className="min-h-screen p-8 flex flex-col">
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-4">
                    <button onClick={onBack} className="btn-secondary">
                        ← 戻る
                    </button>
                    <h1 className="text-2xl font-bold">画面共有 - ホスト</h1>
                </div>

                <div className="flex items-center space-x-2">
                    <span className={isConnected ? 'status-connected' : 'status-disconnected'} />
                    <span className="text-sm text-dark-400">
                        {isConnected ? '接続済み' : '未接続'}
                    </span>
                </div>
            </div>

            {/* メインコンテンツ */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* プレビュー領域 */}
                <div className="lg:col-span-2">
                    <div className="card p-4 h-full">
                        <h2 className="text-lg font-semibold mb-4">プレビュー</h2>

                        <div className="relative aspect-video bg-dark-900 rounded-lg overflow-hidden">
                            {localStream ? (
                                <video
                                    ref={videoRef}
                                    autoPlay
                                    muted
                                    playsInline
                                    className="w-full h-full object-contain"
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-dark-500">
                                    <div className="text-center">
                                        <svg className="w-16 h-16 mx-auto mb-4 text-dark-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                        </svg>
                                        <p>画面共有を開始してください</p>
                                    </div>
                                </div>
                            )}

                            {remoteScreenStream && (
                                <div className="absolute bottom-4 right-4 w-64 aspect-video bg-dark-800 rounded-lg overflow-hidden border-2 border-blue-500 shadow-lg z-10">
                                    <video
                                        ref={remoteVideoRef}
                                        autoPlay
                                        playsInline
                                        muted
                                        className="w-full h-full object-contain"
                                    />
                                    <span className="absolute top-1 left-1 text-xs bg-blue-600/80 px-2 py-0.5 rounded">
                                        📺 相手の画面
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* コントロール */}
                        <div className="mt-4 flex justify-center space-x-4">
                            {!isSharing ? (
                                <button
                                    onClick={handleStartSharing}
                                    disabled={!isConnected}
                                    className="btn-primary px-8 py-3 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    🖥️ 画面共有を開始
                                </button>
                            ) : (
                                <button
                                    onClick={handleStopSharing}
                                    className="btn-danger px-8 py-3 text-lg"
                                >
                                    ⏹️ 共有を停止
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* サイドパネル */}
                <div className="space-y-6">
                    {/* 品質設定 */}
                    <QualitySettings
                        config={qualityConfig}
                        onChange={handleQualityChange}
                        disabled={isSharing}
                    />

                    {/* ルームコード */}
                    <div className="card p-6">
                        <h2 className="text-lg font-semibold mb-4">接続情報</h2>

                        {roomCode ? (
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm text-dark-400 mb-2">ルームコード</label>
                                    <div className="flex items-center space-x-2">
                                        <div className="flex-1 flex space-x-1">
                                            {roomCode.split('').map((char, i) => (
                                                <div
                                                    key={i}
                                                    className="w-10 h-12 flex items-center justify-center bg-dark-700 rounded-lg text-xl font-mono font-bold text-primary-400"
                                                >
                                                    {char}
                                                </div>
                                            ))}
                                        </div>
                                        <button
                                            onClick={handleCopyCode}
                                            className="btn-secondary p-3"
                                            title="コピー"
                                        >
                                            {copied ? '✓' : '📋'}
                                        </button>
                                    </div>
                                </div>

                                <p className="text-sm text-dark-500">
                                    このコードを視聴者に共有してください
                                </p>
                            </div>
                        ) : (
                            <p className="text-dark-500">
                                画面共有を開始するとルームコードが生成されます
                            </p>
                        )}
                    </div>

                    {/* 接続中のビューア */}
                    <div className="card p-6">
                        <h2 className="text-lg font-semibold mb-4">接続中のユーザー ({connectedPeers.length})</h2>

                        {connectedPeers.length > 0 ? (
                            <ul className="space-y-2">
                                {connectedPeers.map((peerId, i) => (
                                    <li key={peerId} className="flex items-center justify-between p-2 bg-dark-700 rounded-lg">
                                        <div className="flex items-center space-x-2">
                                            <span className="status-connected" />
                                            <div className="flex flex-col">
                                                <span className="text-sm">ビューア {i + 1}</span>
                                                <span className="text-xs text-dark-400">ID: ...{peerId.slice(-4)}</span>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-dark-500 text-sm">
                                まだ誰も接続していません
                            </p>
                        )}
                    </div>

                    {/* リモート操作設定 */}
                    <div className="card p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-semibold">リモート操作</h2>
                                <p className="text-sm text-dark-400">操作権限をビューアに与える</p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={isRemoteControlEnabled}
                                    onChange={toggleRemoteControl}
                                    className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-dark-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500"></div>
                            </label>
                        </div>

                        {isRemoteControlEnabled && monitors.length > 1 && (
                            <div className="pt-2 border-t border-dark-700">
                                <label className="block text-[10px] uppercase tracking-wider text-dark-400 mb-1">Target Monitor</label>
                                <select
                                    className="w-full bg-dark-900 border border-white/10 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
                                    value={selectedMonitorName || ''}
                                    onChange={(e) => setSelectedMonitorName(e.target.value)}
                                >
                                    {monitors.map(m => (
                                        <option key={m.name} value={m.name}>
                                            {m.name} ({m.width}x{m.height})
                                        </option>
                                    ))}
                                </select>
                                <p className="mt-1 text-[10px] text-dark-500">
                                    操作がズレる場合は共有中のモニターを選択してください
                                </p>
                            </div>
                        )}
                    </div>

                    {/* エラー表示 */}
                    {error && (
                        <div className="card p-4 bg-red-900/20 border-red-800">
                            <p className="text-red-400">{error}</p>
                        </div>
                    )}

                    {/* ボイスチャット */}
                    <VoiceChatPanel
                        isMicEnabled={isMicEnabled}
                        isMuted={isMuted}
                        remoteAudioStream={remoteAudioStream}
                        onStartMic={startMicrophone}
                        onStopMic={stopMicrophone}
                        onToggleMute={toggleMute}
                        audioDevices={audioDevices}
                        selectedDeviceId={selectedDeviceId}
                        onSelectDevice={setSelectedDeviceId}
                        onRefreshDevices={refreshAudioDevices}
                        isSpeaking={isSpeaking}
                        isRemoteSpeaking={isRemoteSpeaking}
                    />

                    {/* チャット */}
                    <ChatPanel
                        messages={chatMessages}
                        onSendMessage={sendChatMessage}
                        isConnected={isDataChannelOpen}
                        isHost={true}
                    />
                </div>
            </div>

            <StatsOverlay stats={stats} />
        </div >
    );
}
