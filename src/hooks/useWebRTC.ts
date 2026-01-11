/**
 * P2D - WebRTC接続管理フック (Full Mesh P2P Update)
 * 
 * RTCPeerConnectionの作成・管理、メディアストリーム処理を行う。
 * 参加者全員とフルメッシュ接続を確立する。
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
// import { invoke } from '@tauri-apps/api/core';
import { useConnectionStore } from '../stores/connectionStore';
import { SignalingClient, ParticipantInfo } from '../lib/signalingClient';
import type { QualityConfig } from '../components/QualitySettings';
import type { ChatMessageData } from '../lib/dataChannel';
import { BandwidthMonitor, type BandwidthStats } from '../lib/bandwidthMonitor';
import { AdaptiveController } from '../lib/adaptiveController';

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
    createRoom: (name?: string) => void;
    joinRoom: (roomCode: string, name?: string) => void;
    leaveRoom: () => void;

    // 状態
    roomCode: string | null;
    isConnected: boolean;
    error: string | null;
    participants: Map<string, ParticipantInfo>;
    myId: string | null;

    // 画面共有
    startScreenShare: (config?: QualityConfig) => Promise<void>;
    stopScreenShare: () => void;
    isScreenSharing: boolean;

    // マイク
    startMicrophone: () => Promise<void>;
    stopMicrophone: () => void;
    toggleMute: () => void;
    isMicEnabled: boolean;
    isMuted: boolean;
    isSpeaking: boolean;

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
    const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

    const localStreamRef = useRef<MediaStream | null>(null);

    // オーディオ
    const [isMicEnabled, setIsMicEnabled] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const localAudioStreamRef = useRef<MediaStream | null>(null);
    const audioTrackRef = useRef<MediaStreamTrack | null>(null);
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    const [isSpeaking, setIsSpeaking] = useState(false);

    // 発話検出用 (Voice Activity Detection)
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const vadIntervalRef = useRef<number | null>(null);
    const VAD_THRESHOLD = 30; // 音量閾値（0-255）
    const VAD_INTERVAL_MS = 100; // チェック間隔

    // 画面共有
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    // const [monitors, setMonitors] = useState<MonitorInfo[]>([]); // unused
    const monitors: MonitorInfo[] = []; // stub
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
                }
                // 他のメッセージタイプ（controlなど）は必要に応じて追加
            } catch (e) {
                console.error('[DataChannel] Parse error:', e);
            }
        };
    }, [connectionState, setConnectionState]);

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

        // Track受信 (映像/音声)
        pc.ontrack = (event) => {
            console.log(`[WebRTC] Track受信: ${peerId} (${event.track.kind})`);
            const stream = event.streams[0] || new MediaStream([event.track]);

            setRemoteStreams(prev => {
                const newMap = new Map(prev);
                // 既存のストリームがあればトラックを追加/更新、なければ新規
                if (newMap.has(peerId)) {
                    const existing = newMap.get(peerId)!;
                    // トラックがまだなければ追加
                    if (!existing.getTracks().some(t => t.id === event.track.id)) {
                        existing.addTrack(event.track);
                    }
                    return newMap; // 参照が変わらないと再レンダリングされないかも？
                    // 本当は新しいMediaStreamを作ったほうがReact的
                    /*
                    const updatedStream = new MediaStream(existing.getTracks());
                    updatedStream.addTrack(event.track);
                    newMap.set(peerId, updatedStream);
                    */
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
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!);
            });
        }
        if (localAudioStreamRef.current) {
            localAudioStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localAudioStreamRef.current!); // Stream分けるべきか？
            });
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
    }, [iceServers, setupDataChannel]);

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
        });

        signaling.on('onDisconnected', () => {
            setConnectionState('disconnected');
            isConnectedRef.current = false;
        });

        // 自分の参加完了通知 (既存参加者リストが来る)
        signaling.on('onRoomJoined', (_roomId, code, myClientId, existingParticipants) => {
            setRoomCode(code);
            setMyId(myClientId);
            isConnectedRef.current = true;

            // 参加者リスト更新
            const pMap = new Map<string, ParticipantInfo>();
            existingParticipants.forEach(p => pMap.set(p.id, p));
            setParticipants(pMap);

            // **Full Mesh Logic**: 既存の参加者全員に対して Initiator となり接続開始
            existingParticipants.forEach(p => {
                createPeerConnection(p.id, true); // Initiator = true
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

        signaling.on('onOffer', async (senderId, sdp) => {
            const pc = createPeerConnection(senderId, false); // PC取得または作成(受信側)
            try {
                if (pc.signalingState !== 'stable') {
                    // ロールバックなどの処理が必要な場合もあるが簡易実装
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
                console.error('[WebRTC] Offer処理失敗:', e);
            }
        });

        signaling.on('onAnswer', async (senderId, sdp) => {
            const pc = peerConnectionsRef.current.get(senderId);
            if (pc) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                } catch (e) {
                    console.error('[WebRTC] Answer処理失敗:', e);
                }
            }
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

        await signaling.connect();
    }, [setConnectionState, setRoomCode, createPeerConnection, targetSignalingUrl]);

    /**
     * ルーム作成・参加
     */
    const createRoom = useCallback(async (name?: string) => {
        await connect();
        signalingRef.current?.createRoom(name);
    }, [connect]);

    const joinRoom = useCallback(async (code: string, name?: string) => {
        await connect();
        signalingRef.current?.joinRoom(code, name);
    }, [connect]);

    /**
     * 切断
     */
    const leaveRoom = useCallback(() => {
        signalingRef.current?.leaveRoom();
        signalingRef.current?.disconnect();
        signalingRef.current = null;

        peerConnectionsRef.current.forEach(pc => pc.close());
        peerConnectionsRef.current.clear();
        dataChannelsRef.current.clear();

        localStreamRef.current?.getTracks().forEach(t => t.stop());
        setLocalStream(null);
        localStreamRef.current = null;

        setParticipants(new Map());
        setRemoteStreams(new Map());
        reset();
    }, [reset]);

    /**
     * 画面共有停止 (先に定義が必要)
     */
    const stopScreenShare = useCallback(() => {
        // Adaptive Bitrate Control クリーンアップ
        if (bandwidthMonitorRef.current) {
            bandwidthMonitorRef.current.stop();
            bandwidthMonitorRef.current = null;
        }
        adaptiveControllerRef.current = null;
        setConnectionQuality(null);

        localStreamRef.current?.getTracks().forEach(t => t.stop());
        setLocalStream(null);
        localStreamRef.current = null;
        setIsScreenSharing(false);
    }, []);

    /**
     * 画面共有
     */
    const startScreenShare = useCallback(async (_config?: QualityConfig) => {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    // @ts-ignore: cursor is not in standard definition but supported by browsers
                    cursor: 'motion'
                } as MediaTrackConstraints,
                audio: true
            });

            setLocalStream(stream);
            localStreamRef.current = stream;
            setIsScreenSharing(true);

            // 全ピアに追加/置換
            peerConnectionsRef.current.forEach(async (pc, _peerId) => {
                // 既存のビデオSenderを探す
                const senders = pc.getSenders();
                const videoSender = senders.find(s => s.track?.kind === 'video');

                // Track
                const videoTrack = stream.getVideoTracks()[0];
                const audioTrack = stream.getAudioTracks()[0];

                if (videoSender) {
                    await videoSender.replaceTrack(videoTrack);
                } else {
                    pc.addTrack(videoTrack, stream);
                    // Audioも
                    if (audioTrack && !senders.find(s => s.track?.kind === 'audio')) {
                        pc.addTrack(audioTrack, stream);
                    }

                    // Renegotationが必要
                    // manually trigger offer if needed
                    /*
                    if (!pc.onnegotiationneeded) { // セットされてない場合(Receiver)など
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        signalingRef.current?.sendOffer(peerId, offer);
                    }
                    */
                }

                // Adaptive Bitrate Control: 監視開始
                if (isAdaptiveModeEnabled && !bandwidthMonitorRef.current) {
                    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (videoSender) {
                        // AdaptiveController初期化
                        adaptiveControllerRef.current = new AdaptiveController();
                        adaptiveControllerRef.current.setSender(videoSender);

                        // BandwidthMonitor初期化
                        bandwidthMonitorRef.current = new BandwidthMonitor(pc, (stats) => {
                            setConnectionQuality(stats);

                            // TURN検出
                            if (stats.candidateType === 'relay' && adaptiveControllerRef.current) {
                                adaptiveControllerRef.current.setRelayConnection(true);
                            }

                            // 自動調整
                            if (isAdaptiveModeEnabled && adaptiveControllerRef.current) {
                                adaptiveControllerRef.current.adjustBasedOnStats(stats);
                            }
                        });
                        bandwidthMonitorRef.current.start(2000);
                        console.log('[WebRTC] Adaptive Bitrate Control 開始');
                    }
                }
            });

            stream.getVideoTracks()[0].onended = () => stopScreenShare();
        } catch (e) {
            console.error('[WebRTC] Screen share failed:', e);
            setError('画面共有の開始に失敗しました');
        }
    }, [setError, isAdaptiveModeEnabled, stopScreenShare]);

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
        setChatMessages(prev => [...prev, msg]);
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
                const audioSender = senders.find(s => s.track?.kind === 'audio');

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

    // モニター列挙 (Tauri API使用予定、現状はWeb API mock)
    const refreshMonitors = useCallback(async (): Promise<MonitorInfo[]> => {
        // TODO: Tauri APIでモニター一覧取得
        console.log('[WebRTC] refreshMonitors called (no-op for now)');
        return [];
    }, []);


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

        startScreenShare,
        stopScreenShare,
        isScreenSharing,

        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMicEnabled,
        isMuted,
        isSpeaking,

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

        // Adaptive Bitrate Control
        connectionQuality,
        isAdaptiveModeEnabled,
        setAdaptiveModeEnabled,
    };
}
