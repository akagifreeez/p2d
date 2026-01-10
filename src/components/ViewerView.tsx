/**
 * P2D - ビューア画面コンポーネント
 * 
 * ルームコードを入力してホストの画面を視聴する。
 */

import { useEffect, useRef, useState } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import { useConnectionStore } from '../stores/connectionStore';
import { ChatPanel } from './ChatPanel';
import { StatsOverlay } from './StatsOverlay';
import { VoiceChatPanel } from './VoiceChatPanel';

interface ViewerViewProps {
    onBack: () => void;
}

export function ViewerView({ onBack }: ViewerViewProps) {
    const {
        remoteStream,
        connect,
        disconnect,
        joinRoom,
        isConnected,
        error,
        // peerConnection,
        // チャット
        chatMessages,
        sendChatMessage,
        sendData,
        isDataChannelOpen,
        stats,
        setPlayoutDelay,
        // ボイスチャット
        isMicEnabled,
        remoteAudioStream,
        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMuted,
    } = useWebRTC({ isHost: false });

    const { connectionState } = useConnectionStore();

    const videoRef = useRef<HTMLVideoElement>(null);
    const [roomCodeInput, setRoomCodeInput] = useState(['', '', '', '', '', '']);
    const [isJoining, setIsJoining] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isStableMode, setIsStableMode] = useState(false); // 安定モード
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    // シグナリングサーバーに接続（マウント時のみ）
    useEffect(() => {
        connect().catch(console.error);
        return () => disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // リモートストリームをビデオ要素にセット
    useEffect(() => {
        if (videoRef.current && remoteStream) {
            videoRef.current.srcObject = remoteStream;
        }
    }, [remoteStream]);

    // ルームコード入力ハンドラ
    const handleCodeInput = (index: number, value: string) => {
        const char = value.toUpperCase().slice(-1);

        if (!/^[A-Z0-9]?$/.test(char)) return;

        const newCode = [...roomCodeInput];
        newCode[index] = char;
        setRoomCodeInput(newCode);

        // 次の入力フィールドにフォーカス
        if (char && index < 5) {
            inputRefs.current[index + 1]?.focus();
        }
    };

    // バックスペース処理
    const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && !roomCodeInput[index] && index > 0) {
            inputRefs.current[index - 1]?.focus();
        }
    };

    // ペースト処理
    const handlePaste = (e: React.ClipboardEvent) => {
        e.preventDefault();
        const pastedText = e.clipboardData.getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        const newCode = [...roomCodeInput];
        for (let i = 0; i < pastedText.length; i++) {
            newCode[i] = pastedText[i];
        }
        setRoomCodeInput(newCode);

        // 最後の入力フィールドにフォーカス
        const lastIndex = Math.min(pastedText.length, 5);
        inputRefs.current[lastIndex]?.focus();
    };

    // ルームに参加
    const handleJoin = () => {
        const code = roomCodeInput.join('');
        if (code.length === 6) {
            setIsJoining(true);
            joinRoom(code);
        }
    };

    // フルスクリーン切替
    const toggleFullscreen = async () => {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
            setIsFullscreen(true);
        } else {
            setIsFullscreen(false);
        }
    };

    // リモート操作イベントハンドラ
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isDataChannelOpen) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;

        // 頻繁に送りすぎないようにスロットリングが必要だが、一旦そのまま送信
        sendData('input:mouse_move', { x, y });
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isDataChannelOpen) return;
        const button = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
        sendData('input:click', { button });
    };

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (!isDataChannelOpen) return;
        sendData('input:scroll', { deltaX: e.deltaX, deltaY: e.deltaY });
    };

    const handleRemoteKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!isDataChannelOpen) return;
        // 特殊キーの処理が必要だが、今回は簡易実装
        if (e.key.length === 1) {
            sendData('input:key', { key: e.key });
        }
    };

    // 視聴中かどうか
    const isWatching = remoteStream !== null;
    const codeComplete = roomCodeInput.every(c => c !== '');

    return (
        <div className="min-h-screen p-8 flex flex-col">
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-4">
                    <button onClick={onBack} className="btn-secondary">
                        ← 戻る
                    </button>
                    <h1 className="text-2xl font-bold">画面共有 - ビューア</h1>
                </div>

                <div className="flex items-center space-x-2">
                    <span className={isConnected ? 'status-connected' : 'status-disconnected'} />
                    <span className="text-sm text-dark-400">
                        {connectionState === 'peer-connected' ? '視聴中' :
                            connectionState === 'peer-connecting' ? '接続中...' :
                                isConnected ? '接続済み' : '未接続'}
                    </span>
                </div>
            </div>

            {/* メインコンテンツ */}
            {!isWatching ? (
                // 接続画面
                <div className="flex-1 flex items-center justify-center">
                    <div className="card p-8 max-w-md w-full">
                        <h2 className="text-xl font-semibold text-center mb-6">
                            ルームコードを入力
                        </h2>

                        {/* コード入力 */}
                        <div className="flex justify-center space-x-2 mb-6" onPaste={handlePaste}>
                            {roomCodeInput.map((char, i) => (
                                <input
                                    key={i}
                                    ref={el => inputRefs.current[i] = el}
                                    type="text"
                                    maxLength={1}
                                    value={char}
                                    onChange={(e) => handleCodeInput(i, e.target.value)}
                                    onKeyDown={(e) => handleKeyDown(i, e)}
                                    className="room-code-input"
                                    disabled={isJoining}
                                />
                            ))}
                        </div>

                        {/* 接続ボタン */}
                        <button
                            onClick={handleJoin}
                            disabled={!codeComplete || !isConnected || isJoining}
                            className="w-full btn-primary py-3 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isJoining ? '接続中...' : '🔌 接続する'}
                        </button>

                        {/* エラー表示 */}
                        {error && (
                            <div className="mt-4 p-4 bg-red-900/20 border border-red-800 rounded-lg">
                                <p className="text-red-400 text-sm">{error}</p>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                // 視聴画面
                <div className="flex-1 flex flex-col">
                    {/* ビデオ */}
                    <div className="flex-1 relative bg-black rounded-lg overflow-hidden">
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            className="w-full h-full object-contain"
                        />

                        {/* 操作オーバーレイ */}
                        <div
                            className="absolute inset-0 cursor-crosshair z-10"
                            onMouseMove={handleMouseMove}
                            onMouseDown={handleMouseDown}
                            onWheel={handleWheel}
                            onKeyDown={handleRemoteKeyDown}
                            onContextMenu={(e) => e.preventDefault()}
                            tabIndex={0} // キーイベントを受け取るために必要
                            style={{ outline: 'none' }}
                        />

                        {/* オーバーレイコントロール */}
                        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-20 pointer-events-none">
                            <div className="flex items-center justify-between pointer-events-auto">
                                {/* 統計情報 (StatsOverlayに移行) */}
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/80">
                                </div>

                                {/* コントロールボタン */}
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => {
                                            const newMode = !isStableMode;
                                            setIsStableMode(newMode);
                                            setPlayoutDelay(newMode ? 0.5 : 0);
                                        }}
                                        className={`px-3 py-1 rounded-lg text-sm transition-colors flex items-center gap-2 ${isStableMode
                                            ? 'bg-green-500/80 text-white'
                                            : 'bg-white/10 hover:bg-white/20 text-white/90'
                                            }`}
                                        title={isStableMode ? "現在: 安定モード (バッファ優先)" : "現在: 低遅延モード"}
                                    >
                                        {isStableMode ? '🐢 安定' : '⚡ 低遅延'}
                                    </button>

                                    <button
                                        onClick={toggleFullscreen}
                                        className="p-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
                                        title={isFullscreen ? '全画面解除' : '全画面'}
                                    >
                                        {isFullscreen ? '⛶' : '⛶'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ボイスチャット + チャット（フローティング） */}
            {isWatching && (
                <div className="fixed bottom-4 right-4 w-80 z-50 space-y-2">
                    <VoiceChatPanel
                        isMicEnabled={isMicEnabled}
                        isMuted={isMuted}
                        remoteAudioStream={remoteAudioStream}
                        onStartMic={startMicrophone}
                        onStopMic={stopMicrophone}
                        onToggleMute={toggleMute}
                    />
                    <ChatPanel
                        messages={chatMessages}
                        onSendMessage={sendChatMessage}
                        isConnected={isDataChannelOpen}
                        isHost={false}
                    />
                </div>
            )}

            <StatsOverlay stats={stats} />
        </div>
    );
}
