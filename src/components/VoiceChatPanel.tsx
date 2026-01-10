/**
 * P2D - ボイスチャットパネル
 * 
 * マイクのON/OFF、ミュート、リモート音声再生を管理
 */

import { useEffect, useRef } from 'react';

interface VoiceChatPanelProps {
    isMicEnabled: boolean;
    isMuted: boolean;
    remoteAudioStream: MediaStream | null;
    onStartMic: () => void;
    onStopMic: () => void;
    onToggleMute: () => void;
}

export function VoiceChatPanel({
    isMicEnabled,
    isMuted,
    remoteAudioStream,
    onStartMic,
    onStopMic,
    onToggleMute
}: VoiceChatPanelProps) {
    const audioRef = useRef<HTMLAudioElement>(null);

    // リモート音声ストリームをaudio要素にセット
    useEffect(() => {
        if (audioRef.current && remoteAudioStream) {
            audioRef.current.srcObject = remoteAudioStream;
        }
    }, [remoteAudioStream]);

    return (
        <div className="card p-4">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                🎤 ボイスチャット
                {remoteAudioStream && (
                    <span className="text-xs text-green-400 animate-pulse">● 受信中</span>
                )}
            </h2>

            <div className="flex items-center gap-2">
                {!isMicEnabled ? (
                    <button
                        onClick={onStartMic}
                        className="btn-primary flex items-center gap-2 px-4 py-2"
                    >
                        🎙️ マイクON
                    </button>
                ) : (
                    <>
                        <button
                            onClick={onStopMic}
                            className="btn-danger flex items-center gap-2 px-4 py-2"
                        >
                            ⏹️ 停止
                        </button>
                        <button
                            onClick={onToggleMute}
                            className={`px-4 py-2 rounded-lg transition-colors ${isMuted
                                    ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                                    : 'bg-dark-600 hover:bg-dark-500 text-dark-200'
                                }`}
                        >
                            {isMuted ? '🔇 ミュート中' : '🔊 ミュート'}
                        </button>
                    </>
                )}
            </div>

            {/* リモート音声再生用（非表示） */}
            <audio ref={audioRef} autoPlay playsInline />
        </div>
    );
}
