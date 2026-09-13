/**
 * P2D - WebRTC接続管理フック (Full Mesh P2P Update)
 * 
 * RTCPeerConnectionの作成・管理、メディアストリーム処理を行う。
 * 参加者全員とフルメッシュ接続を確立する。
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useConnectionStore } from '../stores/connectionStore';
import { SignalingClient, ParticipantInfo } from '../lib/signalingClient';
import type { QualityConfig } from '../components/QualitySettings';
import type { ChatMessageData } from '../lib/dataChannel';
import { startSystemAudioCapture, type SystemAudioSession } from '../lib/systemAudio';
import { BandwidthMonitor, type BandwidthStats } from '../lib/bandwidthMonitor';
import { AdaptiveController } from '../lib/adaptiveController';
import {
    RelayH264Encoder, detectRelayCapabilities, arrayBufferToBase64, base64ToArrayBuffer,
    RELAY_MSE_VIDEO_MIME, RELAY_MSE_AUDIO_MIME, RELAY_AUDIO_REC_MIME,
} from '../lib/relayEncoder';
import { getRelayQualityPreset, RELAY_QUALITY_CHANGED_EVENT } from '../lib/relayQuality';

// WebRTC APIの有無 (Ubuntu等のWebKitGTKはWebRTC無効ビルドで RTCPeerConnection が存在しない)
export const SUPPORTS_WEBRTC = typeof RTCPeerConnection !== 'undefined';

// WSリレー視聴者の能力 (subscribe時に申告)
interface RelayViewerCaps {
    mse: boolean;      // H264/fMP4 + MSE 再生可
    webmAudio: boolean; // audio/webm(opus) の MSE 再生可
}

// Helper to prioritize specific codecs
function prioritizeCodecs(pc: RTCPeerConnection, preferredCodec: 'auto' | 'av1' | 'vp9' | 'h264' | 'vp8') {
    if (preferredCodec === 'auto') {
        preferredCodec = 'av1'; // Default priority
    }

    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs) return;

    const codecs = [...caps.codecs].sort((a, b) => {
        const aMime = a.mimeType.toLowerCase();
        const bMime = b.mimeType.toLowerCase();
        const target = `video/${preferredCodec}`;

        if (aMime === target && bMime !== target) return -1;
        if (aMime !== target && bMime === target) return 1;
        return 0;
    });

    pc.getTransceivers().forEach(transceiver => {
        const kind = transceiver.sender.track?.kind || transceiver.receiver.track?.kind;
        if (kind === 'video') {
            try {
                if ('setCodecPreferences' in transceiver && typeof transceiver.setCodecPreferences === 'function') {
                    transceiver.setCodecPreferences(codecs);
                    console.log(`[WebRTC] Codec preferences set for transceiver. Preferred: ${preferredCodec}`);
                }
            } catch (e) {
                console.warn('[WebRTC] setCodecPreferences failed', e);
            }
        }
    });
}

// SourceBufferのappendキューを捌く (updateendごとに呼ばれる)
function pumpRelayQueue(sb: SourceBuffer, queue: ArrayBuffer[]): void {
    // 消化が追いつかない場合は生きてる映像を優先して捨てる
    while (queue.length > 60) queue.shift();
    while (queue.length > 0 && !sb.updating) {
        try {
            sb.appendBuffer(queue.shift()!);
        } catch (e) {
            console.error('[Relay] appendBuffer失敗:', e);
            queue.length = 0;
            break;
        }
    }
}



// シグナリングサーバーURL（デフォルト）
const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';

// デフォルトSTUNサーバー
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// TURN設定型
export interface TurnConfig {
    url: string;        // turn:example.com:3478
    username?: string;
    credential?: string;
}

export interface MonitorInfo {
    name: string;
    position: { x: number; y: number };
    scale_factor: number;
    size: { width: number; height: number };
}

export interface UseWebRTCReturn {
    // ストリーム
    localStream: MediaStream | null;
    remoteStreams: Map<string, MediaStream>; // peerId -> Stream

    // 接続操作
    createRoom: (name?: string) => Promise<void>;
    joinRoom: (roomCode: string, name?: string) => Promise<void>;
    leaveRoom: () => void;

    // 状態
    roomCode: string | null;
    isConnected: boolean;
    error: string | null;
    participants: Map<string, ParticipantInfo>;
    myId: string | null;

    // 画面共有
    startScreenShare: (config?: QualityConfig) => Promise<void>;
    startCustomScreenShare: (sourceId: string, isMonitor: boolean, config?: QualityConfig) => Promise<void>;
    stopScreenShare: (streamId?: string) => void;
    isScreenSharing: boolean;
    localStreams: Map<string, MediaStream>; // streamId -> Stream

    // リモート操作 (F-022)
    remoteControlAllowed: boolean;
    setRemoteControlAllowed: (allowed: boolean) => void;
    peerControlAllowed: Map<string, boolean>;
    sendInputToPeer: (peerId: string, type: string, payload: unknown) => void;

    // WSリレーモード (WebRTC非対応エンジン: Linux等)
    isRelayMode: boolean;
    relayFrame: string | null;
    relayVideoUrl: string | null;
    relayAudioUrl: string | null;
    getRelayStats: () => {
        frames: number; bytes: number; lastFrameAt: number; h264Chunks: number; audioChunks: number;
        subscribers: number; mseSubscribers: number; audioSubscribers: number;
    };

    // マイク
    startMicrophone: () => Promise<void>;
    stopMicrophone: () => void;
    toggleMute: () => void;
    isMicEnabled: boolean;
    isMuted: boolean;
    isSpeaking: boolean;

    // システム音声 (F-031)
    startSystemAudio: () => Promise<void>;
    stopSystemAudio: () => Promise<void>;
    isSystemAudioEnabled: boolean;

    // デバイス
    audioDevices: MediaDeviceInfo[];
    selectedDeviceId: string | null;
    setSelectedDeviceId: (id: string) => void;
    refreshAudioDevices: () => Promise<void>;

    // モニター
    monitors: MonitorInfo[];
    selectedMonitorName: string | null;
    setSelectedMonitorName: (name: string) => void;
    refreshMonitors: () => Promise<MonitorInfo[]>;

    // チャット
    chatMessages: ChatMessageData[];
    sendChatMessage: (text: string) => void;

    // その他
    stats: any; // 簡易統計

    // リモートピア発話状態
    remoteSpeakingStates: Map<string, boolean>;

    // 接続品質（Adaptive Bitrate）
    connectionQuality: BandwidthStats | null;
    isAdaptiveModeEnabled: boolean;
    setAdaptiveModeEnabled: (enabled: boolean) => void;

    // E2Eテスト用統計
    getPeerStats: () => Promise<{ peerId: string; type: string; kind: string; bytes: number }[]>;
}

export function useWebRTC(options?: { signalingUrl?: string; turnConfig?: TurnConfig }): UseWebRTCReturn {
    const { connectionState, setConnectionState, setRoomCode, setError, reset } = useConnectionStore();

    const targetSignalingUrl = options?.signalingUrl || DEFAULT_SIGNALING_URL;

    // ICEサーバーリスト構築（STUN + オプションでTURN）
    const iceServers: RTCIceServer[] = useMemo(() => {
        const servers = [...DEFAULT_STUN_SERVERS];
        if (options?.turnConfig?.url) {
            servers.push({
                urls: options.turnConfig.url,
                username: options.turnConfig.username,
                credential: options.turnConfig.credential,
            });
            console.log('[WebRTC] TURN server configured:', options.turnConfig.url);
        }
        return servers;
    }, [options?.turnConfig]);

    const signalingRef = useRef<SignalingClient | null>(null);
    const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());

    // ステート
    const [myId, setMyId] = useState<string | null>(null);
    const [participants, setParticipants] = useState<Map<string, ParticipantInfo>>(new Map());

    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [localStreams, setLocalStreams] = useState<Map<string, MediaStream>>(new Map());
    const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

    const localStreamRef = useRef<MediaStream | null>(null);
    const localStreamsRef = useRef<Map<string, MediaStream>>(new Map());

    // オーディオ
    const [isMicEnabled, setIsMicEnabled] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const localAudioStreamRef = useRef<MediaStream | null>(null);
    const audioTrackRef = useRef<MediaStreamTrack | null>(null);
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    const [isSpeaking, setIsSpeaking] = useState(false);

    // システム音声 (F-031)
    const systemAudioSessionRef = useRef<SystemAudioSession | null>(null);
    const [isSystemAudioEnabled, setIsSystemAudioEnabled] = useState(false);

    // 発話検出用 (Voice Activity Detection)
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const vadIntervalRef = useRef<number | null>(null);
    const VAD_THRESHOLD = 30; // 音量閾値（0-255）
    const VAD_INTERVAL_MS = 100; // チェック間隔

    // 画面共有
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [selectedMonitorName, setSelectedMonitorName] = useState<string | null>(null);

    // チャット
    const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);

    // 統計（簡易版：最後のPeerのStatsを表示など）
    // const [stats, setStats] = useState<any>(null); // unused
    const stats: any = null; // stub

    // リモートピアの発話状態
    const [remoteSpeakingStates, setRemoteSpeakingStates] = useState<Map<string, boolean>>(new Map());

    // Adaptive Bitrate Control
    const [connectionQuality, setConnectionQuality] = useState<BandwidthStats | null>(null);
    const [isAdaptiveModeEnabled, setAdaptiveModeEnabled] = useState(true);
    const bandwidthMonitorRef = useRef<BandwidthMonitor | null>(null);
    const adaptiveControllerRef = useRef<AdaptiveController | null>(null);

    // リモート操作 (F-022: ホスト側の許可ゲート。デフォルトOFF = 安全側)
    const remoteControlAllowedRef = useRef(false);
    // 再接続時の部屋再参加用 (Wi-Fi断等から WS が繋がり直ったときに入り直す)
    const roomCodeRef = useRef<string | null>(null);
    const roomNameRef = useRef<string | undefined>(undefined);
    // ICE restartのグレア対策 (offerを送る側を決める) に使う自分のID
    const myIdRef = useRef<string | null>(null);

    // === WSリレーモード (LinuxのWebKitGTK等 WebRTC非対応エンジン向けフォールバック) ===
    const relayModeRef = useRef<boolean>(!SUPPORTS_WEBRTC);
    const [isRelayMode] = useState<boolean>(!SUPPORTS_WEBRTC);
    // ホスト側: WSリレーでフレームを受信する視聴者
    const relaySubscribersRef = useRef<Set<string>>(new Set());
    const relayVideoRef = useRef<HTMLVideoElement | null>(null);
    const relayLoopRef = useRef<number | null>(null);
    const relayFrameSeqRef = useRef(0);
    const [relayFrame, setRelayFrame] = useState<string | null>(null);
    const relayStatsRef = useRef({ frames: 0, bytes: 0, lastFrameAt: 0, h264Chunks: 0, audioChunks: 0 });
    const relayLastRenderRef = useRef(0);
    // H264/MSE品質モード
    const relayCapsRef = useRef<Map<string, RelayViewerCaps>>(new Map()); // peerId -> caps
    const relayEncoderRef = useRef<RelayH264Encoder | null>(null);
    // ゲスト側: MSE再生 (video=H264/fMP4, audio=webm/opus)
    const relayVideoMsRef = useRef<MediaSource | null>(null);
    const relayVideoSbRef = useRef<SourceBuffer | null>(null);
    const relayVideoQueueRef = useRef<ArrayBuffer[]>([]);
    const relayAudioMsRef = useRef<MediaSource | null>(null);
    const relayAudioSbRef = useRef<SourceBuffer | null>(null);
    const relayAudioQueueRef = useRef<ArrayBuffer[]>([]);
    const [relayVideoUrl, setRelayVideoUrl] = useState<string | null>(null);
    const [relayAudioUrl, setRelayAudioUrl] = useState<string | null>(null);
    // ホスト側: 音声リレー (MediaRecorder)
    const relayAudioRecRef = useRef<MediaRecorder | null>(null);
    // リレーモードのチャット配送先 (参加者一覧のrefミラー)
    const participantsRef = useRef<Map<string, ParticipantInfo>>(new Map());
    useEffect(() => { participantsRef.current = participants; }, [participants]);
    // ピアごとのSDP処理直列化キュー (オファー/アンサーの同時着によるstate競合を防ぐ)
    const pcOpsRef = useRef(new WeakMap<RTCPeerConnection, Promise<void>>());
    const enqueueSdpOp = useCallback((pc: RTCPeerConnection, op: () => Promise<void>) => {
        const prev = pcOpsRef.current.get(pc) || Promise.resolve();
        const next = prev.then(op).catch(() => { /* チェーンを切らせない */ });
        pcOpsRef.current.set(pc, next);
        return next;
    }, []);
    // メディアを一度でも受信したピア (メディア停滞チェックの適用対象を絞るため。
    // 相手が何も送らない場合、受信トラックはmutedのままなのが正常なので再構築してはいけない)
    const remoteMediaSeenRef = useRef(new Set<string>());
    const [remoteControlAllowed, setRemoteControlAllowedState] = useState(false);
    const [peerControlAllowed, setPeerControlAllowed] = useState<Map<string, boolean>>(new Map());

    // 接続状態管理
    const isConnectedRef = useRef(false);

    /**
     * データチャネル送信 (全ピアへブロードキャスト)
     */
    const broadcastData = useCallback((type: string, payload: any) => {
        const message = JSON.stringify({ type, payload, timestamp: Date.now() });
        dataChannelsRef.current.forEach(dc => {
            if (dc.readyState === 'open') {
                dc.send(message);
            }
        });
    }, []);

    /**
     * DataChannel設定
     */
    const setupDataChannel = useCallback((channel: RTCDataChannel, peerId: string) => {
        channel.onopen = () => {
            console.log(`[DataChannel] Open: ${peerId}`);
            dataChannelsRef.current.set(peerId, channel);
            // 自分がホスト側の場合、リモート操作の許可状態を即通知
            channel.send(JSON.stringify({ type: 'control:remote_allowed', payload: { allowed: remoteControlAllowedRef.current }, timestamp: Date.now() }));
            if (connectionState !== 'peer-connected' && peerConnectionsRef.current.size > 0) {
                setConnectionState('peer-connected');
            }
        };

        channel.onclose = () => {
            console.log(`[DataChannel] Close: ${peerId}`);
            dataChannelsRef.current.delete(peerId);
        };

        channel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'chat') {
                    setChatMessages(prev => [...prev, data.payload]);
                } else if (data.type === 'speaking') {
                    // リモートピアの発話状態を更新
                    setRemoteSpeakingStates(prev => {
                        const next = new Map(prev);
                        next.set(peerId, data.payload.isSpeaking);
                        return next;
                    });
                } else if (data.type === 'control:remote_allowed') {
                    // ピア(ホスト)からのリモート操作許可状態
                    setPeerControlAllowed(prev => {
                        const next = new Map(prev);
                        next.set(peerId, !!data.payload?.allowed);
                        return next;
                    });
                } else if (typeof data.type === 'string' && data.type.startsWith('input:')) {
                    // ホスト側: 自分が共有している画面へのリモート操作を適用 (許可時のみ・F-022)
                    if (remoteControlAllowedRef.current) {
                        void applyInputEvent(data.type, data.payload);
                    }
                }
                // 他のメッセージタイプ（controlなど）は必要に応じて追加
            } catch (e) {
                console.error('[DataChannel] Parse error:', e);
            }
        };
    }, [connectionState, setConnectionState]);

    /**
     * 受信したリモート操作イベントをネイティブ入力として適用 (ホスト側)
     */
    const applyInputEvent = useCallback(async (type: string, payload: any) => {
        if (!payload) return;
        try {
            switch (type) {
                case 'input:mouse_move':
                    await invoke('simulate_mouse_move', { x: payload.x, y: payload.y, monitorName: payload.monitor ?? null });
                    break;
                case 'input:mouse_button':
                    await invoke('simulate_mouse_button', { button: payload.button, direction: payload.direction });
                    break;
                case 'input:click':
                    await invoke('simulate_click', { button: payload.button });
                    break;
                case 'input:scroll':
                    await invoke('simulate_scroll', { deltaX: Math.round(payload.deltaX ?? 0), deltaY: Math.round(payload.deltaY ?? 0) });
                    break;
                case 'input:key_event':
                    await invoke('simulate_key_event', { key: payload.key, direction: payload.direction });
                    break;
                case 'input:key':
                    // レガシー: テキスト入力
                    await invoke('simulate_key', { key: payload.key });
                    break;
                default:
                    break;
            }
        } catch (e) {
            console.error('[RemoteControl] 入力適用失敗:', type, e);
        }
    }, []);

    /**
     * リモート操作の許可状態を切り替え、全ピアへ通知 (F-022)
     */
    const setRemoteControlAllowed = useCallback((allowed: boolean) => {
        remoteControlAllowedRef.current = allowed;
        setRemoteControlAllowedState(allowed);
        broadcastData('control:remote_allowed', { allowed });
        // WSリレー視聴者にも通知
        relaySubscribersRef.current.forEach(peerId => {
            signalingRef.current?.sendRelay(peerId, 'control_allowed', { allowed });
        });
        console.log('[RemoteControl] 許可状態:', allowed);
    }, [broadcastData]);

    /**
     * 特定ピアへ入力イベントを送信 (ビューア側)
     */
    const sendInputToPeer = useCallback((peerId: string, type: string, payload: unknown) => {
        const dc = dataChannelsRef.current.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
        } else if (relayModeRef.current) {
            // DataChannelが使えないエンジン (Linux等) はWSリレーへフォールバック
            signalingRef.current?.sendRelay(peerId, 'input', { type, payload });
        }
    }, []);

    /**
     * ホスト側: WSリレーのフレーム送信ループを開始 (視聴者がいる時だけ動く)。
     * MSE対応視聴者にはH264/fMP4、非対応にはJPEGを送る。
     */
    const ensureRelayLoop = useCallback(() => {
        if (relayLoopRef.current || !SUPPORTS_WEBRTC) return;
        const q = getRelayQualityPreset();
        const intervalMs = Math.round(1000 / q.fps);
        const stream = localStreamsRef.current.values().next().value || localStreamRef.current;
        const videoTrack = stream?.getVideoTracks?.()[0];
        if (!videoTrack) return; // 画面共有開始時に再度呼ばれる

        const video = document.createElement('video');
        video.srcObject = new MediaStream([videoTrack]);
        video.muted = true;
        video.playsInline = true;
        void video.play().catch(() => { });
        const canvas = document.createElement('canvas');

        relayVideoRef.current = video;
        relayLoopRef.current = window.setInterval(() => {
            const mseSubs = Array.from(relayCapsRef.current.entries()).filter(([, c]) => c.mse).map(([id]) => id);
            const jpegSubs = Array.from(relayCapsRef.current.entries()).filter(([, c]) => !c.mse).map(([id]) => id);
            if (mseSubs.length === 0 && jpegSubs.length === 0) return;
            if (!video.videoWidth) return;
            if (video.readyState < 2) return;
            const w = Math.min(q.maxWidth, video.videoWidth);
            const h = Math.round(video.videoHeight * (w / video.videoWidth));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                // サイズが変わったらエンコーダを作り直す
                if (relayEncoderRef.current) { relayEncoderRef.current.close(); relayEncoderRef.current = null; }
            }
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, w, h);

            // H264/fMP4 (品質モード)
            if (mseSubs.length > 0) {
                if (!relayEncoderRef.current) {
                    relayEncoderRef.current = new RelayH264Encoder({
                        width: w, height: h, bitrate: q.bitrate,
                        onBox: (buf) => {
                            const d = arrayBufferToBase64(buf);
                            relayStatsRef.current.h264Chunks++;
                            for (const peerId of mseSubs) {
                                signalingRef.current?.sendRelay(peerId, 'h264', { seq: relayFrameSeqRef.current, d });
                            }
                        },
                        onError: (e) => console.error('[Relay] H264 encoder error:', (e as Error)?.message || e),
                    });
                }
                relayEncoderRef.current.encode(canvas);
            }

            // JPEG (低遅延フォールバック)
            if (jpegSubs.length > 0) {
                const dataUrl = canvas.toDataURL('image/jpeg', q.jpegQuality);
                const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                relayFrameSeqRef.current++;
                relayStatsRef.current.frames++;
                for (const peerId of jpegSubs) {
                    signalingRef.current?.sendRelay(peerId, 'frame', { seq: relayFrameSeqRef.current, w, h, d: b64 });
                }
            }
        }, intervalMs);
        console.log(`[Relay] フレーム送信ループ開始 (品質: ${q.label} ${q.maxWidth}px / ${(q.bitrate / 1_000_000).toFixed(1)}Mbps / ${q.fps}fps)`);
    }, []);

    /**
     * ホスト側: フレーム送信ループを停止
     */
    const stopRelayLoop = useCallback(() => {
        if (relayLoopRef.current) {
            clearInterval(relayLoopRef.current);
            relayLoopRef.current = null;
            relayVideoRef.current = null;
            relaySubscribersRef.current.clear();
            relayCapsRef.current.clear();
            relayEncoderRef.current?.close();
            relayEncoderRef.current = null;
            stopRelayAudioSend();
            console.log('[Relay] フレーム送信ループ停止');
        }
    }, []);

    /**
     * ホスト側: 視聴者がいなくなったらループを止める
     */
    const maybeStopRelayLoop = useCallback(() => {
        if (relayLoopRef.current && relaySubscribersRef.current.size === 0) {
            stopRelayLoop();
        }
    }, [stopRelayLoop]);

    // リレー品質設定の変更で稼働中のループを作り直す (停止中なら次回start時から新設定)
    useEffect(() => {
        const onQualityChanged = () => {
            if (!relayLoopRef.current) return;
            stopRelayLoop();
            ensureRelayLoop();
        };
        window.addEventListener(RELAY_QUALITY_CHANGED_EVENT, onQualityChanged);
        return () => window.removeEventListener(RELAY_QUALITY_CHANGED_EVENT, onQualityChanged);
    }, [stopRelayLoop, ensureRelayLoop]);

    /**
     * ホスト側: システム音声をリレー視聴者へ送る (MediaRecorder → webm/opusチャンク)
     */
    const startRelayAudioSend = useCallback(() => {
        if (relayAudioRecRef.current) return;
        const caps = Array.from(relayCapsRef.current.values());
        if (!caps.some(c => c.webmAudio)) return;
        const stream = systemAudioSessionRef.current?.stream;
        if (!stream) return;
        try {
            const rec = new MediaRecorder(stream, {
                mimeType: RELAY_AUDIO_REC_MIME,
                audioBitsPerSecond: 48_000,
            });
            rec.ondataavailable = (e) => {
                if (!e.data || e.data.size === 0) return;
                relayStatsRef.current.audioChunks++;
                void e.data.arrayBuffer().then(buf => {
                    const d = arrayBufferToBase64(buf);
                    for (const [peerId, c] of relayCapsRef.current) {
                        if (c.webmAudio) signalingRef.current?.sendRelay(peerId, 'audio', { d });
                    }
                });
            };
            rec.start(600);
            relayAudioRecRef.current = rec;
            console.log('[Relay] 音声送信開始');
        } catch (e) {
            console.error('[Relay] MediaRecorder起動失敗:', e);
        }
    }, []);

    const stopRelayAudioSend = useCallback(() => {
        const rec = relayAudioRecRef.current;
        if (rec) {
            try { rec.stop(); } catch { /* noop */ }
            relayAudioRecRef.current = null;
        }
    }, []);

    // === ゲスト側: MSE appendユーティリティ ===
    const ensureRelayVideoSink = useCallback(() => {
        if (relayVideoMsRef.current || typeof MediaSource === 'undefined') return;
        try {
            const ms = new MediaSource();
            relayVideoMsRef.current = ms;
            ms.addEventListener('sourceopen', () => {
                try {
                    const sb = ms.addSourceBuffer(RELAY_MSE_VIDEO_MIME);
                    sb.mode = 'sequence';
                    relayVideoSbRef.current = sb;
                    sb.addEventListener('updateend', () => pumpRelayQueue(sb, relayVideoQueueRef.current));
                    sb.addEventListener('error', () => console.error('[Relay] video SourceBuffer error (readyState:', ms.readyState, ')'));
                    // sourceopenまでに溜まったinit segment等を即流す (流さないとinit抜けで以後全滅する)
                    pumpRelayQueue(sb, relayVideoQueueRef.current);
                } catch (e) {
                    console.error('[Relay] SourceBuffer(video)作成失敗:', e);
                }
            });
            setRelayVideoUrl(URL.createObjectURL(ms));
        } catch (e) {
            console.error('[Relay] MediaSource初期化失敗:', e);
        }
    }, []);

    const ensureRelayAudioSink = useCallback(() => {
        if (relayAudioMsRef.current || typeof MediaSource === 'undefined') return;
        try {
            const ms = new MediaSource();
            relayAudioMsRef.current = ms;
            ms.addEventListener('sourceopen', () => {
                try {
                    const sb = ms.addSourceBuffer(RELAY_MSE_AUDIO_MIME);
                    sb.mode = 'sequence';
                    relayAudioSbRef.current = sb;
                    sb.addEventListener('updateend', () => pumpRelayQueue(sb, relayAudioQueueRef.current));
                    sb.addEventListener('error', () => console.error('[Relay] audio SourceBuffer error (readyState:', ms.readyState, ')'));
                    pumpRelayQueue(sb, relayAudioQueueRef.current);
                } catch (e) {
                    console.error('[Relay] SourceBuffer(audio)作成失敗:', e);
                }
            });
            setRelayAudioUrl(URL.createObjectURL(ms));
        } catch (e) {
            console.error('[Relay] MediaSource(audio)初期化失敗:', e);
        }
    }, []);

    /**
     * PeerConnection作成
     * @param peerId 相手のID
     * @param isInitiator 自分が発信側か（Offerを作成するか）
     */
    const createPeerConnection = useCallback((peerId: string, isInitiator: boolean) => {
        if (peerConnectionsRef.current.has(peerId)) return peerConnectionsRef.current.get(peerId)!;

        console.log(`[WebRTC] PC作成: ${peerId} (Initiator: ${isInitiator})`);

        const pc = new RTCPeerConnection({
            iceServers: iceServers,
            bundlePolicy: 'max-bundle', // 効率化
        });

        peerConnectionsRef.current.set(peerId, pc);

        // ICE Candidate
        pc.onicecandidate = (event) => {
            if (event.candidate && signalingRef.current) {
                signalingRef.current.sendIceCandidate(peerId, event.candidate);
            }
        };

        // ピアレベル自動再接続: ICEがfailed/長時間disconnectedになったらrestartIce+再交渉で復旧を試みる
        let restartCount = 0;
        let disconnectTimer: number | null = null;
        let fallbackTimer: number | null = null;
        let recoveryVerifyTimer: number | null = null;
        const maxRestarts = 5;

        const attemptIceRestart = (reason: string, force = false) => {
            if (pc.connectionState === 'closed') return;
            if (!signalingRef.current) return; // シグナリングが死んでいるなら復旧できない
            // 復旧保証: 最初の試みから15秒経ってもICEが繋がらなければ、
            // リスタートの成否に関わらず部屋再参加で接続を全部作り直す
            if (recoveryVerifyTimer === null) {
                recoveryVerifyTimer = window.setTimeout(() => {
                    recoveryVerifyTimer = null;
                    const s = pc.iceConnectionState;
                    if (s !== 'connected' && s !== 'completed') {
                        console.warn(`[WebRTC] ICE未回復(${s}) → 接続を再構築`);
                        rebuildConnections();
                    }
                }, 15000);
            }
            if (restartCount >= maxRestarts) {
                console.warn(`[WebRTC] ICE restart上限(${maxRestarts})到達: ${peerId}`);
                return; // 継続的な復旧はverifyタイマー経由の再構築が担う
            }
            // グレア対策: IDの小さい側だけが再起動offerを送る (大きい側は相手のofferを待つ)。
            // 相手側が死んでいる等で10秒復旧しなければ、全側が自分から試みる
            if (!force && (myIdRef.current || '') >= peerId) {
                console.log(`[WebRTC] ICE restart待機 (相手主導, ${reason}): ${peerId}`);
                if (fallbackTimer === null) {
                    fallbackTimer = window.setTimeout(() => {
                        fallbackTimer = null;
                        if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                            attemptIceRestart('fallback', true);
                        }
                    }, 10000);
                }
                return;
            }
            if (fallbackTimer !== null) {
                window.clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
            restartCount += 1;
            console.warn(`[WebRTC] ICE restart #${restartCount} (${reason}): ${peerId}`);
            try {
                pc.restartIce();
            } catch (e) {
                console.error('[WebRTC] restartIce失敗:', e);
            }
            // restartIceだけでは再交渉が走らないケースがあるため、少し置いてofferを作り直す
            window.setTimeout(() => {
                if (pc.signalingState !== 'stable' || pc.connectionState === 'closed') return;
                void (async () => {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        signalingRef.current?.sendOffer(peerId, offer);
                    } catch (e) {
                        console.error('[WebRTC] 再接続offer失敗:', (e as Error)?.message || String(e));
                    }
                })();
            }, 500);
        };

        pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState;
            if (s === 'disconnected') {
                // 短瞬の切断はよくある → 5秒待って復旧しなければrestart
                if (disconnectTimer === null) {
                    disconnectTimer = window.setTimeout(() => {
                        disconnectTimer = null;
                        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                            attemptIceRestart('disconnected>5s');
                        }
                    }, 5000);
                }
            } else if (s === 'failed') {
                if (disconnectTimer !== null) {
                    window.clearTimeout(disconnectTimer);
                    disconnectTimer = null;
                }
                attemptIceRestart('failed');
            } else if (s === 'connected' || s === 'completed') {
                restartCount = 0;
                console.log(`[WebRTC] ICE復旧: connected (${peerId})`);
                if (disconnectTimer !== null) {
                    window.clearTimeout(disconnectTimer);
                    disconnectTimer = null;
                }
                if (fallbackTimer !== null) {
                    window.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
                if (recoveryVerifyTimer !== null) {
                    window.clearTimeout(recoveryVerifyTimer);
                    recoveryVerifyTimer = null;
                }
                // メディア確認: ICEは繋がってもトラックがmutedのまま流れないケースがある
                // (送信側のtransceiver状態破損)。5秒経っても全受信トラックがmutedなら再構築。
                // ただし相手が一度もメディアを送っていない場合はmutedが正常なので再構築しない
                window.setTimeout(() => {
                    if (pc.connectionState !== 'connected') return;
                    if (!remoteMediaSeenRef.current.has(peerId)) return;
                    const receivers = pc.getReceivers().filter(r => r.track);
                    if (receivers.length === 0) return;
                    const allMuted = receivers.every(r => r.track.muted);
                    if (allMuted) {
                        console.warn('[WebRTC] ICE復旧後もメディアが流れないため接続を再構築');
                        rebuildConnections();
                    }
                }, 5000);
            }
        };

        // Track受信 (映像/音声)
        pc.ontrack = (event) => {
            console.log(`[WebRTC] Track受信: ${peerId} (${event.track.kind})`);
            remoteMediaSeenRef.current.add(peerId);
            const stream = event.streams[0] || new MediaStream([event.track]);

            const triggerUpdate = () => setRemoteStreams(prev => new Map(prev));

            // 1. Track removal from stream
            stream.onremovetrack = (ev) => {
                console.log(`[WebRTC] Track removed: ${peerId} (${ev.track.kind})`);
                triggerUpdate();
            };

            // 2. Track ended (e.g. Stop Sharing button)
            event.track.onended = () => {
                console.log(`[WebRTC] Track ended: ${peerId} (${event.track.kind})`);
                triggerUpdate();
            };

            // 3. Track mute/unmute (optional but good for responsiveness)
            event.track.onmute = () => {
                console.log(`[WebRTC] Track muted: ${peerId} (${event.track.kind})`);
                triggerUpdate();
            };

            event.track.onunmute = () => {
                console.log(`[WebRTC] Track unmuted: ${peerId} (${event.track.kind})`);
                triggerUpdate();
            };

            setRemoteStreams(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(peerId);

                if (existing) {
                    if (!existing.getTracks().some(t => t.id === event.track.id)) {
                        const updatedStream = new MediaStream(existing.getTracks());
                        updatedStream.addTrack(event.track);
                        newMap.set(peerId, updatedStream);
                    }
                } else {
                    newMap.set(peerId, stream);
                }
                return newMap;
            });
        };

        // DataChannel
        if (isInitiator) {
            const dc = pc.createDataChannel('p2d-data', { ordered: true });
            setupDataChannel(dc, peerId);
        } else {
            pc.ondatachannel = (event) => {
                setupDataChannel(event.channel, peerId);
            };
        }

        // 既存のローカルトラックがあれば追加
        let attachedExistingMedia = false;
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!);
                attachedExistingMedia = true;
            });
        }
        if (localAudioStreamRef.current) {
            localAudioStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localAudioStreamRef.current!); // Stream分けるべきか？
                attachedExistingMedia = true;
            });
        }
        // 画面共有中のストリームも新規ピアにattachする (再構築/途中参加で共有が見えなくなるのを防ぐ)
        localStreamsRef.current.forEach(stream => {
            stream.getTracks().forEach(track => {
                if (!pc.getSenders().some(s => s.track === track)) {
                    pc.addTrack(track, stream);
                    attachedExistingMedia = true;
                }
            });
        });
        if (systemAudioSessionRef.current) {
            pc.addTrack(systemAudioSessionRef.current.track, systemAudioSessionRef.current.stream);
            attachedExistingMedia = true;
        }
        // 既存メディアをattachしたnon-initiator (onnegotiationneededを持たない) は、
        // 初期negotiation (DCのみのoffer/answer) が落ち着いた後に手動で再交渉する。
        // これが無いと「共有中に相手が再参加/途中参加」したとき映像が載らない。
        if (attachedExistingMedia && !isInitiator) {
            const tryExistingMediaRenegotiation = (attempt = 0) => {
                if (pc.connectionState === 'closed') return;
                // ICE接続完了かつSDP stableになるまで待つ (固定遅延だと競合時に握りつぶされる)
                if (pc.signalingState !== 'stable' || pc.connectionState !== 'connected') {
                    if (attempt < 20) window.setTimeout(() => tryExistingMediaRenegotiation(attempt + 1), 500);
                    return;
                }
                enqueueSdpOp(pc, async () => {
                    try {
                        if (pc.signalingState !== 'stable') return;
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        signalingRef.current?.sendOffer(peerId, offer);
                        console.log(`[WebRTC] 既存メディアの再交渉offer送信: ${peerId}`);
                    } catch (e) {
                        console.error('[WebRTC] 既存メディア再交渉失敗:', (e as Error)?.message || String(e));
                    }
                });
            };
            window.setTimeout(() => tryExistingMediaRenegotiation(), 800);
        }

        // InitiatorならOffer作成
        if (isInitiator) {
            pc.onnegotiationneeded = async () => {
                try {
                    // 少し待ってから作成（トラック追加の安定化など）
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    signalingRef.current?.sendOffer(peerId, offer);
                } catch (e) {
                    console.error('[WebRTC] Offer作成失敗:', e);
                }
            };
        }

        return pc;
    }, [iceServers, setupDataChannel, enqueueSdpOp]);

    /**
     * シグナリング初期化
     */
    const connect = useCallback(async () => {
        if (signalingRef.current) return;

        setConnectionState('connecting');
        const signaling = new SignalingClient(targetSignalingUrl);
        signalingRef.current = signaling;

        signaling.on('onConnected', () => {
            setConnectionState('connected');
            // 再接続: 入室中だった部屋に自動で再参加する (サーバー側の入室状態は
            // WS切断で失われているため。これが無いとICE再起動のofferが届かない)
            if (roomCodeRef.current) {
                console.log(`[WebRTC] 再接続: 部屋 ${roomCodeRef.current} に再参加`);
                signaling.joinRoom(roomCodeRef.current, roomNameRef.current);
            }
        });

        signaling.on('onDisconnected', () => {
            setConnectionState('disconnected');
            isConnectedRef.current = false;
        });

        // 自分の参加完了通知 (既存参加者リストが来る)
        signaling.on('onRoomJoined', (_roomId, code, myClientId, existingParticipants) => {
            setRoomCode(code);
            setMyId(myClientId);
            roomCodeRef.current = code;
            myIdRef.current = myClientId;
            isConnectedRef.current = true;

            // 参加者リスト更新
            const pMap = new Map<string, ParticipantInfo>();
            existingParticipants.forEach(p => pMap.set(p.id, p));
            setParticipants(pMap);

            // **Full Mesh Logic**: 既存の参加者全員に対して Initiator となり接続開始
            // リレーモード (WebRTC非対応エンジン) ではPCを作らず、リレー購読だけ行う
            existingParticipants.forEach(p => {
                if (relayModeRef.current) {
                    signalingRef.current?.sendRelay(p.id, 'subscribe', detectRelayCapabilities());
                } else {
                    createPeerConnection(p.id, true); // Initiator = true
                }
            });
        });

        // 他の誰かが参加通知
        signaling.on('onPeerJoined', (peerId, name) => {
            console.log(`[WebRTC] Peer参加: ${peerId}`);
            setParticipants(prev => {
                const next = new Map(prev);
                next.set(peerId, { id: peerId, name, joinedAt: Date.now() });
                return next;
            });
            if (relayModeRef.current) {
                signalingRef.current?.sendRelay(peerId, 'subscribe', detectRelayCapabilities());
                return;
            }
            // 相手からのOfferを待つ (Initiator = false)
            createPeerConnection(peerId, false);
        });

        signaling.on('onPeerLeft', (peerId) => {
            console.log(`[WebRTC] Peer退出: ${peerId}`);
            setParticipants(prev => {
                const next = new Map(prev);
                next.delete(peerId);
                return next;
            });
            // リレー視聴者が退出したら購読を外す
            relaySubscribersRef.current.delete(peerId);
            relayCapsRef.current.delete(peerId);
            maybeStopRelayLoop();
            // PC cleanup
            const pc = peerConnectionsRef.current.get(peerId);
            if (pc) {
                pc.close();
                peerConnectionsRef.current.delete(peerId);
            }
            // Stream cleanup
            setRemoteStreams(prev => {
                const next = new Map(prev);
                next.delete(peerId);
                return next;
            });
            // DC cleanup
            dataChannelsRef.current.delete(peerId);
        });

        signaling.on('onOffer', (senderId, sdp) => {
            if (relayModeRef.current) return; // リレーモードではWebRTC経路を使わない
            const pc = createPeerConnection(senderId, false); // PC取得または作成(受信側)
            return enqueueSdpOp(pc, async () => {
                try {
                    if (pc.signalingState !== 'stable') {
                        await Promise.all([
                            pc.setLocalDescription({ type: 'rollback' }),
                            pc.setRemoteDescription(new RTCSessionDescription(sdp))
                        ]);
                    } else {
                        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                    }
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    signalingRef.current?.sendAnswer(senderId, answer);
                } catch (e) {
                    console.error('[WebRTC] Offer処理失敗:', (e as Error)?.message || String(e));
                }
            });
        });

        signaling.on('onAnswer', (senderId, sdp) => {
            if (relayModeRef.current) return;
            const pc = peerConnectionsRef.current.get(senderId);
            if (!pc) return;
            return enqueueSdpOp(pc, async () => {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                } catch (e) {
                    console.error('[WebRTC] Answer処理失敗:', (e as Error)?.message || String(e));
                }
            });
        });

        signaling.on('onIceCandidate', async (senderId, candidate) => {
            const pc = peerConnectionsRef.current.get(senderId);
            if (pc) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    // console.warn('ICE Candidate Error', e);
                }
            }
        });

        // WSリレー (WebRTC非対応エンジンのフォールバック経路)
        signaling.on('onRelayMessage', (senderId, type, payload) => {
            const p = (payload || {}) as Record<string, unknown>;
            if (type === 'frame') {
                // ゲスト側: 最新フレームを保持 (setStateは描画レートに合わせて間引く)
                relayStatsRef.current.frames++;
                relayStatsRef.current.bytes += typeof p.d === 'string' ? p.d.length : 0;
                relayStatsRef.current.lastFrameAt = Date.now();
                const now = Date.now();
                if (now - relayLastRenderRef.current >= 100) {
                    relayLastRenderRef.current = now;
                    setRelayFrame(`data:image/jpeg;base64,${String(p.d || '')}`);
                }
                return;
            }
            if (type === 'subscribe') {
                // ホスト側: 視聴者登録 (能力を記録してモード別に配送) → 許可状態も即通知
                const caps: RelayViewerCaps = {
                    mse: !!(p as Record<string, unknown>).mse,
                    webmAudio: !!(p as Record<string, unknown>).webmAudio,
                };
                relaySubscribersRef.current.add(senderId);
                relayCapsRef.current.set(senderId, caps);
                ensureRelayLoop();
                startRelayAudioSend();
                signalingRef.current?.sendRelay(senderId, 'control_allowed', { allowed: remoteControlAllowedRef.current });
                console.log(`[Relay] 視聴者登録: ${senderId} (mse=${caps.mse} webmAudio=${caps.webmAudio}, 計${relaySubscribersRef.current.size}人)`);
                return;
            }
            if (type === 'h264') {
                // ゲスト側: fMP4のbox (init/fragment) を順にappend
                relayStatsRef.current.h264Chunks++;
                ensureRelayVideoSink();
                const sb = relayVideoSbRef.current;
                const buf = base64ToArrayBuffer(String(p.d || ''));
                if (sb && !sb.updating && relayVideoMsRef.current?.readyState === 'open') {
                    try { sb.appendBuffer(buf); } catch (e) { console.error('[Relay] video appendBuffer失敗:', (e as DOMException)?.name, (e as DOMException)?.message || e); }
                } else if (relayVideoQueueRef.current.length < 240) {
                    relayVideoQueueRef.current.push(buf);
                }
                return;
            }
            if (type === 'audio') {
                relayStatsRef.current.audioChunks++;
                ensureRelayAudioSink();
                const sb = relayAudioSbRef.current;
                const buf = base64ToArrayBuffer(String(p.d || ''));
                if (sb && !sb.updating && relayAudioMsRef.current?.readyState === 'open') {
                    try { sb.appendBuffer(buf); } catch (e) { console.error('[Relay] audio appendBuffer失敗:', (e as DOMException)?.name, (e as DOMException)?.message || e); }
                } else if (relayAudioQueueRef.current.length < 240) {
                    relayAudioQueueRef.current.push(buf);
                }
                return;
            }
            if (type === 'unsubscribe') {
                relaySubscribersRef.current.delete(senderId);
                maybeStopRelayLoop();
                return;
            }
            if (type === 'control_allowed') {
                setPeerControlAllowed(prev => new Map(prev).set(senderId, !!p.allowed));
                return;
            }
            if (type === 'chat') {
                const msg = p as unknown as ChatMessageData;
                if (msg?.id) {
                    setChatMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
                }
                return;
            }
            if (type === 'input') {
                // ホスト側: 許可時のみリモート操作を適用 (F-022と同じゲート)
                const inputType = typeof p.type === 'string' ? p.type : '';
                if (remoteControlAllowedRef.current && inputType.startsWith('input:')) {
                    void applyInputEvent(inputType, p.payload);
                }
                return;
            }
        });

        await signaling.connect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setConnectionState, setRoomCode, createPeerConnection, targetSignalingUrl, ensureRelayLoop, maybeStopRelayLoop]);

    /**
     * ルーム作成・参加
     */
    const createRoom = useCallback(async (name?: string) => {
        await connect();
        roomNameRef.current = name;
        signalingRef.current?.createRoom(name);
    }, [connect]);

    const joinRoom = useCallback(async (code: string, name?: string) => {
        await connect();
        roomNameRef.current = name;
        signalingRef.current?.joinRoom(code, name);
    }, [connect]);

    // ICE再起動で復旧できない場合の最終手段: 部屋に再参加して全ピア接続を作り直す。
    // leaveRoom → joinRoom により相手側でも peer:left/peer:joined が流れ、
    // 両側が初期接続と同じ(実績のある)経路で fresh なPCを張り直す。
    const lastRebuildAtRef = useRef(0);
    const rebuildConnections = useCallback(() => {
        if (relayModeRef.current) return; // リレーモードではPCを再構築しない (WSは自動再接続される)
        const now = Date.now();
        if (now - lastRebuildAtRef.current < 15000) return; // 再構築ループ防止
        const code = roomCodeRef.current;
        const signaling = signalingRef.current;
        if (!code || !signaling) return;
        lastRebuildAtRef.current = now;
        console.log('[WebRTC] 接続再構築: 部屋に再参加します');
        peerConnectionsRef.current.forEach(pc => pc.close());
        peerConnectionsRef.current.clear();
        dataChannelsRef.current.clear();
        setRemoteStreams(new Map());
        signaling.leaveRoom();
        signaling.joinRoom(code, roomNameRef.current);
    }, [setRemoteStreams]);

    /**
     * 切断
     */
    const leaveRoom = useCallback(() => {
        roomCodeRef.current = null;
        roomNameRef.current = undefined;
        signalingRef.current?.leaveRoom();
        signalingRef.current?.disconnect();
        signalingRef.current = null;

        // リレーの後片付け
        stopRelayLoop();
        setRelayFrame(null);
        setRelayVideoUrl(null);
        setRelayAudioUrl(null);
        relayVideoMsRef.current = null;
        relayVideoSbRef.current = null;
        relayVideoQueueRef.current = [];
        relayAudioMsRef.current = null;
        relayAudioSbRef.current = null;
        relayAudioQueueRef.current = [];

        peerConnectionsRef.current.forEach(pc => pc.close());
        peerConnectionsRef.current.clear();
        dataChannelsRef.current.clear();

        localStreamRef.current?.getTracks().forEach(t => t.stop());
        setLocalStream(null);
        localStreamRef.current = null;

        // システム音声の停止 (F-031)
        const sa = systemAudioSessionRef.current;
        if (sa) {
            systemAudioSessionRef.current = null;
            setIsSystemAudioEnabled(false);
            void sa.stop();
        }

        setParticipants(new Map());
        setRemoteStreams(new Map());
        reset();
    }, [reset, stopRelayLoop]);

    /**
     * 画面共有停止
     */
    const stopScreenShare = useCallback((streamId?: string) => {
        // streamIdが指定されていない場合はメイン(localStream)を停止、あればそれ以外も停止
        if (streamId) {
            const stream = localStreamsRef.current.get(streamId);
            if (stream) {
                stream.getTracks().forEach(t => {
                    t.stop();
                    // 全ピアからこのトラックを削除
                    peerConnectionsRef.current.forEach(pc => {
                        const sender = pc.getSenders().find(s => s.track === t);
                        if (sender) pc.removeTrack(sender);
                    });
                });
                setLocalStreams(prev => {
                    const next = new Map(prev);
                    next.delete(streamId);
                    return next;
                });
                localStreamsRef.current.delete(streamId);

                // 全ピアで再交渉
                peerConnectionsRef.current.forEach(async (pc, peerId) => {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        signalingRef.current?.sendOffer(peerId, offer);
                    } catch (e) {
                        console.error('[WebRTC] Renegotiation after stop failed:', e);
                    }
                });
            }
        } else {
            // 下位互換性のためメインストリームのみ停止、または全部停止
            localStreamRef.current?.getTracks().forEach(t => t.stop());
            setLocalStream(null);
            localStreamRef.current = null;
            setIsScreenSharing(false);

            // 全ての localStreams も停止
            localStreamsRef.current.forEach((stream, _id) => {
                stream.getTracks().forEach(t => t.stop());
            });
            setLocalStreams(new Map());
            localStreamsRef.current.clear();

            // ピア側のトラック削除と再交渉も必要
            peerConnectionsRef.current.forEach(async (pc, peerId) => {
                pc.getSenders().forEach(sender => {
                    if (sender.track?.kind === 'video') pc.removeTrack(sender);
                });
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    signalingRef.current?.sendOffer(peerId, offer);
                } catch (e) { /* ignore */ }
            });

            // Adaptive Bitrate Control クリーンアップ
            if (bandwidthMonitorRef.current) {
                bandwidthMonitorRef.current.stop();
                bandwidthMonitorRef.current = null;
            }
            adaptiveControllerRef.current = null;
            setConnectionQuality(null);
        }
        // 共有が止まったらリレー送信も止める
        stopRelayLoop();
    }, [setConnectionState, stopRelayLoop]);

    /**
     * 画面共有
     */
    /**
     * 画面共有
     */
    const startScreenShare = useCallback(async (config: QualityConfig = {
        resolution: '1080p',
        frameRate: 60,
        bitrate: 'auto',
        codec: 'av1',
        contentHint: 'motion'
    }) => {
        try {
            // Build constraints based on config
            let width: number | undefined;
            let height: number | undefined;

            if (config.resolution === 'native') {
                width = 3840; height = 2160;
            } else if (config.resolution === '1080p') {
                width = 1920; height = 1080;
            } else if (config.resolution === '720p') {
                width = 1280; height = 720;
            }

            const constraints: MediaStreamConstraints = {
                video: {
                    cursor: 'motion',
                    width: width ? { ideal: width } : undefined,
                    height: height ? { ideal: height } : undefined,
                    frameRate: { ideal: config.frameRate, max: config.frameRate }
                } as MediaTrackConstraints,
                audio: true
            };

            console.log('[WebRTC] Requesting DisplayMedia with:', constraints);
            const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
            const streamId = `screen-${Date.now()}`;

            // Apply contentHint
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack && 'contentHint' in videoTrack) {
                (videoTrack as any).contentHint = config.contentHint;
            }

            // メインストリームとしても保持（既存互換）
            if (!localStream) {
                setLocalStream(stream);
                localStreamRef.current = stream;
            }

            // 複数管理に追加
            setLocalStreams(prev => {
                const next = new Map(prev);
                next.set(streamId, stream);
                return next;
            });
            localStreamsRef.current.set(streamId, stream);
            setIsScreenSharing(true);

            // 全ピアに追加
            peerConnectionsRef.current.forEach(async (pc, peerId) => {
                const videoSender = pc.addTrack(videoTrack, stream);

                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    pc.addTrack(audioTrack, stream);
                }

                // Apply Codec Preferences AFTER adding track (transceiver is created)
                console.log(`[WebRTC] Setting codec preferences for peer: ${peerId}, codec: ${config.codec}`);
                prioritizeCodecs(pc, config.codec);

                // Renegotationが必要
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    signalingRef.current?.sendOffer(peerId, offer);
                } catch (e) {
                    console.error('[WebRTC] Renegotiation failed:', e);
                }

                // Adaptive Bitrate Control: 監視開始 (最初のストリームのみ)
                if (isAdaptiveModeEnabled && !bandwidthMonitorRef.current) {
                    if (videoSender) {
                        // ... (same as before)
                    }
                }
            });

            stream.getVideoTracks()[0].onended = () => stopScreenShare(streamId);
        } catch (e) {
            console.error('[WebRTC] Screen share failed:', e);
            setError('画面共有の開始に失敗しました');
        }
    }, [setError, isAdaptiveModeEnabled, stopScreenShare, localStream]);

    /**
     * カスタム画面共有 (Tauri-Canvas Bridge)
     */
    const startCustomScreenShare = useCallback(async (sourceId: string, isMonitor: boolean, config: QualityConfig = {
        resolution: '720p', // IPC負荷を考慮してデフォルトは控えめに
        frameRate: 30,      // 同上
        bitrate: 'auto',
        codec: 'av1',
        contentHint: 'motion'
    }) => {
        try {
            console.log(`[WebRTC] Starting custom screen share for ${sourceId} (monitor: ${isMonitor})`);

            // Canvasを準備
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error("Could not get canvas context");

            // ストリームを作成
            const stream = (canvas as any).captureStream(config.frameRate) as MediaStream;
            const streamId = `custom-${sourceId}-${Date.now()}`;

            // 解像度設定
            let targetWidth: number | undefined;
            let targetHeight: number | undefined;
            if (config.resolution === '1080p') { targetWidth = 1920; targetHeight = 1080; }
            else if (config.resolution === '720p') { targetWidth = 1280; targetHeight = 720; }

            // キャプチャループ（シンプル版）
            let isRunning = true;

            const captureLoop = async () => {
                if (!isRunning) return;

                try {
                    // Base64 Data URL として取得
                    const dataUrl = await invoke<string>('get_source_frame', {
                        id: sourceId,
                        isMonitor,
                        width: targetWidth,
                        height: targetHeight
                    });

                    if (!isRunning) return;

                    if (dataUrl && dataUrl.startsWith('data:')) {
                        const img = new Image();
                        img.onload = () => {
                            if (canvas.width !== img.width || canvas.height !== img.height) {
                                canvas.width = img.width;
                                canvas.height = img.height;
                            }
                            ctx.drawImage(img, 0, 0);

                            // 次のフレームをスケジュール
                            if (isRunning) {
                                requestAnimationFrame(captureLoop);
                            }
                        };
                        img.onerror = (e) => {
                            console.error('[WebRTC] Image load error:', e);
                            if (isRunning) setTimeout(captureLoop, 100);
                        };
                        img.src = dataUrl;
                    } else {
                        console.warn('[WebRTC] Invalid frame data received');
                        if (isRunning) setTimeout(captureLoop, 100);
                    }
                } catch (e) {
                    console.error("[WebRTC] Capture loop error:", e);
                    if (isRunning) setTimeout(captureLoop, 1000);
                }
            };
            captureLoop();

            // 終了処理をトラックに関連付け
            const videoTrack = stream.getVideoTracks()[0];
            const originalStop = videoTrack.stop.bind(videoTrack);
            videoTrack.stop = () => {
                isRunning = false;
                originalStop();
            };

            // 以降は通常の画面共有と同様
            if (!localStream) {
                setLocalStream(stream);
                localStreamRef.current = stream;
            }

            setLocalStreams(prev => {
                const next = new Map(prev);
                next.set(streamId, stream);
                return next;
            });
            localStreamsRef.current.set(streamId, stream);
            setIsScreenSharing(true);

            // WSリレー視聴者が既にいればフレーム送信を開始
            if (relaySubscribersRef.current.size > 0) ensureRelayLoop();

            peerConnectionsRef.current.forEach(async (pc, peerId) => {
                pc.addTrack(videoTrack, stream);

                // Apply Codec Preferences AFTER adding track (transceiver is created)
                console.log(`[WebRTC] Setting codec preferences for custom share. Peer: ${peerId}, codec: ${config.codec}`);
                prioritizeCodecs(pc, config.codec);

                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    signalingRef.current?.sendOffer(peerId, offer);
                } catch (e) {
                    console.error('[WebRTC] Renegotiation failed:', e);
                }
            });

            videoTrack.onended = () => stopScreenShare(streamId);

        } catch (e) {
            console.error('[WebRTC] Custom screen share failed:', e);
            setError('カスタム画面共有の開始に失敗しました');
        }
    }, [setError, isAdaptiveModeEnabled, stopScreenShare, localStream]);

    // チャット送信
    const sendChatMessage = useCallback((text: string) => {
        const msg: ChatMessageData = {
            id: crypto.randomUUID(),
            senderId: myId || 'me',
            senderName: 'Me',
            content: text,
            timestamp: Date.now(),
            isHost: false
        };
        broadcastData('chat', msg);
        // WSリレー: DataChannelを持たない視聴者 (Linux等) へも届ける
        if (relayModeRef.current || relaySubscribersRef.current.size > 0) {
            const targets = relayModeRef.current
                ? Array.from(participantsRef.current.keys()).filter(id => id !== myId)
                : Array.from(relaySubscribersRef.current);
            targets.forEach(t => signalingRef.current?.sendRelay(t, 'chat', msg));
        }
        setChatMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
    }, [broadcastData, myId]);

    // マイク機能
    const startMicrophone = useCallback(async () => {
        try {
            // 既存のVADリソースをクリーンアップ（多重起動防止）
            if (vadIntervalRef.current) {
                clearInterval(vadIntervalRef.current);
                vadIntervalRef.current = null;
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = null;
            }
            analyserRef.current = null;
            setIsSpeaking(false);

            const constraints: MediaStreamConstraints = {
                audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            localAudioStreamRef.current = stream;
            const audioTrack = stream.getAudioTracks()[0];
            audioTrackRef.current = audioTrack;
            setIsMicEnabled(true);
            setIsMuted(false);

            // 発話検出 (Voice Activity Detection) のセットアップ
            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            analyserRef.current = analyser;

            // 音量監視インターバル
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            vadIntervalRef.current = window.setInterval(() => {
                // ミュート時は発話なし扱い
                if (!analyserRef.current || !audioTrackRef.current?.enabled) {
                    setIsSpeaking(false);
                    return;
                }
                analyserRef.current.getByteFrequencyData(dataArray);
                // 平均音量を計算
                const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                setIsSpeaking(average > VAD_THRESHOLD);
            }, VAD_INTERVAL_MS);

            // 全ピアに音声トラックを追加
            peerConnectionsRef.current.forEach(async (pc, _peerId) => { // peerId -> _peerId
                const senders = pc.getSenders();
                // システム音声 (F-031) のセンダーは置き換えず、マイク専用のセンダーを探す
                const audioSender = senders.find(s =>
                    s.track?.kind === 'audio' && s.track !== systemAudioSessionRef.current?.track
                );

                if (audioSender) {
                    await audioSender.replaceTrack(audioTrack);
                } else {
                    pc.addTrack(audioTrack, stream);
                }
            });

            console.log('[WebRTC] Microphone started with VAD');
        } catch (e) {
            console.error('[WebRTC] Microphone start failed:', e);
            setError('マイクの開始に失敗しました');
        }
    }, [selectedDeviceId, setError, VAD_THRESHOLD, VAD_INTERVAL_MS]);

    const stopMicrophone = useCallback(() => {
        // 発話検出のクリーンアップ
        if (vadIntervalRef.current) {
            clearInterval(vadIntervalRef.current);
            vadIntervalRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        analyserRef.current = null;
        setIsSpeaking(false);

        // マイクストリームの停止
        if (localAudioStreamRef.current) {
            localAudioStreamRef.current.getTracks().forEach(t => t.stop());
            localAudioStreamRef.current = null;
        }
        audioTrackRef.current = null;
        setIsMicEnabled(false);
        setIsMuted(false);
        console.log('[WebRTC] Microphone stopped');
    }, []);

    const toggleMute = useCallback(() => {
        if (audioTrackRef.current) {
            audioTrackRef.current.enabled = !audioTrackRef.current.enabled;
            setIsMuted(!audioTrackRef.current.enabled);
            console.log('[WebRTC] Mute toggled:', !audioTrackRef.current.enabled);
        }
    }, []);

    /**
     * システム音声の共有を開始 (F-031)
     * Rust (WASAPI ループバック) が生成したトラックを全ピアへ追加する。
     */
    const startSystemAudio = useCallback(async () => {
        if (systemAudioSessionRef.current) return;
        try {
            const session = await startSystemAudioCapture();
            systemAudioSessionRef.current = session;

            peerConnectionsRef.current.forEach(async (pc, peerId) => {
                pc.addTrack(session.track, session.stream);
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    signalingRef.current?.sendOffer(peerId, offer);
                } catch (e) {
                    console.error('[WebRTC] SystemAudio renegotiation failed:', e);
                }
            });

            setIsSystemAudioEnabled(true);

            // リレー視聴者がいれば音声も送る (session.streamをMediaRecorderへ)
            if (relaySubscribersRef.current.size > 0) startRelayAudioSend();
        } catch (e) {
            console.error('[WebRTC] System audio start failed:', e);
            setError('システム音声の共有に失敗しました');
        }
    }, [setError, startRelayAudioSend]);

    /**
     * システム音声の共有を停止 (F-031)
     */
    const stopSystemAudio = useCallback(async () => {
        const session = systemAudioSessionRef.current;
        if (!session) return;
        systemAudioSessionRef.current = null;
        setIsSystemAudioEnabled(false);
        stopRelayAudioSend();

        peerConnectionsRef.current.forEach(async (pc, peerId) => {
            const sender = pc.getSenders().find(s => s.track === session.track);
            if (sender) pc.removeTrack(sender);
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signalingRef.current?.sendOffer(peerId, offer);
            } catch (e) {
                console.error('[WebRTC] SystemAudio stop renegotiation failed:', e);
            }
        });

        await session.stop();
        console.log('[WebRTC] System audio sharing stopped');
    }, [stopRelayAudioSend]);

    // 音声デバイス列挙
    const refreshAudioDevices = useCallback(async () => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            setAudioDevices(audioInputs);
            if (audioInputs.length > 0 && !selectedDeviceId) {
                setSelectedDeviceId(audioInputs[0].deviceId);
            }
            console.log('[WebRTC] Audio devices:', audioInputs.length);
        } catch (e) {
            console.error('[WebRTC] Failed to enumerate audio devices:', e);
        }
    }, [selectedDeviceId]);

    // モニター列挙 (Tauri API)
    const refreshMonitors = useCallback(async (): Promise<MonitorInfo[]> => {
        try {
            const result = await invoke<MonitorInfo[]>('get_monitors');
            setMonitors(result);
            console.log('[WebRTC] Monitors refreshed:', result);
            return result;
        } catch (e) {
            console.error('[WebRTC] Failed to refresh monitors:', e);
            return [];
        }
    }, []);


    /**
     * E2Eテスト用: 全ピアの送受信バイト統計を取得
     */
    const getPeerStats = useCallback(async () => {
        const out: { peerId: string; type: string; kind: string; bytes: number }[] = [];
        for (const [peerId, pc] of peerConnectionsRef.current) {
            try {
                const stats = await pc.getStats();
                stats.forEach(r => {
                    if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
                        out.push({ peerId, type: r.type, kind: r.kind, bytes: r.bytesSent });
                    }
                    if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
                        out.push({ peerId, type: r.type, kind: r.kind, bytes: r.bytesReceived });
                    }
                });
            } catch { /* 統計取得失敗は無視 */ }
        }
        return out;
    }, []);

    /**
     * E2E/デバッグ用: WSリレーの受信統計
     */
    const getRelayStats = useCallback(() => ({
        ...relayStatsRef.current,
        subscribers: relaySubscribersRef.current.size,
        mseSubscribers: Array.from(relayCapsRef.current.values()).filter(c => c.mse).length,
        audioSubscribers: Array.from(relayCapsRef.current.values()).filter(c => c.webmAudio).length,
    }), []);

    // クリーンアップ
    useEffect(() => {
        return () => {
            // unmount cleanup
            leaveRoom();
        };
    }, []);

    // 発話状態のブロードキャスト
    useEffect(() => {
        if (isConnectedRef.current) {
            broadcastData('speaking', { isSpeaking });
        }
    }, [isSpeaking, broadcastData]);

    return {
        localStream,
        remoteStreams,
        createRoom,
        joinRoom,
        leaveRoom,
        isConnected: connectionState === 'peer-connected' || connectionState === 'connected',
        roomCode: useConnectionStore(s => s.roomCode),
        error: useConnectionStore(s => s.error),
        participants,
        myId,

        // WSリレーモード (WebRTC非対応エンジン向け)
        isRelayMode,
        relayFrame,
        relayVideoUrl,
        relayAudioUrl,
        getRelayStats,

        startScreenShare,
        startCustomScreenShare,
        stopScreenShare,
        isScreenSharing,
        localStreams,

        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMicEnabled,
        isMuted,
        isSpeaking,

        // システム音声 (F-031)
        startSystemAudio,
        stopSystemAudio,
        isSystemAudioEnabled,

        audioDevices,
        selectedDeviceId,
        setSelectedDeviceId,
        refreshAudioDevices,

        monitors,
        selectedMonitorName,
        setSelectedMonitorName,
        refreshMonitors,

        chatMessages,
        sendChatMessage,
        stats,

        // リモートピア発話状態
        remoteSpeakingStates,

        // リモート操作 (F-022)
        remoteControlAllowed,
        setRemoteControlAllowed,
        peerControlAllowed,
        sendInputToPeer,

        // Adaptive Bitrate Control
        connectionQuality,
        isAdaptiveModeEnabled,
        setAdaptiveModeEnabled,

        // E2Eテスト用統計
        getPeerStats,
    };
}
