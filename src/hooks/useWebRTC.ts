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
import {
    initRoster, mergeRosters, mergeEntry, applyDepart, rosterEntries, shouldInitiateTo,
    type RosterState, type RosterEntry,
} from '../lib/roster';
import {
    createRoot as createTreeRoot, attach as treeAttach, promote as treePromote,
    findNode as findTreeNode, handleNodeLoss,
    findPromoteCandidate as findTreePromoteCandidate, findDownlinkRelay,
    detachNode, attachUnder, pickParentScored,
} from '../lib/treeAssign';
import {
    chooseSignalRoute, makeEnvelope, forwardEnvelope,
    type TunnelEnvelope, type SignalKind,
} from '../lib/signalRouter';
import { generateRelayKeyPair, signChunk, verifyChunk, chunkDataFromB64, keyFingerprint, acceptKeyCandidate, type RelayKeyPair } from '../lib/relaySign';
import { isControlAllowed, pruneExpired, resolveInputOrigin, CONTROL_TTL_OPTIONS, type ControlGrant, type ControlTtlKey } from '../lib/controlGrant';
import { initWatchdogState, noteActivity, noteSwitch, armWatchdog, disarmWatchdog, checkWatchdog, classifyLink, type WatchdogState, type LinkLevel } from '../lib/relayWatchdog';

// WebRTC APIの有無 (Ubuntu等のWebKitGTKはWebRTC無効ビルドで RTCPeerConnection が存在しない)
export const SUPPORTS_WEBRTC = typeof RTCPeerConnection !== 'undefined';

// 中央サーバーと同じ文字集合の6桁ルームコード (レンデブー最小化M2/M4:
// ホストがローカル生成し、電話帳登録と内蔵サーバーの両方で同じコードを使う)。
// issue#9: コードは参加資格そのものなので乱数源はcrypto (Math.randomは予測可)
function genLocalRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(buf[i] % chars.length);
    return code;
}

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
    /** 指定サーバーURLで参加する (M4: 招待v2 p2d://join/CODE@host:port) */
    joinRoomAt: (roomCode: string, wsUrl: string, name?: string) => Promise<void>;
    leaveRoom: () => void;

    // 状態
    roomCode: string | null;
    isConnected: boolean;
    error: string | null;
    clearError: () => void;
    participants: Map<string, ParticipantInfo>;
    /** M1: 名簿ゴシップの現在のエントリ一覧 (収束検証用) */
    getRoster: () => { id: string; name?: string; joinedAt: number; hostEndpoint?: string }[];
    /** 配信木 (E2E検証用): 強制的にWSリレーモードへ切り替える */
    setRelayMode: (v: boolean) => void;
    /** 配信木 (E2E検証用): 自ノードの状態 */
    getTreeInfo: () => {
        role: 'none' | 'host' | 'relay';
        children: string[];
        addr: { host: string; port: number } | null;
        parent: string | null;
    };
    /** M5 フェーズB: 視聴者側のリンク健康 (バッジ用) */
    linkHealth: { level: LinkLevel; via: 'direct' | 'relay' };
    /** M5 フェーズC: 木の健康マップ (中継ごとの子数・上流無音時間・RTT) */
    treeHealth: Map<string, { at: number; upstreamSilentMs: number; children: number; rttMs?: number }>;
    /** M4: 署名鍵のフィンガープリント (QR帯域外照合用) */
    getRelayKeyFingerprint: () => string | null;
    /** issue#11: 招待 (;fp=) から受けた鍵指紋を設定し、受信鍵との照合を強制する */
    setExpectedKeyFingerprint: (fp: string | null) => void;
    myId: string | null;
    /** 自分がこの部屋のホスト (操作許可UIを出す側) か (issue#8) */
    isHost: boolean;

    // 画面共有
    startScreenShare: (config?: QualityConfig) => Promise<void>;
    startCustomScreenShare: (sourceId: string, isMonitor: boolean, config?: QualityConfig) => Promise<void>;
    stopScreenShare: (streamId?: string) => void;
    isScreenSharing: boolean;
    localStreams: Map<string, MediaStream>; // streamId -> Stream

    // リモート操作 (F-022 / issue#8: 視聴者ごとの明示承認・期限付き)
    remoteControlAllowed: boolean;
    /** 互換API (一括許可/取消)。UIはpeer単位のgrant/revokeを使う */
    setRemoteControlAllowed: (allowed: boolean) => void;
    /** 視聴者を個別に許可する。ttlMs=0は無期限 */
    grantRemoteControl: (peerId: string, ttlMs?: number) => void;
    /** 視聴者の許可を取り消す */
    revokeRemoteControl: (peerId: string) => void;
    /** 現在のグラント一覧 (UI表示用) */
    controlGrants: Map<string, ControlGrant>;
    controlTtlOptions: readonly { readonly key: ControlTtlKey; readonly label: string; readonly ms: number }[];
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
        sigVerified: number; sigInvalid: number;
        inputsApplied: number; inputsRejected: number;
    };
    /** M5 E2E用: 着信握りつぶし (親停滞の再現) */
    debugStallRelay: (ms: number) => void;

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

export function useWebRTC(options?: { signalingUrl?: string; turnConfig?: TurnConfig; treeFanout?: number }): UseWebRTCReturn {
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

    // リモート操作 (F-022 / issue#8: 視聴者ごとの明示承認・期限付き)。
    // デフォルトOFF = グラントが無い視聴者の入力は適用されない (安全側)
    const controlGrantsRef = useRef<Map<string, ControlGrant>>(new Map());
    const [controlGrants, setControlGrants] = useState<Map<string, ControlGrant>>(new Map());
    const syncGrantsState = useCallback(() => {
        setControlGrants(new Map(controlGrantsRef.current));
    }, []);
    // 入力破棄の警告は高頻度になり得る (未許可クライアントの入力ストリーム等) ので
    // 最大1秒に1回に抑制する (件数自体は inputsRejected カウンタで追跡)
    const lastRejectWarnRef = useRef(0);
    const warnRejectThrottled = useCallback((peerId: string) => {
        const now = Date.now();
        if (now - lastRejectWarnRef.current < 1000) return;
        lastRejectWarnRef.current = now;
        console.warn(`[RemoteControl] 未許可の視聴者 (${peerId}) からの入力を破棄 (直近1秒分は省略)`);
    }, []);
    // issue#8: 視聴者側の制御上の同一性 (ホスト部屋で知られた自分のID)。
    // tree:assign で中継のサーバーへ移ると myId が変わるが、入力の発信者検証は
    // ホストが知っている旧ID (originId) で行うため、移動時に凍結する
    const controlIdRef = useRef<string | null>(null);
    const controlIdFrozenRef = useRef(false);
    // 視聴者側バッジの期限自動解除タイマー (peerId -> timer id)
    const peerControlExpiryTimersRef = useRef<Map<string, number>>(new Map());
    // 再接続時の部屋再参加用 (Wi-Fi断等から WS が繋がり直ったときに入り直す)
    const roomCodeRef = useRef<string | null>(null);
    const roomNameRef = useRef<string | undefined>(undefined);
    // ICE restartのグレア対策 (offerを送る側を決める) に使う自分のID
    const myIdRef = useRef<string | null>(null);

    // === レンデブー最小化 (M1〜M4) ===
    // M1: 名簿ゴシップ (全員が同一名簿を持つ・決定論的union合流)
    const rosterRef = useRef<RosterState>(initRoster());
    const selfJoinedAtRef = useRef<number>(0);
    const rosterThrottleRef = useRef(0);
    // DCで届くゴシップ/トンネル系メッセージの振り分け (後段で毎レンダー差し替え)
    const dcDispatchRef = useRef<(type: string, payload: unknown, fromPeer: string) => void>(() => { });
    // signalingハンドラ束ね配線 (後段で毎レンダー差し替え)
    const wireSignalingRef = useRef<(signaling: SignalingClient) => void>(() => { });
    const switchSignalingRef = useRef<(url: string) => Promise<void>>(async () => { });
    // M2: ホスト内蔵サーバー (ポート/電話帳で学んだendpoint/移行済みフラグ/ホストフラグ)
    const embeddedPortRef = useRef<number | null>(null);
    const hostEndpointRef = useRef<string | null>(null);
    const isHostRef = useRef(false);
    const migratedRef = useRef(false);
    // issue#9: ホスト再権限トークン (room:created応答でサーバーから受領)。
    // 移行でSignalingClientを作り直してもcreateに添付できるようrefで保持する
    const hostTokenRef = useRef<string | null>(null);
    // issue#10: ルームのホストの接続ID (room:joined / room:host で受領)。
    // tree:promote/assign・鍵配布・許可状態の権威チェックに使う
    const hostIdRef = useRef<string | null>(null);
    // M3: リレーチャンク署名 (ホスト=鍵ペア+署名 / ゲスト=公開鍵+検証)
    const relayKeysRef = useRef<RelayKeyPair | null>(null);
    const relayPubKeyRef = useRef<string | null>(null);
    // issue#11: 招待 (p2d://join/...;fp=) から受けた鍵フィンガープリント。
    // 設定時は受信した公開鍵の指紋と一致しない限り鍵を受理しない (帯域外照合)
    const expectedKeyFpRef = useRef<string | null>(null);
    const relayChunkSeqRef = useRef(0);
    // 受信側: ストリーム毎に最後に検証したseqを追跡し、後戻りするチャンク
    // (リプレイ/再注入) を破棄する (M3: 署名はseqにバインド済み)
    const relayLastSeqRef = useRef<Record<string, number>>({});

    // === 配信木 (計画書M2/M3) ===
    // 自分が木のどの位置にいるか: 'none'=非リレー/未確定, 'host'=根, 'relay'=中継者
    const treeRoleRef = useRef<'none' | 'host' | 'relay'>('none');
    // 中継者: 自分の内蔵サーバーへ接続した子クライアント + その接続
    const treeClientRef = useRef<SignalingClient | null>(null);
    const treeChildrenRef = useRef<Set<string>>(new Set());
    const treeSelfAddrRef = useRef<{ host: string; port: number } | null>(null);
    const treeRootIdRef = useRef<string | null>(null); // 中継者から見たホスト (コーディネータ) のID
    // 子へ転送するためにキャッシュする下流派生物 (鍵・許可状態)
    const cachedKeyRef = useRef<unknown>(null);
    const cachedControlRef = useRef<unknown>(null);
    // 親 (チャンクの供給元) のクライアントID — 自分の接続先サーバー上のID
    const parentTargetIdRef = useRef<string | null>(null);
    // ホスト側コーディネータの状態
    const treeCoordinatorRef = useRef<{
        root: ReturnType<typeof import('../lib/treeAssign').createRoot>;
        promotePending: string | null;
        overCapacity: Set<string>;
    } | null>(null);
    const treeFanoutRef = useRef<number>(options?.treeFanout ?? 4);
    useEffect(() => {
        if (options?.treeFanout) treeFanoutRef.current = options.treeFanout;
    }, [options?.treeFanout]);
    const lanIpRef = useRef<string | null>(null);

    // === WSリレーモード (LinuxのWebKitGTK等 WebRTC非対応エンジン向けフォールバック) ===
    const relayModeRef = useRef<boolean>(!SUPPORTS_WEBRTC);
    const [isRelayMode, setIsRelayModeState] = useState<boolean>(!SUPPORTS_WEBRTC);
    // ホスト側: WSリレーでフレームを受信する視聴者
    const relaySubscribersRef = useRef<Set<string>>(new Set());
    const relayVideoRef = useRef<HTMLVideoElement | null>(null);
    const relayLoopRef = useRef<number | null>(null);
    // M5 フェーズA: 親からの受信停滞を監視するウォッチドッグ (配信木計画書§7)。
    // 判定ロジックは relayWatchdog.ts (純粋関数) で、ここでは着信を記録するだけ
    const relayWatchdogRef = useRef<WatchdogState>(initWatchdogState(Date.now()));
    // M5 フェーズB: 視聴者側のリンク健康バッジ用 (mesh/配信木で共通の見え方)
    const [linkHealth, setLinkHealth] = useState<{ level: LinkLevel; via: 'direct' | 'relay' }>({ level: 'idle', via: 'direct' });
    const connectedViaRef = useRef<'direct' | 'relay'>('direct');
    // M5 フェーズC: 中継からのメトリクス (ホストが木の健康を把握する)
    const treeHealthRef = useRef<Map<string, { at: number; upstreamSilentMs: number; children: number; rttMs?: number }>>(new Map());
    const [treeHealth, setTreeHealth] = useState<Map<string, { at: number; upstreamSilentMs: number; children: number; rttMs?: number }>>(new Map());
    const relayMetricsTimerRef = useRef<number | null>(null);
    // M5 フェーズC: 上りRTT実測 (ping/pong) と降格済み中継の管理
    const upstreamRttRef = useRef<number | null>(null);
    const demotedRelaysRef = useRef<Set<string>>(new Set());
    const rootServerUrlRef = useRef<string | null>(null);
    // M5 E2E用の故障注入: 指定時刻まで着信メッセージを握りつぶし、親停滞を再現する
    const relaySuppressUntilRef = useRef(0);
    const suppressLoggedRef = useRef(false);
    const relayTickTimerRef = useRef<number | null>(null);
    const lastKnownServerUrlRef = useRef<string | null>(null);
    const relayFrameSeqRef = useRef(0);
    const [relayFrame, setRelayFrame] = useState<string | null>(null);
    const relayStatsRef = useRef({ frames: 0, bytes: 0, lastFrameAt: 0, h264Chunks: 0, audioChunks: 0, sigVerified: 0, sigInvalid: 0, inputsApplied: 0, inputsRejected: 0 });
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
    // useEffect経由の遅延ミラーではなく setState 側で同時に更新する
    // (監査#1の送信者チェックが最新参加者リストを即座に参照できるようにするため)
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

    // M1: 定周期ゴシップsync — 変化通知の取りこぼし (DC開通前の参加など) を
    // 10秒ごとに回収し、全員の名簿を収束させる
    useEffect(() => {
        const t = window.setInterval(() => {
            if (!isConnectedRef.current) return;
            broadcastData('roster:sync', {
                entries: rosterEntries(rosterRef.current),
                tombstones: [...rosterRef.current.tombstones.values()],
            });
        }, 10000);
        return () => window.clearInterval(t);
    }, [broadcastData]);

    /**
     * 視聴者側: 操作許可バッジを更新する (issue#8)。
     * expiresAt>0 (有期限) なら期限到来でバッジを自動的にOFFへ戻す
     */
    const setPeerControlBadge = useCallback((peerId: string, allowed: boolean, expiresAt: number) => {
        const prevTimer = peerControlExpiryTimersRef.current.get(peerId);
        if (prevTimer !== undefined) {
            window.clearTimeout(prevTimer);
            peerControlExpiryTimersRef.current.delete(peerId);
        }
        setPeerControlAllowed(prev => new Map(prev).set(peerId, allowed));
        if (allowed && expiresAt > 0) {
            const wait = Math.max(0, expiresAt - Date.now());
            const t = window.setTimeout(() => {
                peerControlExpiryTimersRef.current.delete(peerId);
                setPeerControlAllowed(prev => new Map(prev).set(peerId, false));
                console.log(`[RemoteControl] 許可の期限が切れました (バッジ更新): ${peerId}`);
            }, wait);
            peerControlExpiryTimersRef.current.set(peerId, t);
        }
    }, []);

    /**
     * DataChannel設定
     */
    const setupDataChannel = useCallback((channel: RTCDataChannel, peerId: string) => {
        channel.onopen = () => {
            console.log(`[DataChannel] Open: ${peerId}`);
            dataChannelsRef.current.set(peerId, channel);
            // 自分がホスト側の場合、この視聴者へのリモート操作許可状態を即通知 (issue#8)
            const grantNow = isControlAllowed(controlGrantsRef.current, peerId, Date.now());
            channel.send(JSON.stringify({
                type: 'control:remote_allowed',
                payload: { allowed: grantNow, expiresAt: grantNow ? controlGrantsRef.current.get(peerId)?.expiresAt ?? 0 : 0 },
                timestamp: Date.now(),
            }));
            // M1: 名簿ゴシップ — 開通したDCへ自分の知る名簿をすべて渡す
            try {
                channel.send(JSON.stringify({
                    type: 'roster:sync',
                    payload: {
                        entries: rosterEntries(rosterRef.current),
                        tombstones: [...rosterRef.current.tombstones.values()],
                    },
                    timestamp: Date.now(),
                }));
            } catch { /* DC死んでいたら無視 */ }
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
                    // ピア(ホスト)からのリモート操作許可状態 (issue#8: 期限付き)
                    const allowed = !!data.payload?.allowed;
                    const expiresAt = typeof data.payload?.expiresAt === 'number' ? data.payload.expiresAt : 0;
                    setPeerControlBadge(peerId, allowed, expiresAt);
                } else if (typeof data.type === 'string' && data.type.startsWith('input:')) {
                    // ホスト側: この視聴者のグラントを検証してから適用 (F-022 / issue#8)。
                    // DCは直接1対1なので senderId = peerId
                    if (isControlAllowed(controlGrantsRef.current, peerId, Date.now())) {
                        relayStatsRef.current.inputsApplied++;
                        void applyInputEvent(data.type, data.payload);
                    } else {
                        relayStatsRef.current.inputsRejected++;
                        warnRejectThrottled(peerId);
                    }
                } else if (data.type === 'roster:sync' || data.type === 'roster:depart' || data.type === 'tunnel:sig') {
                    // レンデブー最小化 (M1/M2): 名簿ゴシップ + DC中継シグナリング
                    dcDispatchRef.current(data.type, data.payload, peerId);
                }
                // 他のメッセージタイプ（controlなど）は必要に応じて追加
            } catch (e) {
                console.error('[DataChannel] Parse error:', e);
            }
        };
    }, [connectionState, setConnectionState, setPeerControlBadge]);

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
     * 1視聴者への許可状態変更を通知する (issue#8)。
     * - 直結 (DC or リレー購読者): その peerId 宛てに直接送る
     * - 配信木経由の視聴者: ホストの部屋にはもう居ないので、ホスト直結の中継へ
     *   targetOriginId 付きで送り、経路中継のcached転送で下流へ届ける。
     *   中継は転送のみで自分のバッジは変えない (視聴者側で宛先フィルタする)
     */
    const notifyControlAllowed = useCallback((peerId: string, allowed: boolean, expiresAt: number) => {
        const dc = dataChannelsRef.current.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ type: 'control:remote_allowed', payload: { allowed, expiresAt }, timestamp: Date.now() }));
        }
        if (dc || relaySubscribersRef.current.has(peerId)) {
            signalingRef.current?.sendRelay(peerId, 'control_allowed', { allowed, expiresAt });
            return;
        }
        // 配信木経由: 下りリンクの最初のホップ (深さ1の中継) を探す
        const c = treeCoordinatorRef.current;
        const downlink = c ? findDownlinkRelay(c.root, peerId) : null;
        if (downlink) {
            signalingRef.current?.sendRelay(downlink.id, 'control_allowed', { allowed, expiresAt, targetOriginId: peerId });
        } else {
            console.warn(`[RemoteControl] ${peerId} への許可通知経路が無い (直結にも中継木にも居ない)`);
        }
    }, []);

    /**
     * 視聴者ごとにリモート操作を許可する (issue#8)。ttlMs=0は無期限。
     * 既定はOFF (グラント無し) で、許可した視聴者だけが操作できる。
     */
    const grantRemoteControl = useCallback((peerId: string, ttlMs: number = 0) => {
        if (!peerId) return;
        const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
        controlGrantsRef.current.set(peerId, { allowed: true, expiresAt });
        syncGrantsState();
        notifyControlAllowed(peerId, true, expiresAt);
        console.log(`[RemoteControl] 許可: ${peerId} (${expiresAt === 0 ? '無期限' : '〜' + new Date(expiresAt).toLocaleTimeString()})`);
    }, [notifyControlAllowed, syncGrantsState]);

    /** 視聴者のリモート操作許可を取り消す (issue#8) */
    const revokeRemoteControl = useCallback((peerId: string) => {
        if (!peerId) return;
        controlGrantsRef.current.delete(peerId);
        syncGrantsState();
        notifyControlAllowed(peerId, false, 0);
        console.log(`[RemoteControl] 取り消し: ${peerId}`);
    }, [notifyControlAllowed, syncGrantsState]);

    /**
     * 互換API (E2Eランナー用): 全ての現参加者へ一括で許可/取消する。
     * UIからは使わない。参加者ごとの許可は grantRemoteControl/revokeRemoteControl。
     */
    const setRemoteControlAllowed = useCallback((allowed: boolean) => {
        const targets = new Set<string>([...dataChannelsRef.current.keys(), ...relaySubscribersRef.current]);
        for (const peerId of targets) {
            if (allowed) controlGrantsRef.current.set(peerId, { allowed: true, expiresAt: 0 });
            else controlGrantsRef.current.delete(peerId);
            notifyControlAllowed(peerId, allowed, 0);
        }
        syncGrantsState();
        setRemoteControlAllowedState(allowed);
        console.log(`[RemoteControl] 一括${allowed ? '許可' : '取消'} (${targets.size}人)`);
    }, [notifyControlAllowed, syncGrantsState]);

    // issue#8: 期限切れグラントの自動解除 (切れた視聴者へは許可解除を通知)
    useEffect(() => {
        const t = window.setInterval(() => {
            const expired = pruneExpired(controlGrantsRef.current, Date.now());
            if (expired.length === 0) return;
            for (const id of expired) {
                console.log(`[RemoteControl] 期限切れで自動解除: ${id}`);
                notifyControlAllowed(id, false, 0);
            }
            syncGrantsState();
        }, 1000);
        return () => window.clearInterval(t);
    }, [notifyControlAllowed, syncGrantsState]);

    /**
     * 特定ピアへ入力イベントを送信 (ビューア側)。
     * issue#8: 発信者ID (originId) を封筒に載せる。直結なら senderId で判明するが、
     * 配信木の中継経由では senderId が中継に変わるため、自分の (ホスト部屋での)
     * ID を明示する。中継は転送のみで改変しない
     */
    const sendInputToPeer = useCallback((peerId: string, type: string, payload: unknown) => {
        const originId = controlIdRef.current || myIdRef.current || '';
        const dc = dataChannelsRef.current.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ type, payload, originId, timestamp: Date.now() }));
        } else if (relayModeRef.current) {
            // DataChannelが使えないエンジン (Linux等) はWSリレーへフォールバック
            signalingRef.current?.sendRelay(peerId, 'input', { type, payload, originId });
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
        // M5§7.3: 共有中の生存信号。視聴者は tick/メディア のどちらか新しい方を監視し、
        // 4秒無音で停滞 (親切替) を発動する。静止画でメディア出力が減る正常系と
        // リンク停滞を区別するため、メディアと独立した1秒周期で送る
        for (const peerId of relaySubscribersRef.current) {
            signalingRef.current?.sendRelay(peerId, 'share_state', { active: true });
        }
        relayTickTimerRef.current = window.setInterval(() => {
            for (const peerId of relaySubscribersRef.current) {
                signalingRef.current?.sendRelay(peerId, 'tick', { ts: Date.now() });
            }
        }, 1000);
        relayLoopRef.current = window.setInterval(() => {
            const mseSubs = Array.from(relayCapsRef.current.entries()).filter(([, c]) => c.mse).map(([id]) => id);
            // 診断: ループ停滞の切り分け (60秒毎)
            {
                const w = window as unknown as { __relayDiagAt?: number };
                const now = Date.now();
                if (now - (w.__relayDiagAt ?? 0) > 60000) {
                    w.__relayDiagAt = now;
                    console.log(`[RelayLoop] diag: subs=${relaySubscribersRef.current.size} caps=${relayCapsRef.current.size} vw=${video.videoWidth} rs=${video.readyState} enc=${!!relayEncoderRef.current} sent=${relayStatsRef.current.h264Chunks} audio=${relayStatsRef.current.audioChunks}`);
                }
            }
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
                            // M3: チャンク毎に一意なseq + Ed25519署名 (改ざん/偽装/リプレイ対策)
                            relayChunkSeqRef.current++;
                            const seq = relayChunkSeqRef.current;
                            const ts = Date.now();
                            const keys = relayKeysRef.current;
                            const sig = keys ? signChunk(keys.secretKeyB64, seq, ts, chunkDataFromB64(d)) : undefined;
                            // 送信先は毎フレーム relayCapsRef から再取得する
                            // (onBoxはエンコーダ生成時に凍結されるため、生成時のリストを
                            //  使うと後から参加した視聴者に映像が届かない)
                            const targets = Array.from(relayCapsRef.current.entries())
                                .filter(([, c]) => c.mse).map(([id]) => id);
                            for (const peerId of targets) {
                                signalingRef.current?.sendRelay(peerId, 'h264', sig
                                    ? { seq, ts, d, sig }
                                    : { seq, d });
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
                // M3: フレームにも署名
                const frameSeq = relayFrameSeqRef.current;
                const frameTs = Date.now();
                const frameKeys = relayKeysRef.current;
                const frameSig = frameKeys ? signChunk(frameKeys.secretKeyB64, frameSeq, frameTs, chunkDataFromB64(b64)) : undefined;
                for (const peerId of jpegSubs) {
                    signalingRef.current?.sendRelay(peerId, 'frame', frameSig
                        ? { seq: frameSeq, ts: frameTs, w, h, d: b64, sig: frameSig }
                        : { seq: frameSeq, w, h, d: b64 });
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
            // M5§7.3: 共有の正常終了を視聴者へ通知 (視聴者は監視を解除し、
            // 停滞と誤検知しない)。購読者がいる間だけ送ればよい
            for (const peerId of relaySubscribersRef.current) {
                signalingRef.current?.sendRelay(peerId, 'share_state', { active: false });
            }
            if (relayTickTimerRef.current) {
                clearInterval(relayTickTimerRef.current);
                relayTickTimerRef.current = null;
            }
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
                        if (c.webmAudio) {
                            // M3: 音声チャンクにも署名
                            relayChunkSeqRef.current++;
                            const aSeq = relayChunkSeqRef.current;
                            const aTs = Date.now();
                            const aKeys = relayKeysRef.current;
                            const aSig = aKeys ? signChunk(aKeys.secretKeyB64, aSeq, aTs, chunkDataFromB64(d)) : undefined;
                            signalingRef.current?.sendRelay(peerId, 'audio', aSig
                                ? { seq: aSeq, ts: aTs, d, sig: aSig }
                                : { seq: aSeq, d });
                        }
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

    // === レンデブー最小化 (M1〜M2): DC中継シグナリング + 名簿ゴシップ + 内蔵サーバー移行 ===

    /** 名簿スナップショットを全DCへ送る (ゴシップ再送は1秒に throttle) */
    const broadcastRosterSync = () => {
        const now = Date.now();
        if (now - rosterThrottleRef.current < 1000) return;
        rosterThrottleRef.current = now;
        broadcastData('roster:sync', {
            entries: rosterEntries(rosterRef.current),
            tombstones: [...rosterRef.current.tombstones.values()],
        });
    };

    /** M5§7: メディア/tick着信をウォッチドッグへ記録 (初回受信で監視を開始する) */
    const noteRelayActivity = () => {
        const wd = relayWatchdogRef.current;
        relayWatchdogRef.current = wd.phase === 'idle' ? armWatchdog(wd, Date.now()) : noteActivity(wd, Date.now());
    };

    /**
     * リレーチャンクの署名検証 (M3 / issue#11 fail-closed化)。公開鍵を受信する
     * 前 のチャンクは正規ホスト産と証明できないため破棄する (ホストはsubscribe
     * 受理と同時に relay:key を送るため、正常系で鍵が先行する)。鍵配布後の
     * 無署名/不正署名/seq後戻り (リプレイ) もすべて破棄する。
     */
    const verifyRelayChunk = (p: Record<string, unknown>, streamKey: string): boolean => {
        const pub = relayPubKeyRef.current;
        const sig = typeof p.sig === 'string' ? p.sig : null;
        const seq = Number(p.seq) || 0;
        // リプレイ検知: seqの後戻りは再注入なので破棄 (WSは順序保証あり=正常系は単調増加)
        const lastSeq = relayLastSeqRef.current[streamKey] || 0;
        if (seq > 0 && seq <= lastSeq) {
            relayStatsRef.current.sigInvalid++;
            console.warn(`[Relay] seq後戻り (${seq} <= ${lastSeq}) — リプレイとして破棄`);
            return false;
        }
        if (!pub) {
            relayStatsRef.current.sigInvalid++;
            console.warn('[Relay] 署名鍵を受信する前のチャンクを破棄 (fail-closed)');
            return false;
        }
        if (!sig) {
            relayStatsRef.current.sigInvalid++;
            console.warn('[Relay] 鍵配布済みなのに無署名チャンク — 破棄');
            return false;
        }
        const ok = verifyChunk(pub, seq, Number(p.ts) || 0, chunkDataFromB64(String(p.d || '')), sig);
        if (!ok) {
            relayStatsRef.current.sigInvalid++;
            console.warn('[Relay] 署名検証失敗 — チャンクを破棄 (改ざん/偽装の可能性)');
            return false;
        }
        relayLastSeqRef.current[streamKey] = seq;
        relayStatsRef.current.sigVerified++;
        return true;
    };

    // === 配信木 (M2/M3): ホスト側コーディネータ + 中継者ロジック ===

    /**
     * ホスト側: 新しいリレー視聴者を木に登録する (§3.1: 幅優先・深さ≤3)。
     * ホスト直結が上限を超えたら最古の直結視聴者を中継へ昇格し、
     * 準備ができたら (relay_ready) 超過分をその中継へ割り当てる。
     */
    const coordinateTree = (newSubId: string, opts?: { reassignHost?: boolean }) => {
        const myId = myIdRef.current;
        if (!myId) return;
        // コーディネータはホスト (根) のみが務める。視聴者は自らをhost役に
        // 上げない (複数コーディネータ分裂を防ぐ — scale testで判明)
        if (!isHostRef.current) return;
        const c = treeCoordinatorRef.current ??= {
            root: createTreeRoot(myId, treeFanoutRef.current),
            promotePending: null,
            overCapacity: new Set<string>(),
        };
        if (findTreeNode(c.root, newSubId)) return;

        // M5 フェーズC: 上流が停滞している中継には新しい子を割り当てない。
        // さらに RTT実測があれば「浅い深さ × 健康スコア」で親を選ぶ
        const isUnhealthy = (node: { id: string; addr: unknown }) => {
            if (!node.addr) return false;
            const m = treeHealthRef.current.get(node.id);
            if (m && Date.now() - m.at < 20000 && m.upstreamSilentMs > 4000) return true;
            return demotedRelaysRef.current.has(node.id);
        };
        const healthScore = (node: { id: string; addr: unknown }): number => {
            if (!node.addr) return 0; // 根
            const m = treeHealthRef.current.get(node.id);
            if (!m || Date.now() - m.at >= 20000) return 2.5; // 計測なし
            const rtt = m.rttMs ?? 250;
            return rtt < 150 ? 1 : rtt < 400 ? 2 : 3;
        };
        const parent = pickParentScored(c.root, 3, { skip: isUnhealthy, score: healthScore });
        if (parent) {
            const node = attachUnder(c.root, parent.id, { id: newSubId, addr: null, depth: 0, fanout: 0, children: [] });
            if (node && parent !== c.root && parent.addr) {
                // 中継ノードの下へ配置 → 視聴者を中継のサーバーへ誘導
                console.log(`[Tree] ${newSubId} を中継 ${parent.id} (${parent.addr.host}:${parent.addr.port}) へ割り当て`);
                signalingRef.current?.sendRelay(newSubId, 'tree:assign', { addr: parent.addr });
            } else if (node && parent === c.root && opts?.reassignHost) {
                // M5§7: 親停滞からの再割当でroot直結に戻す場合、視聴者は停滞した
                // 親のサーバーにまだ繋がっているので、自分の接続先への再ダイヤル
                // (rejoin) を指示する。中央経由の構成では中央への再接続になり、
                // サーバーレス構成ではホストの内蔵サーバー (部屋は常設) に戻る
                console.log(`[Tree] ${newSubId} をroot直結へ再割り当て (親停滞) — rejoin指示`);
                signalingRef.current?.sendRelay(newSubId, 'tree:assign', { rejoin: true });
            }
            return;
        }

        // ホスト直結が満杯: 木全体から最浅の未昇格ノードを昇格する (issue#7)。
        // root直結に限定すると、直結が全て昇格済みの時点で候補ゼロになり
        // 超過分の視聴者が永遠にホスト直結のまま残留する
        c.overCapacity.add(newSubId);
        const candidate = findTreePromoteCandidate(c.root, 3);
        if (candidate && !c.promotePending) {
            console.log(`[Tree] 直結満員 → ${candidate.id} を中継へ昇格指示`);
            c.promotePending = candidate.id;
            signalingRef.current?.sendRelay(candidate.id, 'tree:promote', { code: roomCodeRef.current });
        }
    };

    /** ホスト側: 昇格した中継者からの準備完了報告 */
    const handleTreeRelayReady = (senderId: string, p: Record<string, unknown>) => {
        const c = treeCoordinatorRef.current;
        const addr = p.addr as { host: string; port: number } | undefined;
        if (!c || !addr) return;
        // issue#10: コーディネータが昇格を指示した (または木に居る) ノード以外からの
        // relay_ready は受理しない。任意の参加者が任意のhost:portを「中継」として
        // 登録させられるのを防ぐ
        if (c.promotePending !== senderId && !findTreeNode(c.root, senderId)) {
            console.warn(`[Tree] 指示していない参加者 ${senderId} のrelay_readyを破棄`);
            return;
        }
        const node = findTreeNode(c.root, senderId);
        if (node) treePromote(node, addr);
        console.log(`[Tree] 中継 ${senderId} が準備完了: ${addr.host}:${addr.port}`);
        // 満杯で待っていた視聴者を、中継のfan-out上限まで割り当てる (超過分は次の昇格へ)
        let slots = node?.fanout ?? 0;
        const assigned = new Set<string>();
        const remaining = new Set<string>();
        for (const id of c.overCapacity) {
            if (node && slots > 0) {
                slots--;
                treeAttach(node, { id, addr: null, depth: 0, fanout: 0, children: [] });
                signalingRef.current?.sendRelay(id, 'tree:assign', { addr });
                assigned.add(id);
            } else {
                remaining.add(id);
            }
        }
        c.overCapacity = remaining;
        // まだ溢れている場合: 次の昇格候補 (中継未昇格の直結視聴者) を昇格させる
        c.promotePending = null;
        if (c.overCapacity.size > 0) {
            const candidate = c.root.children.find(ch => !ch.addr);
            if (candidate) {
                c.promotePending = candidate.id;
                console.log(`[Tree] 直結が満杯のまま → ${candidate.id} を追加で中継昇格`);
                signalingRef.current?.sendRelay(candidate.id, 'tree:promote', { code: roomCodeRef.current });
            }
        }
    };

    /** ゲスト側: 中継へ昇格 — 自分の内蔵サーバーを起動し子を受け付ける (M2) */
    const handleTreePromote = (hostId: string) => {
        if (treeClientRef.current) return; // 既に中継
        treeRootIdRef.current = hostId;
        void (async () => {
            try {
                const port = await invoke<number>('embedded_server_start', { port: null, host: null });
                const ip = await invoke<string | null>('get_local_lan_address');
                treeSelfAddrRef.current = { host: ip || '127.0.0.1', port };
                treeRoleRef.current = 'relay';
                console.log(`[Tree] 中継に昇格: 内蔵サーバー ${treeSelfAddrRef.current.host}:${port}`);

                // 自分のサーバーへ接続 (子の subscribe/chat を受け取る面)
                const tc = new SignalingClient(`ws://127.0.0.1:${port}`);
                treeClientRef.current = tc;
                // 子の消失 (WS切断) をホストへ報告し、fan-outスロットを解放する
                tc.on('onPeerLeft', (childId) => {
                    if (treeChildrenRef.current.delete(childId)) {
                        console.log(`[Tree] 子の消失を検出: ${childId}`);
                        const up = treeRootIdRef.current;
                        if (up && signalingRef.current?.isConnected) {
                            signalingRef.current?.sendRelay(up, 'tree:child_lost', { childId });
                        }
                    }
                });
                tc.on('onRelayMessage', (childId, t2, p2) => {
                    if (t2 === 'subscribe') {
                        console.log(`[Tree] 子の接続: ${childId}`);
                        treeChildrenRef.current.add(childId);
                        // 下流派生物をキャッシュから即配布 (鍵 → 許可状態)
                        if (cachedKeyRef.current) tc.sendRelay(childId, 'key', cachedKeyRef.current);
                        if (cachedControlRef.current) tc.sendRelay(childId, 'control_allowed', cachedControlRef.current);
                        return;
                    }
                    if (t2 === 'unsubscribe') {
                        treeChildrenRef.current.delete(childId);
                        return;
                    }
                    if (t2 === 'chat') {
                        // 子からのチャット: ローカル表示 + 上流 (ホスト) へ中継
                        const msg = p2 as unknown as ChatMessageData;
                        if (msg?.id) setChatMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
                        const up = parentTargetIdRef.current;
                        if (up) signalingRef.current?.sendRelay(up, 'chat', p2);
                        return;
                    }
                    if (t2 === 'tick' || t2 === 'share_state') {
                        // M5§7: ホストの生存信号/共有状態を子へパススルー
                        forwardToTreeChildren(t2, p2);
                        return;
                    }
                    if (t2 === 'ping') {
                        // M5 フェーズC: 子のRTT計測に応答
                        tc.sendRelay(childId, 'pong', p2);
                        return;
                    }
                    if (t2 === 'tree:parent_lost') {
                        // M5§7: 子からの停滞報告 → originIdを付けて上流 (ホスト) へ転送
                        const up = parentTargetIdRef.current;
                        if (up) {
                            const lost = (p2 || {}) as Record<string, unknown>;
                            signalingRef.current?.sendRelay(up, 'tree:parent_lost', { ...lost, originId: childId });
                        }
                        return;
                    }
                    if (t2 === 'input') {
                        // 子からのリモート操作入力: 発信者ID (originId) を付けてホストへ中継。
                        // 中継自身のグラントではなく子のグラントで検証される (issue#8)
                        const up = parentTargetIdRef.current;
                        if (up) {
                            const inp = (p2 || {}) as { type?: unknown; payload?: unknown };
                            signalingRef.current?.sendRelay(up, 'input', {
                                type: inp.type, payload: inp.payload, originId: childId,
                            });
                        }
                        return;
                    }
                });
                await tc.connect();
                tc.createRoom(roomNameRef.current, roomCodeRef.current || undefined);
                // ホストへ準備完了 → 以後の参加者をここへ割り当ててもらう
                signalingRef.current?.sendRelay(hostId, 'tree:relay_ready', { addr: treeSelfAddrRef.current });
                // M5 フェーズC: 5秒毎に自分の健康 (配下の子数・上流の無音時間) を報告。
                // ホストはこれをもとに、不健康な中継へ新しい子を割り当てない
                if (relayMetricsTimerRef.current) clearInterval(relayMetricsTimerRef.current);
                relayMetricsTimerRef.current = window.setInterval(() => {
                    const up = treeRootIdRef.current;
                    if (!up || !signalingRef.current?.isConnected) return;
                    signalingRef.current?.sendRelay(up, 'tree:metrics', {
                        children: treeChildrenRef.current.size,
                        upstreamSilentMs: Date.now() - relayWatchdogRef.current.lastActivityAt,
                        rttMs: upstreamRttRef.current ?? undefined,
                    });
                    // RTT実測 (pong応答で upstreamRttRef を更新)
                    signalingRef.current?.sendRelay(up, 'ping', { ts: Date.now() });
                }, 5000);
            } catch (e) {
                console.error('[Tree] 中継への昇格に失敗:', e);
                treeRoleRef.current = 'none';
            }
        })();
    };

    /** 中継者: 受け取ったチャンク/鍵/許可状態/チャットを子へパススルー転送 (§3.2) */
    const forwardToTreeChildren = (type: string, payload: unknown): void => {
        const tc = treeClientRef.current;
        if (!tc || treeChildrenRef.current.size === 0) return;
        for (const child of treeChildrenRef.current) {
            tc.sendRelay(child, type, payload);
        }
    };

    /**
     * 送信経路の選択 (M2)。WSが生きていれば従来通りサーバーへ、
     * 死んでいればDataChannel (直結 or 中継1ホップ) で届ける。
     */
    const sendSig = (targetId: string, kind: SignalKind, payload: unknown) => {
        const signaling = signalingRef.current;
        if (signaling?.isConnected) {
            if (kind === 'offer') signaling.sendOffer(targetId, payload as RTCSessionDescriptionInit);
            else if (kind === 'answer') signaling.sendAnswer(targetId, payload as RTCSessionDescriptionInit);
            else signaling.sendIceCandidate(targetId, payload as RTCIceCandidateInit);
            return;
        }
        const myId = myIdRef.current || '';
        const directDc = dataChannelsRef.current.get(targetId);
        const hasDirect = !!directDc && directDc.readyState === 'open';
        const candidates = [...dataChannelsRef.current.entries()]
            .filter(([, dc]) => dc.readyState === 'open')
            .map(([id]) => id);
        const route = chooseSignalRoute(targetId, {
            wsOpen: false, myId, hasDirectDc: hasDirect, relayCandidates: candidates,
        });
        const envelope = makeEnvelope(myId, kind, targetId, payload);
        if (route.via === 'dc-direct' && directDc) {
            directDc.send(JSON.stringify({ type: 'tunnel:sig', payload: envelope, timestamp: Date.now() }));
            console.log(`[Tunnel] ${kind}を直接DC送信: ${targetId}`);
        } else if (route.via === 'dc-relay' && route.relayPeer) {
            const relayDc = dataChannelsRef.current.get(route.relayPeer);
            if (relayDc) {
                relayDc.send(JSON.stringify({ type: 'tunnel:sig', payload: envelope, timestamp: Date.now() }));
                console.log(`[Tunnel] ${kind}を${route.relayPeer}経由で中継: ${targetId}`);
            }
        } else {
            console.warn(`[Tunnel] ${kind}の送信経路なし: ${targetId}`);
        }
    };

    const handleIncomingOffer = (senderId: string, sdp: RTCSessionDescriptionInit) => {
        if (relayModeRef.current) return; // リレーモードではWebRTC経路を使わない
        // 監査#1: 参加者リスト外のpeerからのOfferは破棄 (サーバー側検証の二重化)
        if (!participantsRef.current.has(senderId)) {
            console.warn(`[WebRTC] 参加者リスト外のOfferを破棄: ${senderId}`);
            return;
        }
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
                sendSig(senderId, 'answer', answer);
            } catch (e) {
                console.error('[WebRTC] Offer処理失敗:', (e as Error)?.message || String(e));
            }
        });
    };

    const handleIncomingAnswer = (senderId: string, sdp: RTCSessionDescriptionInit) => {
        if (relayModeRef.current) return;
        // 監査#1: 参加者リスト外のpeerからのAnswerは破棄
        if (!participantsRef.current.has(senderId)) {
            console.warn(`[WebRTC] 参加者リスト外のAnswerを破棄: ${senderId}`);
            return;
        }
        const pc = peerConnectionsRef.current.get(senderId);
        if (!pc) return;
        return enqueueSdpOp(pc, async () => {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            } catch (e) {
                console.error('[WebRTC] Answer処理失敗:', (e as Error)?.message || String(e));
            }
        });
    };

    const handleIncomingIce = (senderId: string, candidate: RTCIceCandidateInit) => {
        // 監査#1: 参加者リスト外のpeerからのICE候補は破棄
        if (!participantsRef.current.has(senderId)) return;
        const pc = peerConnectionsRef.current.get(senderId);
        if (pc) {
            void pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* no-op */ });
        }
    };

    /**
     * tunnel:sig 封筒の処理 (M2)。宛先が自分なら着信処理、
     * 違えば自分のWS/DCで次ホップへ転送する (伝言板)。
     */
    const handleTunnelEnvelope = (envelope: TunnelEnvelope) => {
        if (!envelope || typeof envelope.targetId !== 'string') return;
        const myId = myIdRef.current || '';
        if (envelope.targetId === myId) {
            if (envelope.kind === 'offer') handleIncomingOffer(envelope.originalSender, envelope.payload as RTCSessionDescriptionInit);
            else if (envelope.kind === 'answer') handleIncomingAnswer(envelope.originalSender, envelope.payload as RTCSessionDescriptionInit);
            else if (envelope.kind === 'ice') handleIncomingIce(envelope.originalSender, envelope.payload as RTCIceCandidateInit);
            return;
        }
        const fwd = forwardEnvelope(envelope);
        if (!fwd) {
            console.warn(`[Tunnel] ホップ切れ: ${envelope.originalSender} -> ${envelope.targetId}`);
            return;
        }
        const signaling = signalingRef.current;
        if (signaling?.isConnected) {
            signaling.sendTunnel(envelope.targetId, fwd);
            return;
        }
        const relayDc = dataChannelsRef.current.get(fwd.targetId);
        if (relayDc?.readyState === 'open') {
            relayDc.send(JSON.stringify({ type: 'tunnel:sig', payload: fwd, timestamp: Date.now() }));
            return;
        }
        const candidates = [...dataChannelsRef.current.entries()]
            .filter(([id, dc]) => dc.readyState === 'open' && id !== myId && id !== fwd.targetId)
            .map(([id]) => id)
            .sort();
        if (candidates.length > 0) {
            const dc = dataChannelsRef.current.get(candidates[0]);
            dc?.send(JSON.stringify({ type: 'tunnel:sig', payload: fwd, timestamp: Date.now() }));
        } else {
            console.warn(`[Tunnel] 転送経路なし: ${fwd.originalSender} -> ${fwd.targetId}`);
        }
    };

    // DCで届くゴシップ/トンネル系メッセージの振り分け (setupDataChannelから参照。
    // 毎レンダーで最新クロージャを差し替える — e2eDepsRefと同じパターン)
    dcDispatchRef.current = (type: string, payload: unknown, _fromPeer: string) => {
        if (type === 'roster:sync') {
            const p = (payload || {}) as { entries?: RosterEntry[]; tombstones?: { id: string; departedAt: number }[] };
            const theirs = initRoster();
            (p.entries || []).forEach(e => mergeEntry(theirs, e as RosterEntry));
            (p.tombstones || []).forEach(t => applyDepart(theirs, t.id, t.departedAt));
            rosterRef.current = mergeRosters(rosterRef.current, theirs);
            // サーバーが死んでいる場合のみ、ゴシップで発見した未知ピアへ自分から接続する
            // (生きている間はサーバーのfanout+ID規約で接続するため二重接続を避ける)
            const serverDown = !signalingRef.current?.isConnected;
            if (serverDown && !relayModeRef.current && myIdRef.current) {
                for (const e of rosterEntries(rosterRef.current)) {
                    if (e.id === myIdRef.current) continue;
                    if (peerConnectionsRef.current.has(e.id)) continue;
                    if (dataChannelsRef.current.has(e.id)) continue;
                    if (shouldInitiateTo(myIdRef.current, e.id)) {
                        console.log(`[Roster] ゴシップで未知ピアを発見 → 接続開始: ${e.id}`);
                        createPeerConnection(e.id, true);
                    }
                }
            }
            broadcastRosterSync();
            return;
        }
        if (type === 'roster:depart') {
            const p = (payload || {}) as { peerId?: string; departedAt?: number };
            if (p.peerId) {
                applyDepart(rosterRef.current, p.peerId, p.departedAt || Date.now());
                broadcastRosterSync();
            }
            return;
        }
        if (type === 'tunnel:sig') {
            handleTunnelEnvelope(payload as TunnelEnvelope);
            return;
        }
    };

    /**
     * 中央サーバー死亡からの移行 (M2)。ホストは自分の内蔵サーバーへ、
     * ゲストは電話帳で学んだホストendpointへ再参加する。4秒待って中央が
     * 戻らなければ発動 (一時的な瞬断を移行で潰さない)。
     */
    const scheduleEmbeddedMigration = () => {
        if (migratedRef.current) return;
        window.setTimeout(() => {
            if (signalingRef.current?.isConnected) return;
            if (!roomCodeRef.current || migratedRef.current) return;
            const isHost = isHostRef.current;
            const port = embeddedPortRef.current;
            const endpoint = hostEndpointRef.current;
            if (isHost && port) {
                migratedRef.current = true;
                rootServerUrlRef.current = `ws://127.0.0.1:${port}`;
                console.log('[WebRTC] 中央サーバー死亡 → 内蔵サーバーへ移行');
                void switchSignalingRef.current(`ws://127.0.0.1:${port}`).catch((e) => {
                    console.error('[WebRTC] 移行失敗:', e);
                    migratedRef.current = false;
                });
            } else if (!isHost && endpoint) {
                migratedRef.current = true;
                rootServerUrlRef.current = `ws://${endpoint}`;
                console.log('[WebRTC] 中央サーバー死亡 → ホスト内蔵サーバーへ移行');
                void switchSignalingRef.current(`ws://${endpoint}`).catch((e) => {
                    console.error('[WebRTC] 移行失敗:', e);
                    migratedRef.current = false;
                });
            } else {
                console.log('[WebRTC] 中央サーバー死亡: 移行先が無いためDC中継で継続');
            }
        }, 4000);
    };

    const wireSignaling = (signaling: SignalingClient) => {
        signaling.on('onConnected', () => {
            setConnectionState('connected');
            // 再接続: 入室中だった部屋に自動で再参加する (サーバー側の入室状態は
            // WS切断で失われているため。これが無いとICE再起動のofferが届かない)
            if (roomCodeRef.current) {
                if (isHostRef.current) {
                    // ホスト: 移行先 (内蔵サーバー) には部屋が存在しないので room:create で
                    // 同じコードを再作成する。既存ルームがある場合は再権限トークン
                    // (issue#9) の提示が必須 — トークン無しのcreateはUNAUTHORIZEDで拒否される
                    console.log(`[WebRTC] 再接続(ホスト): 部屋 ${roomCodeRef.current} を移行先で再作成`);
                    const endpoint = embeddedPortRef.current
                        ? `${lanIpRef.current || '127.0.0.1'}:${embeddedPortRef.current}`
                        : (hostEndpointRef.current ?? undefined);
                    signaling.createRoom(roomNameRef.current, roomCodeRef.current, endpoint, hostTokenRef.current ?? undefined);
                } else {
                    console.log(`[WebRTC] 再接続: 部屋 ${roomCodeRef.current} に再参加`);
                    signaling.joinRoom(roomCodeRef.current, roomNameRef.current);
                }
            }
        });

        signaling.on('onDisconnected', () => {
            setConnectionState('disconnected');
            isConnectedRef.current = false;
            // M2: 中央サーバー死亡時は内蔵サーバー (ホスト) / ホストendpoint (ゲスト) へ移行
            scheduleEmbeddedMigration();
        });

        // サーバー由来のエラー (監査#6: 満室ルームへの参加拒否などをUIへ出す)
        signaling.on('onError', (code, message) => {
            console.error(`[Signaling] サーバーエラー: ${code} ${message}`);
            if (code === 'ROOM_FULL') {
                setError('ルームが満員です (参加者数の上限に達しています)');
            }
        });

        // ルーム作成応答: 再権限トークンを保持して以後のcreate (再接続/移行) に備える (issue#9)
        signaling.on('onRoomCreated', (_roomCode, _roomId, hostToken) => {
            if (hostToken) hostTokenRef.current = hostToken;
        });

        // room:host (issue#10): ホストの再接続でホスト接続IDが変わった
        signaling.on('onHostChanged', (hostId) => {
            if (hostIdRef.current && hostIdRef.current !== hostId) {
                console.log(`[WebRTC] ホストIDが更新されました: ${hostIdRef.current} -> ${hostId}`);
            }
            hostIdRef.current = hostId;
        });

        // 自分の参加完了通知 (既存参加者リストが来る)
        signaling.on('onRoomJoined', (_roomId, code, myClientId, existingParticipants, hostEndpoint, hostId) => {
            const prevMyId = myIdRef.current;
            setRoomCode(code);
            setMyId(myClientId);
            roomCodeRef.current = code;
            myIdRef.current = myClientId;
            isConnectedRef.current = true;
            // issue#8: 制御上の同一性 (originIdの素) は基本このIDに追従する。
            // ただし tree:assign による移動 (凍結中) はホストが知っている旧IDを維持する
            if (!controlIdFrozenRef.current) controlIdRef.current = myClientId;
            if (hostEndpoint) hostEndpointRef.current = hostEndpoint;
            if (hostId) hostIdRef.current = hostId;
            // M1: 移行 (サーバー付け替え) でクライアントIDが変わったとき、旧IDに墓石を
            // 立てる。ゴシップで全体に配布され、名簿から旧IDが収束除去される
            if (migratedRef.current && prevMyId && prevMyId !== myClientId) {
                applyDepart(rosterRef.current, prevMyId, Date.now());
            }

            // M1: 名簿に自分と既存参加者を登録 (サーバーが配ったjoinedAtを使う=決定論的)
            selfJoinedAtRef.current = selfJoinedAtRef.current || Date.now();
            mergeEntry(rosterRef.current, { id: myClientId, name: roomNameRef.current, joinedAt: selfJoinedAtRef.current });
            for (const p of existingParticipants) {
                mergeEntry(rosterRef.current, { id: p.id, name: p.name, joinedAt: p.joinedAt });
            }

            // 参加者リスト更新 (refは同時に更新 — 監査#1の送信者チェック用)。
            // 移行再参加時は中央経由で知った既存ピアを保持する (内蔵サーバーには不在のため)
            const pMap = new Map<string, ParticipantInfo>();
            if (migratedRef.current) {
                participantsRef.current.forEach((v, k) => pMap.set(k, v));
            }
            existingParticipants.forEach(p => pMap.set(p.id, p));
            participantsRef.current = pMap;
            setParticipants(pMap);

            // **Full Mesh Logic**: 既存の参加者全員に対して Initiator となり接続開始
            // リレーモード (WebRTC非対応エンジン) ではPCを作らず、リレー購読だけ行う
            // 配信木: チャンク供給元 (=自分の接続先サーバーの部屋主) を記録。
            // 子からの chat/input を上流へ中継する宛先になる
            parentTargetIdRef.current = existingParticipants[0]?.id ?? null;
            existingParticipants.forEach(p => {
                if (relayModeRef.current) {
                    signalingRef.current?.sendRelay(p.id, 'subscribe', detectRelayCapabilities());
                } else {
                    createPeerConnection(p.id, true); // Initiator = true
                }
            });
            // リレー視聴者のsubscribe再送: 複数WS間の到達順競合で、視聴者のsubscribeが
            // ホストのpeer:joined処理より先に届くと参加者ガードに破棄されるため、
            // 鍵 (relay:key) を受け取るまで再送し続けて収束させる (ホスト側の登録は冪等)
            if (relayModeRef.current && existingParticipants.length > 0) {
                [2000, 5000, 9000, 14000].forEach(delay => window.setTimeout(() => {
                    if (!signalingRef.current?.isConnected) return;
                    if (cachedKeyRef.current) return; // 既に鍵受信=受信経路は確立済み
                    for (const p of existingParticipants) {
                        if (!participantsRef.current.has(p.id)) continue;
                        signalingRef.current?.sendRelay(p.id, 'subscribe', detectRelayCapabilities());
                    }
                }, delay));
            }
            broadcastRosterSync();
        });

        // 他の誰かが参加通知
        signaling.on('onPeerJoined', (peerId, name) => {
            console.log(`[WebRTC] Peer参加: ${peerId}`);
            mergeEntry(rosterRef.current, { id: peerId, name, joinedAt: Date.now() });
            // M1: 新ピアの参加をゴシップで全体へ (サーバー死亡時、DCしか持たない
            // ピアが新ピアを発見できる唯一の経路)
            broadcastRosterSync();
            setParticipants(prev => {
                const next = new Map(prev);
                next.set(peerId, { id: peerId, name, joinedAt: Date.now() });
                participantsRef.current = next;
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
            applyDepart(rosterRef.current, peerId, Date.now());
            {
                // 配信木: 中継者が消えた場合、subtreeの解放+孤児は各自 parent_lost
                // 経由で再参加する (親が消えた時点で子のWSも落ちるため)
                const c = treeCoordinatorRef.current;
                if (c) {
                    const orphans = handleNodeLoss(c.root, peerId);
                    if (orphans.length > 0) {
                        console.log(`[Tree] 中継 ${peerId} が消失 — 孤児 ${orphans.length} 人を再割り当て対象に`);
                        const hostAddr = hostEndpointRef.current
                            ?? (embeddedPortRef.current ? `${lanIpRef.current || '127.0.0.1'}:${embeddedPortRef.current}` : null);
                        for (const o of orphans) {
                            signalingRef.current?.sendRelay(o.id, 'tree:assign', hostAddr
                                ? { addr: hostAddr }
                                : { rejoin: true });
                        }
                    }
                }
            }
            setParticipants(prev => {
                const next = new Map(prev);
                next.delete(peerId);
                participantsRef.current = next;
                return next;
            });
            // 離脱をゴシップで全体へ (M1: サーバーfanoutの二重化。サーバー死亡時はこれが主経路)
            broadcastData('roster:depart', { peerId, departedAt: Date.now() });
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

        signaling.on('onOffer', (senderId, sdp) => handleIncomingOffer(senderId, sdp));

        signaling.on('onAnswer', (senderId, sdp) => handleIncomingAnswer(senderId, sdp));

        signaling.on('onIceCandidate', (senderId, candidate) => handleIncomingIce(senderId, candidate));

        // DC中継シグナリング: サーバー経由で届いた封筒 (M2)
        signaling.on('onTunneledMessage', (_forwarder, envelope) => handleTunnelEnvelope(envelope));

        // WSリレー (WebRTC非対応エンジンのフォールバック経路)
        signaling.on('onRelayMessage', (senderId, type, payload) => {
            // M5 E2E故障注入: この間の着信を握りつぶし (ウォッチドッグ停滞テスト)
            if (Date.now() < relaySuppressUntilRef.current) {
                if (!suppressLoggedRef.current) {
                    suppressLoggedRef.current = true;
                    console.log('[M5] suppress発動中: 着信を破棄します');
                }
                return;
            }
            suppressLoggedRef.current = false;
            // 監査#1: 参加者リスト外のpeerからのリレーメッセージは破棄。
            // relay:key も同様に参加者限定 (issue#11)
            if (!participantsRef.current.has(senderId)) {
                console.warn(`[Relay] 参加者リスト外のメッセージを破棄: ${senderId} (${type})`);
                return;
            }
            if (type === 'key') {
                const p = (payload || {}) as Record<string, unknown>;
                if (typeof p.pub === 'string') {
                    // issue#11: 指紋照合 + pin-first。差し替え/なりすまし鍵は受理しない
                    const verdict = acceptKeyCandidate(expectedKeyFpRef.current, relayPubKeyRef.current, p.pub);
                    if (!verdict.accept) {
                        console.warn(`[Relay] 公開鍵を受理しない (${verdict.reason}) — 破棄`);
                        return;
                    }
                    relayPubKeyRef.current = p.pub;
                    cachedKeyRef.current = p;
                    console.log('[Relay] 署名検証用の公開鍵を受信 (pin済み)');
                    // 中継者: 子へも配布
                    forwardToTreeChildren('key', p);
                }
                return;
            }
            const p = (payload || {}) as Record<string, unknown>;
            if (type === 'tick') {
                // M5§7: ホストの生存信号。中継は下流へパススルー
                noteRelayActivity();
                forwardToTreeChildren('tick', p);
                return;
            }
            if (type === 'ping') {
                // M5 フェーズC: RTT実測。受信したらそのままpongで返す (ホスト/中継共通)
                signalingRef.current?.sendRelay(senderId, 'pong', p);
                return;
            }
            if (type === 'pong') {
                const sentAt = Number(p.ts) || 0;
                if (sentAt > 0) upstreamRttRef.current = Date.now() - sentAt;
                return;
            }
            if (type === 'share_state') {
                // M5§7: ホストの共有開始/停止。停止時は停滞監視を解除する
                if (p.active) {
                    relayWatchdogRef.current = armWatchdog(relayWatchdogRef.current, Date.now());
                } else {
                    relayWatchdogRef.current = disarmWatchdog(relayWatchdogRef.current, Date.now());
                    console.log('[Watchdog] 共有が終了したため停滞監視を解除');
                }
                forwardToTreeChildren('share_state', p);
                return;
            }
            if (type === 'frame') {
                // ゲスト側: JPEGフォールバックも h264/audio と同じ検証を掛ける (issue#11)。
                // ホストはframeにもseq+Ed25519署名を付与済みなので検証コスト以外の変更なし
                if (!verifyRelayChunk(p, 'frame')) return;
                noteRelayActivity();
                // 検証済みフレームだけを子へパススルー (中継者)
                forwardToTreeChildren('frame', p);
                // 最新フレームを保持 (setStateは描画レートに合わせて間引く)
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
                // issue#8: この視聴者への許可状態だけを配布 (全員共通のboolではない)
                {
                    const gAllowed = isControlAllowed(controlGrantsRef.current, senderId, Date.now());
                    signalingRef.current?.sendRelay(senderId, 'control_allowed', {
                        allowed: gAllowed,
                        expiresAt: gAllowed ? controlGrantsRef.current.get(senderId)?.expiresAt ?? 0 : 0,
                    });
                }
                // M3: 署名検証用の公開鍵を配布 (ルーム毎のエフェメラル鍵)
                if (relayKeysRef.current) {
                    signalingRef.current?.sendRelay(senderId, 'key', { pub: relayKeysRef.current.publicKeyB64 });
                }
                // 配信木: ホスト直結の上限管理 (超過時は中継へ昇格/割り当て)
                coordinateTree(senderId);
                console.log(`[Relay] 視聴者登録: ${senderId} (mse=${caps.mse} webmAudio=${caps.webmAudio}, 計${relaySubscribersRef.current.size}人)`);
                return;
            }
            if (type === 'h264') {
                // ゲスト側: fMP4のbox (init/fragment) を順にappend
                if (!verifyRelayChunk(p, 'video')) return;
                noteRelayActivity();
                // M2: 中継者は検証済みペイロードを無改変で子へパススルー (再エンコードなし)
                forwardToTreeChildren('h264', p);
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
                if (!verifyRelayChunk(p, 'audio')) return;
                noteRelayActivity();
                forwardToTreeChildren('audio', p);
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
                // 配信木: 登録解除 (子を持つ中継者の消失なら subtreeごと解放)
                const c = treeCoordinatorRef.current;
                if (c) {
                    const orphans = handleNodeLoss(c.root, senderId);
                    if (orphans.length > 0) {
                        console.log(`[Tree] 中継 ${senderId} が離脱 — 孤児 ${orphans.length} 人を再割り当て対象に`);
                        const hostAddr = hostEndpointRef.current
                            ?? (embeddedPortRef.current ? `${lanIpRef.current || '127.0.0.1'}:${embeddedPortRef.current}` : null);
                        for (const o of orphans) {
                            signalingRef.current?.sendRelay(o.id, 'tree:assign', hostAddr
                                ? { addr: hostAddr }
                                : { rejoin: true });
                        }
                    }
                }
                return;
            }
            if (type === 'tree:promote') {
                // 中継者への昇格指示 (ホストのコーディネータ)。
                // issue#10: 非ホストからの指示に乗ると、任意の ws:// へ接続を
                // 切り替えさせられる (中継昇格は自分の内蔵サーバー起動を伴う)
                if (senderId !== hostIdRef.current) {
                    console.warn(`[Tree] 非ホスト (${senderId}) からの昇格指示を破棄`);
                    return;
                }
                handleTreePromote(senderId);
                return;
            }
            if (type === 'tree:relay_ready') {
                handleTreeRelayReady(senderId, p);
                return;
            }
            if (type === 'tree:assign') {
                // 割り当てられた中継 (の内蔵サーバー) へ付け替える。
                // issue#10: 接続先を書き換えられるのはホストの割り当てだけ
                if (senderId !== hostIdRef.current) {
                    console.warn(`[Tree] 非ホスト (${senderId}) からの割り当てを破棄 — 接続先は変更しない`);
                    return;
                }
                if (p.rejoin === true) {
                    // M5§7: root直結への復帰指示。現在の接続先 (中央 or ホスト内蔵)
                    // へ再ダイヤルして fresh な部屋参加を作り直す
                    relayWatchdogRef.current = noteSwitch(relayWatchdogRef.current, Date.now());
                    const url = rootServerUrlRef.current ?? lastKnownServerUrlRef.current;
                    if (url) {
                        console.log(`[Tree] rejoin指示 — 根 (${url}) へ再ダイヤルします`);
                        void switchSignalingRef.current(url).catch((e) => {
                            console.error('[Tree] rejoin再ダイヤルに失敗:', e);
                        });
                    }
                    return;
                }
                // addrは {host,port} (中継) または "host:port" 文字列 (ホスト直結へ戻す) 両対応
                const addrRaw = p.addr as { host?: unknown; port?: unknown } | string | undefined;
                const addr = typeof addrRaw === 'string'
                    ? (() => {
                        const [h, portStr] = addrRaw.split(':');
                        const port = Number(portStr);
                        return h && Number.isFinite(port) && port > 0 ? { host: h, port } : undefined;
                    })()
                    : (addrRaw as { host: string; port: number } | undefined);
                if (addr?.host && addr.port) {
                    console.log(`[Tree] ${addr.host}:${addr.port} へ移動します`);
                    // M5§7: 切替を記録し、ウォッチドッグのクールダウンを起動
                    relayWatchdogRef.current = noteSwitch(relayWatchdogRef.current, Date.now());
                    // issue#8: 移動先のサーバーでは myId が変わる。ホストの承認は
                    // 「今のホスト部屋でのID」に対して行われるので、それを凍結する
                    controlIdRef.current = myIdRef.current;
                    controlIdFrozenRef.current = true;
                    connectedViaRef.current = 'relay';
                    void switchSignalingRef.current(`ws://${addr.host}:${addr.port}`).catch((e) => {
                        console.error('[Tree] 中継への移動に失敗:', e);
                    });
                }
                return;
            }
            if (type === 'tree:metrics') {
                // M5 フェーズC: 中継からの定周期メトリクスを記録し、
                // 新規割り当ての親選定に使う
                if (isHostRef.current) {
                    const c = treeCoordinatorRef.current;
                    const node = c ? findTreeNode(c.root, senderId) : null;
                    if (node && node.addr) {
                        treeHealthRef.current.set(senderId, {
                            at: Date.now(),
                            upstreamSilentMs: Number(p.upstreamSilentMs) || 0,
                            children: Number(p.children) || 0,
                            rttMs: Number(p.rttMs) || undefined,
                        });
                        setTreeHealth(new Map(treeHealthRef.current));
                    }
                }
                return;
            }
            if (type === 'tree:parent_lost') {
                // M5§7: 親からの受信停滞を視聴者が検知 → ホストが再割り当てする。
                // 中継経由の場合は中継が originId (実際の視聴者ID) を付けて転送する
                const originId = typeof p.originId === 'string' && p.originId ? p.originId : senderId;
                if (!isHostRef.current) {
                    console.warn(`[Tree] 非ホストがparent_lostを無視 (${originId})`);
                    return;
                }
                const c = treeCoordinatorRef.current;
                if (!c || !findTreeNode(c.root, originId)) {
                    console.warn(`[Tree] parent_lost: ${originId} は木に居ないため無視`);
                    return;
                }
                console.log(`[Tree] 親停滞の報告: ${originId} を再割り当てします`);
                detachNode(c.root, originId);
                coordinateTree(originId, { reassignHost: true });
                return;
            }
            if (type === 'tree:child_lost') {
                // 中継者からの子の消失報告 → 木から解放し、空きスロットへ再割り当て。
                // issue#10: 報告者は「昇格済み (addrを持つ) の木の中継ノード」に限る。
                // 任意の参加者からの偽報告で木を崩されるのを防ぐ
                const c = treeCoordinatorRef.current;
                const childId = p.childId as string;
                const reporter = c ? findTreeNode(c.root, senderId) : null;
                if (c && childId && reporter && reporter.addr) {
                    handleNodeLoss(c.root, childId);
                    coordinateTree(senderId);
                }
                return;
            }
            if (type === 'control_allowed') {
                // issue#10: 許可状態の配布はホスト (または配布を中継する自ノードの親)
                // からのみ。任意の参加者が「操作許可」を偽装するのを防ぐ
                if (senderId !== hostIdRef.current && senderId !== parentTargetIdRef.current) {
                    console.warn(`[Relay] 非権威 (${senderId}) からのcontrol_allowedを破棄`);
                    return;
                }
                // issue#8: 宛先指定 (配信木経由のpeer単位配布)。自分宛てでなければ
                // バッジは更新せず、下流への転送のみ行う (中継は転送屋)
                const targetOriginId = typeof p.targetOriginId === 'string' ? p.targetOriginId : '';
                const myControlId = controlIdRef.current || myIdRef.current || '';
                const allowed = !!p.allowed;
                const expiresAt = typeof p.expiresAt === 'number' ? p.expiresAt : 0;
                if (!targetOriginId || targetOriginId === myControlId) {
                    setPeerControlBadge(senderId, allowed, expiresAt);
                    // 中継者が子の既定値として使うのは「宛先なしのブロードキャスト」だけ
                    // (最後に届いた特定視聴者向けの許可を既定値にしない)
                    if (!targetOriginId) cachedControlRef.current = p;
                } else {
                    console.log(`[Relay] 他人宛てのcontrol_allowedを転送のみで処理: ${targetOriginId}`);
                }
                // 中継者: 子へも配布 (ホストの許可状態を下流へ伝播)
                forwardToTreeChildren('control_allowed', p);
                return;
            }
            if (type === 'chat') {
                const msg = p as unknown as ChatMessageData;
                if (msg?.id) {
                    setChatMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
                }
                // 中継者: 下流の子へも転送
                forwardToTreeChildren('chat', p);
                return;
            }
            if (type === 'input') {
                // ホスト側: 発信者を確定してグラントを検証してから適用 (F-022 / issue#8)。
                // 配信木の中継経由では originId に実際の視聴者IDが載る (中継は転送のみ)
                const { originId, type: inputType, payload: inputPayload } = resolveInputOrigin(senderId, p);
                if (!inputType.startsWith('input:')) return;
                if (isControlAllowed(controlGrantsRef.current, originId, Date.now())) {
                    relayStatsRef.current.inputsApplied++;
                    void applyInputEvent(inputType, inputPayload);
                } else {
                    relayStatsRef.current.inputsRejected++;
                    warnRejectThrottled(originId);
                }
                return;
            }
        });
    };
    // 毎レンダーで最新のクロージャへ差し替え (setupDataChannel/e2eDepsRefと同じ規約)
    wireSignalingRef.current = wireSignaling;

    const connect = useCallback(async (roomCode?: string) => {
        if (signalingRef.current) return;

        setConnectionState('connecting');
        // Cloudflare Workers版: ?room=コード でルームDOへルーティングされる
        // (Node/内蔵サーバーはクエリを無視するため互換)
        const url = roomCode ? `${targetSignalingUrl}?room=${roomCode}` : targetSignalingUrl;
        lastKnownServerUrlRef.current = url;
        rootServerUrlRef.current = url; // 木の根 (ホストの部屋) のURL
        const signaling = new SignalingClient(url);
        signalingRef.current = signaling;
        wireSignalingRef.current(signaling);

        await signaling.connect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setConnectionState, targetSignalingUrl]);

    /**
     * 指定URLのサーバーへ signaling クライアントを付け替える (M2移行 / M4招待v2)。
     * 旧クライアントはdisposeして再接続ループを止める。
     */
    const switchSignaling = async (url: string) => {
        lastKnownServerUrlRef.current = url;
        const old = signalingRef.current;
        if (old) {
            old.dispose();
            signalingRef.current = null;
        }
        setConnectionState('connecting');
        const signaling = new SignalingClient(url);
        signalingRef.current = signaling;
        wireSignalingRef.current(signaling);
        await signaling.connect();
        // 再参加は wireSignaling の onConnected 内 (roomCodeRef) で行われる
    };
    switchSignalingRef.current = switchSignaling;
    /**
     * ルーム作成・参加
     */
    const createRoom = useCallback(async (name?: string) => {
        isHostRef.current = true;
        treeRoleRef.current = 'host';
        migratedRef.current = false;
        selfJoinedAtRef.current = Date.now();
        // M2: ホスト内蔵サーバーを起動 (中央サーバー死亡後の再合流・サーバーレス参加の入口)
        try {
            embeddedPortRef.current = await invoke<number>('embedded_server_start', { port: null });
            lanIpRef.current = await invoke<string | null>('get_local_lan_address');
            console.log(`[Embedded] port=${embeddedPortRef.current} lan=${lanIpRef.current}`);
        } catch (e) {
            console.warn('[Embedded] 起動に失敗 (内蔵サーバーなしで続行):', e);
        }
        // M3: リレー署名鍵をルーム毎に生成 (エフェメラル・退出と共に無効)
        try {
            relayKeysRef.current = generateRelayKeyPair();
            relayPubKeyRef.current = null;
        } catch (e) {
            console.warn('[Relay] 署名鍵の生成に失敗 (無署名で続行):', e);
        }
        roomNameRef.current = name;
        // コードはローカル生成 (中央サーバーには電話帳登録として渡し、
        // 内蔵サーバーと同じコードでサーバーレス参加を可能にする)
        const localCode = genLocalRoomCode();
        const endpoint = embeddedPortRef.current
            ? `${lanIpRef.current || '127.0.0.1'}:${embeddedPortRef.current}`
            : null;
        hostEndpointRef.current = endpoint;
        try {
            // 3秒で中央に繋がらなければサーバーレスfallbackへ (TCPタイムアウト待ちを避ける)
            await Promise.race([
                connect(localCode),
                new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 3000)),
            ]);
            signalingRef.current?.createRoom(name, localCode, endpoint ?? undefined, hostTokenRef.current ?? undefined);
        } catch (e) {
            // M4: 中央サーバー無しで部屋を作る (LAN完全サーバーレス)
            console.warn('[WebRTC] 中央サーバーに接続できない → 内蔵サーバーのみで作成:', e);
            if (!embeddedPortRef.current) throw e;
            await switchSignalingRef.current(`ws://127.0.0.1:${embeddedPortRef.current}`);
            signalingRef.current?.createRoom(name, localCode, endpoint ?? undefined, hostTokenRef.current ?? undefined);
        }
    }, [connect]);

    const joinRoom = useCallback(async (code: string, name?: string) => {
        await connect(code);
        roomNameRef.current = name;
        signalingRef.current?.joinRoom(code, name);
    }, [connect]);

    /**
     * 指定サーバーURLで部屋に参加する (M4: 招待v2 p2d://join/CODE@host:port の直行経路)
     */
    const joinRoomAt = useCallback(async (code: string, wsUrl: string, name?: string) => {
        isHostRef.current = false;
        migratedRef.current = false;
        selfJoinedAtRef.current = Date.now();
        roomNameRef.current = name;
        if (signalingRef.current) {
            signalingRef.current.dispose();
            signalingRef.current = null;
        }
        setConnectionState('connecting');
        rootServerUrlRef.current = wsUrl;
        lastKnownServerUrlRef.current = wsUrl;
        const signaling = new SignalingClient(wsUrl);
        signalingRef.current = signaling;
        wireSignalingRef.current(signaling);
        await signaling.connect();
        signaling.joinRoom(code, name);
    }, [setConnectionState]);

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
        signalingRef.current?.dispose();
        signalingRef.current = null;
        // レンデブー最小化: ホストは内蔵サーバーを止め、ゴシップ状態をリセットする
        if (isHostRef.current) {
            void invoke('embedded_server_stop').catch(() => { /* noop */ });
        }
        isHostRef.current = false;
        migratedRef.current = false;
        hostEndpointRef.current = null;
        embeddedPortRef.current = null;
        // issue#9/#11: 認可・検証状態も退出と共にリセット
        controlGrantsRef.current.clear();
        setControlGrants(new Map());
        hostTokenRef.current = null;
        hostIdRef.current = null;
        expectedKeyFpRef.current = null;
        rosterRef.current = initRoster();
        relayKeysRef.current = null;
        relayPubKeyRef.current = null;
        relayLastSeqRef.current = {};
        // 配信木の状態リセット (中継者は内蔵サーバーとの接続も切る)
        treeClientRef.current?.dispose();
        treeClientRef.current = null;
        treeChildrenRef.current.clear();
        treeRoleRef.current = 'none';
        treeSelfAddrRef.current = null;
        treeCoordinatorRef.current = null;
        parentTargetIdRef.current = null;
        cachedKeyRef.current = null;
        cachedControlRef.current = null;
        // issue#8: リモート操作の承認状態は退出と共に全消去。
        // 期限タイマー・視聴者バッジ・制御上の同一性もリセットする
        controlGrantsRef.current.clear();
        syncGrantsState();
        for (const t of peerControlExpiryTimersRef.current.values()) window.clearTimeout(t);
        peerControlExpiryTimersRef.current.clear();
        setPeerControlAllowed(new Map());
        controlIdRef.current = null;
        controlIdFrozenRef.current = false;
        // M5§7: ウォッチドッグも初期化
        relayWatchdogRef.current = initWatchdogState(Date.now());
        if (relayMetricsTimerRef.current) {
            clearInterval(relayMetricsTimerRef.current);
            relayMetricsTimerRef.current = null;
        }
        treeHealthRef.current.clear();
        setTreeHealth(new Map());
        upstreamRttRef.current = null;
        demotedRelaysRef.current.clear();
        rootServerUrlRef.current = null;
        if (relayTickTimerRef.current) {
            clearInterval(relayTickTimerRef.current);
            relayTickTimerRef.current = null;
        }
        setRemoteControlAllowedState(false);

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

        const empty = new Map<string, ParticipantInfo>();
        participantsRef.current = empty;
        setParticipants(empty);
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

    // M5 フェーズC: 降格 — 上流停滞中継の配下の子を健康な親へ移動する (ホスト, 5秒毎)
    useEffect(() => {
        const t = window.setInterval(() => {
            if (!isHostRef.current) return;
            const c = treeCoordinatorRef.current;
            if (!c) return;
            const now = Date.now();
            for (const [relayId, m] of treeHealthRef.current) {
                if (now - m.at >= 20000) continue; // 古い報告は無視 (死亡は各自のwatchdogが扱う)
                const node = findTreeNode(c.root, relayId);
                const unhealthy = m.upstreamSilentMs > 8000;
                const demoted = demotedRelaysRef.current.has(relayId);
                if (unhealthy && !demoted && node && node.children.length > 0) {
                    demotedRelaysRef.current.add(relayId);
                    console.warn(`[Tree] 中継 ${relayId.slice(0, 8)} を降格: 上流停滞のため配下 ${node.children.length}人を移動します`);
                    for (const child of [...node.children]) {
                        detachNode(c.root, child.id);
                        coordinateTree(child.id, { reassignHost: true });
                    }
                } else if (!unhealthy && demoted) {
                    demotedRelaysRef.current.delete(relayId);
                    console.log(`[Tree] 中継 ${relayId.slice(0, 8)} の降格を解除 (上流回復)`);
                }
            }
        }, 5000);
        return () => window.clearInterval(t);
    }, []);

    // M5§7: リレー受信の停滞ウォッチドッグ (1秒毎)。リレーモード専用
    // (meshには既存のconnectionQuality/再構築経路がある)。判定はrelayWatchdog.ts
    useEffect(() => {
        const t = window.setInterval(() => {
            if (!relayModeRef.current) return;
            const now = Date.now();
            const r = checkWatchdog(relayWatchdogRef.current, now);
            relayWatchdogRef.current = r.state;
            // フェーズB: バッジ用の健康レベル (変化したときだけsetState)
            const level = classifyLink(r.state, now);
            setLinkHealth(prev => (prev.level === level && prev.via === connectedViaRef.current)
                ? prev
                : { level, via: connectedViaRef.current });
            if (r.action === 'none') return;
            const parent = parentTargetIdRef.current;
            if (r.action === 'notify_parent_lost') {
                if (parent) {
                    console.log('[Watchdog] 親からの受信が停滞 — 再割り当てを要求します');
                    signalingRef.current?.sendRelay(parent, 'tree:parent_lost', {});
                }
                return;
            }
            if (r.action === 'force_reconnect') {
                const url = lastKnownServerUrlRef.current;
                if (url) {
                    console.log(`[Watchdog] 再割当が来ないため同一親へ強制再接続: ${url}`);
                    void switchSignalingRef.current(url).catch(() => { /* 次の周期で再試行 */ });
                }
            }
        }, 1000);
        return () => window.clearInterval(t);
    }, []);

    return {
        localStream,
        remoteStreams,
        createRoom,
        joinRoom,
        joinRoomAt,
        leaveRoom,
        isConnected: connectionState === 'peer-connected' || connectionState === 'connected',
        roomCode: useConnectionStore(s => s.roomCode),
        error: useConnectionStore(s => s.error),
        clearError: () => setError(null),
        // レンデブー最小化 (M1): 名簿ゴシップの状態 (E2E収束検証用)
        getRoster: () => rosterEntries(rosterRef.current),
        // 配信木 (E2E検証用): 自ノードの状態
        setRelayMode: (v: boolean) => {
            relayModeRef.current = v;
            setIsRelayModeState(v);
        },
        /** M5 フェーズC: 木の健康マップ (ホスト表示用) */
        treeHealth,
        getTreeInfo: () => ({
            role: treeRoleRef.current,
            children: [...treeChildrenRef.current],
            addr: treeSelfAddrRef.current,
            parent: parentTargetIdRef.current,
        }),
        /** M4: 署名鍵のフィンガープリント (QR帯域外照合用) */
        getRelayKeyFingerprint: () => relayKeysRef.current ? keyFingerprint(relayKeysRef.current.publicKeyB64) : null,
        /** issue#11: 招待の鍵指紋を設定 (受信した公開鍵の照合に使う) */
        setExpectedKeyFingerprint: (fp: string | null) => { expectedKeyFpRef.current = fp; },
        participants,
        myId,
        /** 自分が部屋のホストか (操作許可UIを出す側, issue#8) */
        isHost: isHostRef.current,

        // WSリレーモード (WebRTC非対応エンジン向け)
        isRelayMode,
        /** M5 フェーズB: 視聴者側のリンク健康 (バッジ用。mesh/配信木共通) */
        linkHealth,
        relayFrame,
        relayVideoUrl,
        relayAudioUrl,
        getRelayStats,
        /** M5 E2E用: 指定ミリ秒、リレー着信を握りつぶして親停滞を再現する */
        debugStallRelay: (ms: number) => { relaySuppressUntilRef.current = Date.now() + ms; console.log(`[M5] debugStallRelay: 着信を${ms}ms間握りつぶします (ref=${relaySuppressUntilRef.current})`); },

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

        // リモート操作 (F-022 / issue#8)
        remoteControlAllowed,
        setRemoteControlAllowed,
        grantRemoteControl,
        revokeRemoteControl,
        controlGrants,
        controlTtlOptions: CONTROL_TTL_OPTIONS,
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
