/**
 * P2D - E2E自己テストランナー
 *
 * P2D_E2E_ROLE 環境変数が設定された起動でのみ動く自動テスト。
 * host: ルーム作成 → 画面共有 → リモート操作許可 → システム音声 → チャット
 * guest: 同期ファイルからコード取得 → 参加 → 映像/音声/バッジ/チャットを受信検証
 *
 * 結果は P2D_E2E_LOG にJSONとして随時上書きされる。
 * 検証はDOMに依存せず WebRTC統計 (getStats) とフックの状態で行うため、
 * ウィンドウがバックグラウンドでも完結する。
 */
import { invoke } from '@tauri-apps/api/core';
import { detectRelayCapabilities } from './relayEncoder';

export interface E2eConfig {
    enabled: boolean;
    role: string | null;
    syncPath: string | null;
    logPath: string | null;
    room: string | null;
    signalingUrl: string | null;
    stay: string | null;
    /** 配信木テスト: WebRTC対応でもWSリレーモードへ強制 */
    forceRelay: boolean;
    /** 配信木コーディネータのホスト直結上限 */
    treeFanout: number | null;
}

export interface E2eDeps {
    createRoom: (name?: string) => Promise<void>;
    joinRoom: (code: string, name?: string) => Promise<void>;
    roomCode: string | null;
    myId: string | null;
    participants: Map<string, unknown>; // runnerではsizeのみ使用
    remoteStreams: Map<string, MediaStream>;
    chatMessages: { content: string; senderName?: string }[];
    peerControlAllowed: Map<string, boolean>;
    startCustomScreenShare: (sourceId: string, isMonitor: boolean) => Promise<void>;
    stopScreenShare: () => void;
    setRemoteControlAllowed: (allowed: boolean) => void;
    startSystemAudio: () => Promise<void>;
    stopSystemAudio: () => Promise<void>;
    sendChatMessage: (text: string) => void;
    getPeerStats: () => Promise<{ peerId: string; type: string; kind: string; bytes: number }[]>;
    // WSリレーモード (WebRTC非対応エンジン向けフォールバック)
    isRelayMode: boolean;
    getRelayStats: () => {
        frames: number; bytes: number; lastFrameAt: number; h264Chunks: number; audioChunks: number;
        subscribers: number; mseSubscribers: number; audioSubscribers: number;
        sigVerified: number; sigInvalid: number;
        inputsApplied: number; inputsRejected: number;
    };
    // issue#8: 視聴者ごとのリモート操作許可 (peer単位+期限付き)
    sendInputToPeer: (peerId: string, type: string, payload: unknown) => void;
    grantRemoteControl: (peerId: string, ttlMs?: number) => void;
    revokeRemoteControl: (peerId: string) => void;
    // M5§7: 親停滞の故障注入とウォッチドッグ回復の検証
    debugStallRelay: (ms: number) => void;
    // レンデブー最小化 (M1): 名簿ゴシップのエントリ一覧 (収束検証)
    getRoster: () => { id: string }[];
    // 配信木 (M2/M3): 自ノードの状態
    getTreeInfo: () => {
        role: 'none' | 'host' | 'relay';
        children: string[];
        addr: { host: string; port: number } | null;
        parent: string | null;
    };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(300);
    }
    console.error(`[E2E] timeout: ${label}`);
    return false;
}

function bytesSum(rows: { type: string; kind: string; bytes: number }[], type: string, kind: string): number {
    return rows.filter(r => r.type === type && r.kind === kind).reduce((s, r) => s + r.bytes, 0);
}

export async function runE2E(cfg: E2eConfig, deps: E2eDeps): Promise<void> {
    // console をアプリの stdout へ中継 (リリースビルドでもデバッグ可能にする)
    const relay = (level: string) => (...args: unknown[]) => {
        try {
            invoke('e2e_stdout', { line: `[${level}] ${args.map(a => JSON.stringify(a)).join(' ')}` }).catch(() => { });
        } catch { /* noop */ }
    };
    console.log = relay('log');
    console.error = relay('error');
    console.warn = relay('warn');
    window.addEventListener('unhandledrejection', (ev) => {
        try {
            invoke('e2e_stdout', { line: `[unhandledrejection] ${String(ev.reason)}` }).catch(() => { });
        } catch { /* noop */ }
    });

    // Windows絶対パスのバックスラッシュがIPC経由で問題を起こす可能性があるため相対パス化
    const safePath = (p: string | null) => (p ? p.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/') : null);

    const report: Record<string, unknown> = { role: cfg.role, startedAt: new Date().toISOString(), steps: {} };
    const flush = () => {
        const p = safePath(cfg.logPath);
        if (!p) return;
        console.log(`[E2E] flush invoking: ${p}`);
        try {
            let json: string;
            try {
                json = JSON.stringify(report, null, 2);
            } catch (se) {
                console.error(`[E2E] stringify failed: ${String(se)}`);
                json = JSON.stringify({ error: 'stringify failed', role: cfg.role });
            }
            invoke('e2e_file_write', { path: p, content: json })
                .then(() => console.log(`[E2E] report flushed to ${p}`))
                .catch(e => console.error('flush invoke rejected:', String(e)));
        } catch (syncErr) {
            console.error(`[E2E] flush SYNC THROW: ${String(syncErr)}`);
        }
    };
    console.log('runE2E started:', JSON.stringify(cfg));
    flush(); // 起動時点のレポートを即座に書き出す
    const step = (name: string, ok: boolean, detail: unknown) => {
        (report.steps as Record<string, unknown>)[name] = { ok, detail };
        report.finishedAt = new Date().toISOString();
        console.log(`[E2E] ${ok ? 'OK' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
        flush();
    };
    const syncWrite = (content: string) => {
        const p = safePath(cfg.syncPath);
        if (!p) return Promise.resolve();
        console.log(`[E2E] syncWrite -> ${p}`);
        return invoke('e2e_file_write', { path: p, content })
            .then(() => console.log('[E2E] syncWrite ok'))
            .catch(e => console.error('syncWrite failed:', String(e)));
    };
    const syncRead = () => {
        const p = safePath(cfg.syncPath);
        if (!p) return Promise.resolve('');
        return invoke<string>('e2e_file_read', { path: p }).catch(() => '');
    };

    try {
        if (cfg.role === 'host') {
            // 1. ルーム作成
            await deps.createRoom('E2E-Host');
            const gotCode = await waitFor(() => deps.roomCode !== null, 15000, 'roomCode');
            step('create_room', gotCode && !!deps.roomCode, { roomCode: deps.roomCode });
            if (!gotCode || !deps.roomCode) throw new Error('roomCode not issued');
            await syncWrite(deps.roomCode);

            // 2. ゲスト参加待ち
            const twoPeers = await waitFor(() => deps.participants.size >= 1, 45000, 'guest join');
            step('guest_joined', twoPeers, { participants: deps.participants.size });
            // 参加が遅れても後続の共有ステップまで進める (帯域測定では共有の開始自体が重要)
            if (!twoPeers) {
                const latePeers = await waitFor(() => deps.participants.size >= 1, 120000, 'guest join (late)');
                step('guest_joined_late', latePeers, { participants: deps.participants.size });
            }
            await sleep(2500); // DataChannel開通待ち

            // M1: 名簿ゴシップの収束 (自分 + 全参加者が名簿に載る)
            const rosterOk = await waitFor(
                () => deps.getRoster().length >= deps.participants.size + 1,
                10000, 'roster convergence'
            );
            step('roster_sync', rosterOk, { roster: deps.getRoster().map(r => r.id), participants: deps.participants.size });

            // 3. 画面共有 (最初のモニター)
            const sources = await invoke<{ id: string; name: string; is_monitor: boolean }[]>('get_capture_sources');
            const monitor = sources.find(s => s.is_monitor);
            if (!monitor) throw new Error('no monitor source');
            await deps.startCustomScreenShare(monitor.id, true);
            await sleep(3000);
            const relay0 = deps.getRelayStats();
            const vOut0 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'video');
            await sleep(3000);
            const relay1 = deps.getRelayStats();
            const vOut1 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'video');
            // リレー視聴者 (Linux等) にはPC統計が無いのでリレーチャンク増加で判定
            const relayDelta = (relay1.h264Chunks + relay1.frames) - (relay0.h264Chunks + relay0.frames);
            step('screen_share_sending', vOut1 > vOut0 || relayDelta > 0,
                { videoBytesDelta: vOut1 - vOut0, relayChunksDelta: relayDelta });

            // 4. リモート操作を許可
            deps.setRemoteControlAllowed(true);
            await sleep(1000);
            step('remote_control_allowed', true, { allowed: true });

            // 5. システム音声
            await deps.startSystemAudio();
            const relayA0 = deps.getRelayStats();
            const aOut0 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'audio');
            await sleep(4000);
            const relayA1 = deps.getRelayStats();
            const aOut1 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'audio');
            const relayAudioDelta = relayA1.audioChunks - relayA0.audioChunks;
            step('system_audio_sending', aOut1 > aOut0 || relayAudioDelta > 0,
                { audioBytesDelta: aOut1 - aOut0, relayAudioChunksDelta: relayAudioDelta });

            // 6. チャット送信 & ゲストからの受信
            deps.sendChatMessage('E2E-ping-from-host');
            const gotGuestChat = await waitFor(
                () => deps.chatMessages.some(m => m.content.includes('E2E-ping-from-guest')),
                15000, 'guest chat'
            );
            step('chat_roundtrip', gotGuestChat, { received: deps.chatMessages.length });

            // issue#8: 視聴者ごとの許可 + 期限切れの実走検証。
            // ゲストはこの間ずっと入力を送り続けている (control_input_stream):
            //   取り消し中は拒否 → 3秒TTLで再許可中は適用 → 期限切れ後は再び拒否
            const guestId = [...deps.participants.keys()].find(id => id !== deps.myId) || '';
            if (guestId) {
                const stats = () => deps.getRelayStats();
                const statsT = () => ({ ...stats(), t: Date.now() });
                const c0 = statsT();
                deps.revokeRemoteControl(guestId);
                await sleep(2000);
                const c1 = statsT(); // 取り消し中: rejected が増える
                deps.grantRemoteControl(guestId, 3000); // T=許可時刻、T+3sで期限
                await sleep(1200);
                const c2 = statsT(); // T+1.2s 許可中: applied が増える
                await sleep(2600);
                const c2b = statsT(); // T+3.8s 期限 (T+3s) を確実にまたいだ直後のスナップショット
                await sleep(1500);
                const c3 = statsT(); // T+5.3s 期限切れ後: 再び rejected が増える
                // 注意: c2→c3の窓は期限前後をまたぐため、期限後の判定は
                // 「期限をまたいだ後に取った c2b」を基準にする (さもないと
                // 期限前の適用が混ざり grantedNotApplied===0 が壊れる)
                const revokedRejected = c1.inputsRejected - c0.inputsRejected;
                const grantedApplied = c2.inputsApplied - c1.inputsApplied;
                const expiredRejected = c3.inputsRejected - c2b.inputsRejected;
                const grantedNotApplied = c3.inputsApplied - c2b.inputsApplied;
                step('per_peer_control',
                    revokedRejected > 0 && grantedApplied > 0 && expiredRejected > 0 && grantedNotApplied === 0,
                    { revokedRejected, grantedApplied, expiredRejected, grantedNotApplied, t0: c0.t, t1: c1.t, t2: c2.t, t2b: c2b.t, t3: c3.t });
            } else {
                step('per_peer_control', false, { reason: 'no guest' });
            }

            // 配信木: 昇格/割り当ての結果 (treeFanout超過時に中継が生まれる)
            step('tree_topology', true, { tree: deps.getTreeInfo() });

            // stay時: 後から来た参加者 (サーバー死亡後の内蔵サーバー経由参加など) にも
            // チャット経路を検証できるよう、ホストのpingを定期的に再送する
            if (cfg.stay) {
                setInterval(() => deps.sendChatMessage('E2E-ping-from-host'), 5000);
            } else {
                await deps.stopSystemAudio();
                deps.stopScreenShare();
            }
        } else if (cfg.role === 'guest') {
            // 1. ルームコード取得 (直指定があればsyncファイルは不要)
            let code: string | null = cfg.room;
            if (!code) {
                for (let i = 0; i < 120; i++) {
                    const raw = (await syncRead()) as string;
                    const m = raw.trim().match(/^[A-Za-z0-9]{4,8}$/);
                    if (m) { code = m[0]; break; }
                    await sleep(500);
                }
            }
            step('read_room_code', !!code, { code, source: cfg.room ? 'arg' : 'sync-file' });
            if (!code) throw new Error('no room code from sync file');

            // 2. 参加 (ディープリンク自動参加と競合しても収束するようリトライ)
            for (let attempt = 0; attempt < 10; attempt++) {
                try {
                    await deps.joinRoom(code, 'E2E-Guest');
                    break;
                } catch (e) {
                    console.error(`[E2E] joinRoom attempt ${attempt + 1} failed:`, String(e));
                    await sleep(2000);
                }
            }
            const twoPeers = await waitFor(() => deps.participants.size >= 1, 30000, 'host discover');
            step('joined_room', twoPeers, { participants: deps.participants.size });
            if (!twoPeers) throw new Error('could not join');

            // M1: 名簿ゴシップの収束
            const rosterOk = await waitFor(
                () => deps.getRoster().length >= deps.participants.size + 1,
                10000, 'roster convergence'
            );
            step('roster_sync', rosterOk, { roster: deps.getRoster().map(r => r.id), participants: deps.participants.size });

            // 3. ホスト映像の受信
            if (deps.isRelayMode) {
                // リレーモード: フレーム/H264チャンク着信数の増加で判定。
                // デバッグビルドのエンコーダ起動は数秒かかるためポーリングする
                // (音声ステップと同じ方式)
                let relayMediaDelta = 0;
                let lastStats = deps.getRelayStats();
                for (let i = 0; i < 8 && relayMediaDelta <= 0; i++) {
                    await sleep(3000);
                    const s2 = deps.getRelayStats();
                    relayMediaDelta = (s2.frames + s2.h264Chunks) - (lastStats.frames + lastStats.h264Chunks);
                    lastStats = s2;
                }
                const finalStats = deps.getRelayStats();
                step('video_receiving', relayMediaDelta > 0,
                    { relayMediaDelta, h264Chunks: finalStats.h264Chunks, jpegFrames: finalStats.frames });
            } else {
                const hasLiveVideo = await waitFor(
                    () => [...deps.remoteStreams.values()].some(s =>
                        s.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)
                    ),
                    25000, 'host video track'
                );
                await sleep(3000);
                const vIn0 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'video');
                await sleep(3000);
                const vIn1 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'video');
                step('video_receiving', hasLiveVideo && vIn1 > vIn0, { liveTrack: hasLiveVideo, videoBytesDelta: vIn1 - vIn0 });
            }

            // 4. リモート操作許可バッジ (control:remote_allowed 受信)
            const ctrlAllowed = await waitFor(
                () => [...deps.peerControlAllowed.values()].some(v => v === true),
                20000, 'CTRL badge'
            );
            step('remote_control_badge', ctrlAllowed, { peerControlAllowed: [...deps.peerControlAllowed.values()] });

            // 5. ホストのシステム音声受信 (リレー時はwebm/opusチャンク着信で判定・非対応エンジンはスキップ)
            if (deps.isRelayMode) {
                const caps = detectRelayCapabilities();
                if (!caps.webmAudio) {
                    step('system_audio_receiving', true, { skipped: 'relay-mode: webm/opus MSE非対応' });
                } else {
                    let audioChunks = 0;
                    for (let i = 0; i < 6 && audioChunks === 0; i++) {
                        await sleep(3000);
                        audioChunks = deps.getRelayStats().audioChunks;
                    }
                    step('system_audio_receiving', audioChunks > 0, { relayAudioChunks: audioChunks });
                }
            } else {
                let audioDelta = 0;
                for (let i = 0; i < 10 && audioDelta <= 0; i++) {
                    const a0 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'audio');
                    await sleep(4000);
                    const a1 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'audio');
                    audioDelta = a1 - a0;
                }
                step('system_audio_receiving', audioDelta > 0, { audioBytesDelta: audioDelta });
            }

            // M3: リレーチャンクのEd25519署名検証 (リレーモードのみ)
            if (deps.isRelayMode) {
                const sigOk = await waitFor(() => deps.getRelayStats().sigVerified > 0, 15000, 'relay signature');
                step('signature_verification', sigOk && deps.getRelayStats().sigInvalid === 0, {
                    verified: deps.getRelayStats().sigVerified,
                    invalid: deps.getRelayStats().sigInvalid,
                });
            }

            // 6. チャット往復
            deps.sendChatMessage('E2E-ping-from-guest');
            const gotHostChat = await waitFor(
                () => deps.chatMessages.some(m => m.content.includes('E2E-ping-from-host')),
                15000, 'host chat'
            );
            step('chat_roundtrip', gotHostChat, { received: deps.chatMessages.length });

            // 7. issue#8: リモート操作入力ストリーム (無害なスクロール0/0)。
            // ホストが revoke → TTL付き許可 → 期限切れ の検証をしている間、
            // 継続的に入力を送り、適用/破棄カウンタの遷移をホスト側で判定する
            const ctrlTarget = [...deps.participants.keys()].find(id => id !== deps.myId) || '';
            if (ctrlTarget) {
                const streamStart = Date.now();
                while (Date.now() - streamStart < 15000) {
                    deps.sendInputToPeer(ctrlTarget, 'input:scroll', { deltaX: 0, deltaY: 0 });
                    await sleep(600);
                }
                step('control_input_stream', true, { target: ctrlTarget });

                // M5§7: 親停滞の故障注入 → ウォッチドッグが検知して回復するか。
                // 9秒間着信を握りつぶす (しきい値4秒 + parent_lost送信の余裕)。
                // ホストは再割当/rejoin指示を返し、メディアが再開すれば回復成功
                deps.debugStallRelay(9000);
                await sleep(9500);
                const wd0 = deps.getRelayStats();
                const recovered = await waitFor(() => {
                    const s = deps.getRelayStats();
                    return (s.frames + s.h264Chunks + s.audioChunks) - (wd0.frames + wd0.h264Chunks + wd0.audioChunks) > 0;
                }, 20000, 'watchdog recovery');
                step('watchdog_recovery', recovered, { stallMs: 9000 });
            } else {
                step('control_input_stream', false, { reason: 'no control target' });
            }
        } else {
            throw new Error(`unknown role: ${cfg.role}`);
        }
        (report as { passed: boolean }).passed =
            Object.values(report.steps as Record<string, { ok: boolean }>).every(s => s.ok);
    } catch (e) {
        (report as { passed: boolean }).passed = false;
        (report as { error: string }).error = String(e);
        flush();
    }
    flush();
}
