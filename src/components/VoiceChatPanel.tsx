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
    // マイクデバイス選択
    audioDevices: MediaDeviceInfo[];
    selectedDeviceId: string | null;
    onSelectDevice: (deviceId: string) => void;
    onRefreshDevices: () => void;
    // 発話インジケーター
    isSpeaking: boolean;
    isRemoteSpeaking: boolean;
}

export function VoiceChatPanel({
    isMicEnabled,
    isMuted,
    remoteAudioStream,
    onStartMic,
    onStopMic,
    onToggleMute,
    audioDevices,
    selectedDeviceId,
    onSelectDevice,
    onRefreshDevices,
    isSpeaking,
    isRemoteSpeaking
}: VoiceChatPanelProps) {
    const audioRef = useRef<HTMLAudioElement>(null);

    // リモート音声ストリームをaudio要素にセット
    useEffect(() => {
        if (audioRef.current && remoteAudioStream) {
            audioRef.current.srcObject = remoteAudioStream;
        }
    }, [remoteAudioStream]);

    // マイクON前にデバイス一覧を取得
    const handleStartMic = async () => {
        if (audioDevices.length === 0) {
            await onRefreshDevices();
        }
        onStartMic();
    };

    return (
        <div className="card p-4">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                🎤 ボイスチャット
            </h2>

            {/* 発話インジケーター */}
            {(isMicEnabled || remoteAudioStream) && (
                <div className="mb-3 flex flex-col gap-1 text-sm">
                    {isMicEnabled && (
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-green-400 animate-pulse' : 'bg-dark-500'}`} />
                            <span className={isSpeaking ? 'text-green-400' : 'text-dark-400'}>
                                あなた {isSpeaking ? '(発話中)' : ''}
                            </span>
                        </div>
                    )}
                    {remoteAudioStream && (
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${isRemoteSpeaking ? 'bg-blue-400 animate-pulse' : 'bg-dark-500'}`} />
                            <span className={isRemoteSpeaking ? 'text-blue-400' : 'text-dark-400'}>
                                相手 {isRemoteSpeaking ? '(発話中)' : ''}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* マイクデバイス選択 */}
            {audioDevices.length > 0 && !isMicEnabled && (
                <div className="mb-3">
                    <label className="block text-xs text-dark-400 mb-1">マイクデバイス</label>
                    <select
                        className="w-full bg-dark-700 border border-dark-600 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-primary-500 transition-colors"
                        value={selectedDeviceId || ''}
                        onChange={(e) => onSelectDevice(e.target.value)}
                    >
                        {audioDevices.map(device => (
                            <option key={device.deviceId} value={device.deviceId}>
                                {device.label || `マイク ${device.deviceId.slice(0, 8)}`}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            <div className="flex items-center gap-2">
                {!isMicEnabled ? (
                    <button
                        onClick={handleStartMic}
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

                {/* デバイス更新ボタン */}
                {!isMicEnabled && (
                    <button
                        onClick={onRefreshDevices}
                        className="px-3 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm"
                        title="デバイス一覧を更新"
                    >
                        🔄
                    </button>
                )}
            </div>

            {/* リモート音声再生用（非表示） */}
            <audio ref={audioRef} autoPlay playsInline />
        </div>
    );
}
