/**
 * P2D - WebRTC接続管理フック
 * 
 * RTCPeerConnectionの作成・管理、メディアストリーム処理を行う。
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useConnectionStore } from '../stores/connectionStore';
import { SignalingClient } from '../lib/signalingClient';
import type { QualityConfig } from '../components/QualitySettings';
import type {
    ChatMessageData,
    DataChannelMessageType,
    MouseMoveData,
    ClickData,
    ScrollData,
    KeyData,
    ClipboardData
} from '../lib/dataChannel';

// シグナリングサーバーURL（デフォルト）
const DEFAULT_SIGNALING_URL = 'ws://localhost:8080';

// ICEサーバー設定
const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// コーデック優先順位: AV1 > H.265 > H.264 > VP9 > VP8
const PREFERRED_CODECS = ['AV1', 'H265', 'H264', 'VP9', 'VP8'];

export interface UseWebRTCOptions {
    isHost: boolean;
}

export interface UseWebRTCReturn {
    // ストリーム
    localStream: MediaStream | null;
    remoteStream: MediaStream | null;

    // 接続操作
    connect: () => Promise<void>;
    disconnect: () => void;

    // ホスト操作
    createRoom: (hostName?: string) => void;
    startScreenShare: (config?: QualityConfig) => Promise<void>;
    stopScreenShare: () => void;

    // ビューア操作
    joinRoom: (roomCode: string, viewerName?: string) => void;

    // 状態
    roomCode: string | null;
    isConnected: boolean;
    error: string | null;

    // 統計用（最初のピア接続を返す）
    peerConnection: RTCPeerConnection | null;

    // 接続中のピア一覧
    connectedPeers: string[];

    // DataChannel / チャット
    chatMessages: ChatMessageData[];
    sendChatMessage: (text: string) => boolean;
    sendData: (type: DataChannelMessageType, data: any) => boolean;
    isDataChannelOpen: boolean;

    // リモート操作
    isRemoteControlEnabled: boolean;
    toggleRemoteControl: () => void;

    // 統計情報 (NEW)
    stats: WebRTCStats | null;

    // 遅延制御 (NEW)
    setPlayoutDelay: (delaySeconds: number) => void;

    // モニター情報 (NEW)
    monitors: MonitorInfo[];
    selectedMonitorName: string | null;
    setSelectedMonitorName: (name: string | null) => void;
    refreshMonitors: () => Promise<MonitorInfo[]>;

    // ボイスチャット (NEW)
    isMicEnabled: boolean;
    remoteAudioStream: MediaStream | null;
    startMicrophone: () => Promise<void>;
    stopMicrophone: () => void;
    toggleMute: () => void;
    isMuted: boolean;
}

export interface MonitorInfo {
    name: string;
    width: number;
    height: number;
    x: number;
    y: number;
}

export interface WebRTCStats {
    fps: number;
    bitrate: number; // bps
    packetLoss: number;
    resolution: { width: number; height: number };
    codec: string;
}

export function useWebRTC({ isHost }: UseWebRTCOptions): UseWebRTCReturn {
    // シグナリングクライアント
    const signalingRef = useRef<SignalingClient | null>(null);

    // ピア接続（ホスト: 複数ビューア、ビューア: ホストへの単一接続）
    const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

    // ストリーム（refで管理して依存関係を防ぐ）
    const localStreamRef = useRef<MediaStream | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

    // 品質設定（refで保持）
    const qualityConfigRef = useRef<QualityConfig | null>(null);

    // 接続済みフラグ
    const isConnectedRef = useRef(false);

    // DataChannel関連
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);
    const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);

    // 接続中のピア一覧
    const [connectedPeers, setConnectedPeers] = useState<string[]>([]);

    // リモート操作許可フラグ
    const [isRemoteControlEnabled, setIsRemoteControlEnabled] = useState(false);

    // 状態管理
    const {
        connectionState,
        roomCode,
        error,
        setConnectionState,
        setRoomCode,
        setError,
        setIsHost,
        reset,
    } = useConnectionStore();

    // モニター情報 (NEW)
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [selectedMonitorName, setSelectedMonitorName] = useState<string | null>(null);
    const selectedMonitorNameRef = useRef<string | null>(null);

    useEffect(() => {
        selectedMonitorNameRef.current = selectedMonitorName;
    }, [selectedMonitorName]);

    const refreshMonitors = useCallback(async () => {
        try {
            const list = await invoke<MonitorInfo[]>('get_monitors');
            setMonitors(list);
            return list;
        } catch (e) {
            console.error('Failed to get monitors:', e);
            return [];
        }
    }, []);

    // ビューアからホストID（ビューア用）取得
    const hostIdRef = useRef<string | null>(null);

    // ボイスチャット (NEW)
    const [isMicEnabled, setIsMicEnabled] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
    const audioTrackRef = useRef<MediaStreamTrack | null>(null);
    const localAudioStreamRef = useRef<MediaStream | null>(null);

    /**
     * DataChannelでデータを送信
     */
    const sendData = useCallback((type: DataChannelMessageType, data: any): boolean => {
        const channel = dataChannelRef.current;
        if (!channel || channel.readyState !== 'open') {
            return false;
        }

        const message = {
            type,
            timestamp: Date.now(),
            data,
        };

        try {
            channel.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('[WebRTC] DataChannel送信エラー:', error);
            return false;
        }
    }, []);

    /**
     * チャットメッセージを送信
     */
    const sendChatMessage = useCallback((text: string): boolean => {
        const messageData: ChatMessageData = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            sender: isHost ? 'host' : 'viewer',
            text,
        };

        if (sendData('chat:message', messageData)) {
            setChatMessages((prev) => [...prev, messageData]);
            return true;
        }
        return false;
    }, [isHost, sendData]);

    /**
     * RTCPeerConnectionを作成
     */
    const createPeerConnection = useCallback((peerId: string): RTCPeerConnection => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        // ICE候補が見つかった時
        pc.onicecandidate = (event) => {
            if (event.candidate && signalingRef.current) {
                signalingRef.current.sendIceCandidate(peerId, event.candidate.toJSON());
            }
        };

        // 接続状態変更
        pc.onconnectionstatechange = () => {
            // console.log(`[WebRTC] 接続状態 (${peerId}): ${pc.connectionState}`);
            if (pc.connectionState === 'connected') {
                setConnectionState('peer-connected');
                // 接続確立時にリストに追加（重複チェック）
                if (isHost) {
                    setConnectedPeers(prev => prev.includes(peerId) ? prev : [...prev, peerId]);
                }
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                peerConnectionsRef.current.delete(peerId);
                // 切断時にリストから削除
                if (isHost) {
                    setConnectedPeers(prev => prev.filter(id => id !== peerId));
                }
            }
        };

        // リモートストリーム受信（ビューア側）
        if (!isHost) {
            pc.ontrack = (event) => {
                // console.log('[WebRTC] リモートトラック受信:', event.track.kind);
                if (event.track.kind === 'video' && event.streams[0]) {
                    setRemoteStream(event.streams[0]);
                } else if (event.track.kind === 'audio' && event.streams[0]) {
                    setRemoteAudioStream(event.streams[0]);
                }
            };

            // DataChannel受信（ビューア側）
            pc.ondatachannel = (event) => {
                // console.log('[WebRTC] DataChannel受信:', event.channel.label);
                setupDataChannel(event.channel);
            };
        }

        peerConnectionsRef.current.set(peerId, pc);
        return pc;
    }, [isHost, setConnectionState]);

    /**
     * DataChannelをセットアップ
     */
    const setupDataChannel = useCallback((channel: RTCDataChannel) => {
        dataChannelRef.current = channel;

        channel.onopen = () => {
            // console.log('[WebRTC] DataChannel開始');
            setIsDataChannelOpen(true);
        };

        channel.onclose = () => {
            // console.log('[WebRTC] DataChannel終了');
            setIsDataChannelOpen(false);
        };

        channel.onerror = (event) => {
            console.error('[WebRTC] DataChannelエラー:', event);
        };

        channel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                // console.log('[WebRTC] DataChannel受信:', message.type);

                if (message.type === 'chat:message') {
                    setChatMessages((prev) => [...prev, message.data as ChatMessageData]);
                } else if (message.type === 'clipboard:update') {
                    // クリップボード更新: ビューアは常に、ホストは操作許可時のみ処理
                    if (!isHost || isRemoteControlEnabledRef.current) {
                        handleInputMessage(message.type, message.data);
                    }
                } else if (isHost && isRemoteControlEnabledRef.current) {
                    // ホストかつリモート操作許可時のみコマンド実行
                    handleInputMessage(message.type, message.data);
                }
            } catch (error) {
                console.error('[WebRTC] DataChannelパースエラー:', error);
            }
        };
    }, [isHost]);

    // isRemoteControlEnabledのrefを作成（callback内で最新値を参照するため）
    const isRemoteControlEnabledRef = useRef(isRemoteControlEnabled);
    useEffect(() => {
        isRemoteControlEnabledRef.current = isRemoteControlEnabled;
    }, [isRemoteControlEnabled]);

    // 統計情報 (NEW)
    const [stats, setStats] = useState<WebRTCStats | null>(null);
    const lastStatsRef = useRef<{ timestamp: number; bytes: number } | null>(null);

    useEffect(() => {
        if (connectedPeers.length === 0) {
            setStats(null);
            return;
        }

        const interval = setInterval(async () => {
            // 最初のピアの統計を取得
            const peerId = connectedPeers[0];
            const pc = peerConnectionsRef.current.get(peerId);
            if (!pc) return;

            try {
                const report = await pc.getStats();
                let fps = 0;
                let width = 0;
                let height = 0;
                let currentBytes = 0;
                let packetLoss = 0;
                let codec = '';

                // レポート解析
                for (const stat of report.values()) {
                    if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
                        // ホスト送信
                        fps = stat.framesPerSecond || 0;
                        width = stat.frameWidth || 0;
                        height = stat.frameHeight || 0;
                        currentBytes = stat.bytesSent || 0;
                    } else if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                        // ビューア受信
                        fps = stat.framesPerSecond || 0;
                        width = stat.frameWidth || 0;
                        height = stat.frameHeight || 0;
                        currentBytes = stat.bytesReceived || 0;
                        packetLoss = stat.packetsLost || 0;
                    }
                }

                // ビットレート計算 (bps)
                const now = Date.now();
                let bitrate = 0;
                if (lastStatsRef.current) {
                    const deltaMs = now - lastStatsRef.current.timestamp;
                    const deltaBytes = currentBytes - lastStatsRef.current.bytes;
                    if (deltaMs > 0 && deltaBytes >= 0) {
                        bitrate = (deltaBytes * 8) / (deltaMs / 1000);
                    }
                }
                lastStatsRef.current = { timestamp: now, bytes: currentBytes };

                setStats({
                    fps: Math.round(fps),
                    bitrate: Math.round(bitrate),
                    packetLoss,
                    resolution: { width, height },
                    codec
                });
            } catch (e) {
                console.warn('[WebRTC] 統計取得エラー:', e);
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [connectedPeers]);

    // クリップボード監視（ホスト側）
    useEffect(() => {
        if (!isHost) return;

        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            unlisten = await listen<string>('clipboard-changed', (event) => {
                // console.log('[WebRTC] クリップボード変更検知:', event.payload);
                const data: ClipboardData = { text: event.payload };
                sendData('clipboard:update', data);
            });
        };

        setupListener();

        return () => {
            if (unlisten) unlisten();
        };
    }, [isHost, sendData]);

    /**
     * 入力メッセージを処理してTauriコマンドを実行
     */
    const handleInputMessage = async (type: DataChannelMessageType, data: any) => {
        try {
            switch (type) {
                case 'input:mouse_move':
                    const moveData = data as MouseMoveData;
                    await invoke('simulate_mouse_move', {
                        x: moveData.x,
                        y: moveData.y,
                        monitorName: selectedMonitorNameRef.current
                    });
                    break;
                case 'input:click':
                    const clickData = data as ClickData;
                    await invoke('simulate_click', { button: clickData.button });
                    break;
                case 'input:scroll':
                    const scrollData = data as ScrollData;
                    await invoke('simulate_scroll', { deltaX: scrollData.deltaX, deltaY: scrollData.deltaY });
                    break;
                case 'input:key':
                    const keyData = data as KeyData;
                    await invoke('simulate_key', { key: keyData.key });
                    break;
                case 'clipboard:update':
                    const clipboardData = data as ClipboardData;
                    if (isHost) {
                        // ホスト: Rustコマンドで書き込み
                        await invoke('write_clipboard', { text: clipboardData.text });
                    } else {
                        // ビューア: ブラウザAPIで書き込み
                        try {
                            await navigator.clipboard.writeText(clipboardData.text);
                            // console.log('[WebRTC] クリップボード受信:', clipboardData.text);
                        } catch (e) {
                            console.warn('[WebRTC] クリップボード書き込み失敗:', e);
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('[WebRTC] リモート操作エラー:', error);
        }
    };



    /**
     * リモート操作の許可切り替え
     */
    const toggleRemoteControl = useCallback(() => {
        setIsRemoteControlEnabled(prev => !prev);
    }, []);

    /**
     * コーデック優先順位を設定
     */
    const setCodecPreferences = useCallback((pc: RTCPeerConnection) => {
        const config = qualityConfigRef.current;
        const preferredCodec = config?.codec; // 'auto' | 'av1' | ...

        const transceivers = pc.getTransceivers();

        for (const transceiver of transceivers) {
            if (transceiver.sender.track?.kind === 'video') {
                const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];

                // 優先順位でソート
                const sortedCodecs = codecs.sort((a, b) => {
                    const aMime = a.mimeType.toLowerCase();
                    const bMime = b.mimeType.toLowerCase();

                    // 指定コーデックがあれば最優先
                    if (preferredCodec && preferredCodec !== 'auto') {
                        const target = preferredCodec.toLowerCase();
                        // mimeTypeに指定文字列が含まれるか (例: video/av1 に 'av1' が含まれる)
                        const aHas = aMime.includes(target);
                        const bHas = bMime.includes(target);

                        if (aHas && !bHas) return -1;
                        if (!aHas && bHas) return 1;
                    }

                    // デフォルト優先順位
                    const aIndex = PREFERRED_CODECS.findIndex(c => aMime.includes(c.toLowerCase()));
                    const bIndex = PREFERRED_CODECS.findIndex(c => bMime.includes(c.toLowerCase()));

                    const aScore = aIndex === -1 ? 999 : aIndex;
                    const bScore = bIndex === -1 ? 999 : bIndex;

                    return aScore - bScore;
                });

                try {
                    transceiver.setCodecPreferences(sortedCodecs);
                    // 実際に設定されたトップのコーデックをログ出力
                    // console.log(`[WebRTC] コーデック優先順位設定: ${preferredCodec || 'auto'} -> Top: ${sortedCodecs[0]?.mimeType}`);
                } catch (e) {
                    console.warn('[WebRTC] コーデック優先順位設定失敗:', e);
                }
            }
        }
    }, []);

    /**
     * ビットレート・フレームレート制限を適用
     */
    const applyBitrateLimit = useCallback(async (pc: RTCPeerConnection) => {
        const config = qualityConfigRef.current;
        if (!config) {
            // console.log('[WebRTC] 品質設定なし');
            return;
        }

        const senders = pc.getSenders();
        for (const sender of senders) {
            if (sender.track?.kind === 'video') {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }

                // フレームレート制限を設定（常に適用）
                params.encodings[0].maxFramerate = config.frameRate;

                // ビットレート制限を設定 (bps単位)
                if (config.bitrate !== 'auto' && config.bitrate > 0) {
                    params.encodings[0].maxBitrate = config.bitrate * 1000;
                } else {
                    // auto または 0(無制限) の場合は制限を削除
                    delete params.encodings[0].maxBitrate;
                }

                try {
                    await sender.setParameters(params);
                    // const bitrateStr = config.bitrate === 'auto' ? '自動' :
                    //    config.bitrate === 0 ? '無制限' : `${config.bitrate / 1000}Mbps`;
                    // console.log(`[WebRTC] 品質制限: ${config.frameRate}fps, ${bitrateStr}`);
                } catch (e) {
                    console.warn('[WebRTC] 品質設定失敗:', e);
                }
            }
        }
    }, []);

    /**
     * シグナリングサーバーに接続
     */
    const connect = useCallback(async () => {
        setConnectionState('connecting');
        setIsHost(isHost);

        const savedUrl = localStorage.getItem('p2d_signaling_url');
        const url = savedUrl || DEFAULT_SIGNALING_URL;

        const signaling = new SignalingClient(url);
        signalingRef.current = signaling;

        // イベントハンドラ設定
        signaling.on('onConnected', () => {
            setConnectionState('connected');
        });

        signaling.on('onDisconnected', () => {
            setConnectionState('disconnected');
        });

        signaling.on('onRoomCreated', (code) => {
            setRoomCode(code);
            // console.log('[WebRTC] ルーム作成:', code);
        });

        signaling.on('onRoomJoined', (_roomId, hostId, _peers) => {
            // console.log('[WebRTC] ルーム参加:', roomId, hostId, peers);
            hostIdRef.current = hostId;
            setConnectionState('peer-connecting');
        });

        signaling.on('onPeerJoined', async (peerId) => {
            // console.log('[WebRTC] ピア参加:', peerId);

            if (isHost && localStreamRef.current) {
                // ホスト: 新しいビューアにOfferを送信
                const pc = createPeerConnection(peerId);

                // DataChannelを作成（ホスト側）
                const dataChannel = pc.createDataChannel('p2d-control', { ordered: true });
                setupDataChannel(dataChannel);

                // ローカルストリームのトラックを追加
                localStreamRef.current.getTracks().forEach(track => {
                    pc.addTrack(track, localStreamRef.current!);
                });

                // コーデック優先順位設定
                setCodecPreferences(pc);

                // ビットレート制限を適用
                await applyBitrateLimit(pc);

                // Offer作成・送信
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signaling.sendOffer(peerId, offer);
            }
        });

        signaling.on('onPeerLeft', (peerId) => {
            // console.log('[WebRTC] ピア退出:', peerId);
            const pc = peerConnectionsRef.current.get(peerId);
            if (pc) {
                pc.close();
                peerConnectionsRef.current.delete(peerId);
            }
            setConnectedPeers(prev => prev.filter(id => id !== peerId));
        });

        signaling.on('onOffer', async (senderId, sdp) => {
            // console.log('[WebRTC] Offer受信:', senderId);

            // ビューア: Offerを受けてAnswerを返す
            const pc = createPeerConnection(senderId);

            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            signaling.sendAnswer(senderId, answer);
        });

        signaling.on('onAnswer', async (senderId, sdp) => {
            // console.log('[WebRTC] Answer受信:', senderId);

            const pc = peerConnectionsRef.current.get(senderId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            }
        });

        signaling.on('onIceCandidate', async (senderId, candidate) => {
            const pc = peerConnectionsRef.current.get(senderId);
            if (pc) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn('[WebRTC] ICE候補追加失敗:', e);
                }
            }
        });

        signaling.on('onError', (code, message) => {
            console.error('[WebRTC] エラー:', code, message);
            setError(message);
        });

        // 接続
        await signaling.connect();
        isConnectedRef.current = true;
    }, [isHost, createPeerConnection, setCodecPreferences, setConnectionState, setRoomCode, setIsHost, setError]);

    /**
     * 接続を閉じる
     */
    const disconnect = useCallback(() => {
        // ピア接続を閉じる
        peerConnectionsRef.current.forEach(pc => pc.close());
        peerConnectionsRef.current.clear();

        // ローカルストリームを停止（refを使用）
        localStreamRef.current?.getTracks().forEach(track => track.stop());
        setLocalStream(null);
        localStreamRef.current = null;
        setRemoteStream(null);

        // シグナリング接続を閉じる
        signalingRef.current?.disconnect();
        signalingRef.current = null;

        isConnectedRef.current = false;
        reset();
    }, [reset]);

    /**
     * ルームを作成（ホスト用）
     */
    const createRoom = useCallback((hostName?: string) => {
        signalingRef.current?.createRoom(hostName);
    }, []);

    /**
     * ルームに参加（ビューア用）
     */
    const joinRoom = useCallback((roomCode: string, viewerName?: string) => {
        signalingRef.current?.joinRoom(roomCode, viewerName);
    }, []);

    /**
     * 画面共有を開始（ホスト用）
     */
    const startScreenShare = useCallback(async (config?: QualityConfig) => {
        try {
            // 解像度設定
            const getResolution = (res?: QualityConfig['resolution']) => {
                switch (res) {
                    case '720p': return { width: 1280, height: 720 };
                    case '1080p': return { width: 1920, height: 1080 };
                    case 'native': return { width: 3840, height: 2160 }; // 4Kまで
                    default: return { width: 1920, height: 1080 };
                }
            };

            const resolution = getResolution(config?.resolution);
            const frameRate = config?.frameRate ?? 30;

            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: resolution.width },
                    height: { ideal: resolution.height },
                    // idealで高いFPSを要求（minは設定しない、対応できない場合にフォールバック可能）
                    frameRate: { ideal: frameRate },
                },
                audio: true, // システム音声も含める
            });

            setLocalStream(stream);
            localStreamRef.current = stream;

            // 品質設定をrefに保存
            if (config) {
                qualityConfigRef.current = config;
            }

            // 既存のピア接続があればトラックを置換
            const videoTrack = stream.getVideoTracks()[0];

            // contentHint設定
            if (config?.contentHint) {
                try {
                    // @ts-ignore: contentHint property exists in modern browsers
                    videoTrack.contentHint = config.contentHint;
                    // console.log(`[WebRTC] contentHint設定: ${config.contentHint}`);
                } catch (e) {
                    console.warn('[WebRTC] contentHint設定失敗:', e);
                }
            }

            peerConnectionsRef.current.forEach(async (pc) => {
                const senders = pc.getSenders();
                const videoSender = senders.find(s => s.track?.kind === 'video');

                if (videoSender) {
                    try {
                        await videoSender.replaceTrack(videoTrack);
                        // console.log('[WebRTC] トラックを置換しました');

                        // コーデック優先順位も更新
                        setCodecPreferences(pc);

                        // ビットレート制限なども再適用
                        await applyBitrateLimit(pc);
                    } catch (e) {
                        console.error('[WebRTC] トラック置換失敗:', e);
                    }
                } else {
                    // 送信トラックがない場合はストリームを追加（稀なケース）
                    stream.getTracks().forEach(track => pc.addTrack(track, stream));
                }
            });

            // ストリーム終了時の処理
            videoTrack.onended = () => {
                // console.log('[WebRTC] 画面共有終了');
                stopScreenShare(); // 状態を同期させるためstopScreenShareを呼ぶ
            };

            // console.log(`[WebRTC] 画面共有開始: ${resolution.width}x${resolution.height}@${frameRate}fps`);

            // モニター情報を更新し、ラベルから推測
            const monitorList = await refreshMonitors();
            const label = videoTrack.label;
            // "Screen 1" などのラベルから数字を抽出
            const match = label.match(/Screen\s+(\d+)/i) || label.match(/画面\s+(\d+)/);
            if (match && match[1]) {
                const num = match[1];
                // 名前が DISPLAY1 などで数字が含まれるものを探す
                const target = monitorList.find(m => m.name.includes(num));
                if (target) {
                    setSelectedMonitorName(target.name);
                }
            }
        } catch (error) {
            console.error('[WebRTC] 画面共有失敗:', error);
            setError('画面共有の開始に失敗しました');
        }
    }, [setError]);

    /**
     * 画面共有を停止
     */
    const stopScreenShare = useCallback(() => {
        localStreamRef.current?.getTracks().forEach(track => track.stop());
        setLocalStream(null);
        localStreamRef.current = null;
    }, []);

    // クリーンアップ（コンポーネントアンマウント時のみ）
    useEffect(() => {
        return () => {
            // refを直接使用してクリーンアップ
            peerConnectionsRef.current.forEach(pc => pc.close());
            peerConnectionsRef.current.clear();
            localStreamRef.current?.getTracks().forEach(track => track.stop());
            signalingRef.current?.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * 再生遅延（ジッターバッファ）を設定 (秒)
     * 0: 低ノイズ・低遅延 (デフォルト)
     * 0.5: 安定重視
     */
    const setPlayoutDelay = useCallback((delaySeconds: number) => {
        peerConnectionsRef.current.forEach((pc) => {
            const receivers = pc.getReceivers();
            receivers.forEach(receiver => {
                if (receiver.track.kind === 'video') {
                    // @ts-ignore: playoutDelayHint exists in modern browsers
                    if (receiver.playoutDelayHint !== undefined) {
                        // @ts-ignore
                        receiver.playoutDelayHint = delaySeconds;
                        // console.log(`[WebRTC] 遅延設定: ${delaySeconds}s`);
                    } else {
                        // @ts-ignore: jitterBufferTarget might be available in some browsers
                        if (receiver.jitterBufferTarget !== undefined) {
                            // @ts-ignore
                            receiver.jitterBufferTarget = delaySeconds * 1000;
                        }
                    }
                }
            });
        });
    }, []);

    /**
     * マイクを開始
     */
    const startMicrophone = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            const audioTrack = stream.getAudioTracks()[0];

            // 既存のPeerConnectionに音声トラックを追加
            peerConnectionsRef.current.forEach(pc => {
                pc.addTrack(audioTrack, stream);
            });

            audioTrackRef.current = audioTrack;
            localAudioStreamRef.current = stream;
            setIsMicEnabled(true);
            setIsMuted(false);
        } catch (error) {
            console.error('[Voice] マイク取得失敗:', error);
        }
    }, []);

    /**
     * マイクを停止
     */
    const stopMicrophone = useCallback(() => {
        if (audioTrackRef.current) {
            audioTrackRef.current.stop();
            audioTrackRef.current = null;
        }
        if (localAudioStreamRef.current) {
            localAudioStreamRef.current.getTracks().forEach(t => t.stop());
            localAudioStreamRef.current = null;
        }
        setIsMicEnabled(false);
        setIsMuted(false);
    }, []);

    /**
     * マイクのミュート切替
     */
    const toggleMute = useCallback(() => {
        if (audioTrackRef.current) {
            audioTrackRef.current.enabled = !audioTrackRef.current.enabled;
            setIsMuted(!audioTrackRef.current.enabled);
        }
    }, []);

    return {
        localStream,
        remoteStream,
        connect,
        disconnect,
        createRoom,
        startScreenShare,
        stopScreenShare,
        joinRoom,
        roomCode,
        isConnected: connectionState === 'connected' || connectionState === 'peer-connected',
        error,
        peerConnection: peerConnectionsRef.current.size > 0
            ? Array.from(peerConnectionsRef.current.values())[0]
            : null,
        connectedPeers,
        // チャット
        chatMessages,
        sendChatMessage,
        sendData,
        isDataChannelOpen,
        // リモート操作
        isRemoteControlEnabled,
        toggleRemoteControl,
        stats,
        setPlayoutDelay,
        monitors,
        selectedMonitorName,
        setSelectedMonitorName,
        refreshMonitors,
        // ボイスチャット
        isMicEnabled,
        remoteAudioStream,
        startMicrophone,
        stopMicrophone,
        toggleMute,
        isMuted
    };
}
