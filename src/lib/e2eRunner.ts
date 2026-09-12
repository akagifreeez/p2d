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

export interface E2eConfig {
    enabled: boolean;
    role: string | null;
    syncPath: string | null;
    logPath: string | null;
    room: string | null;
    signalingUrl: string | null;
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
            if (!twoPeers) throw new Error('guest did not join');
            await sleep(2500); // DataChannel開通待ち

            // 3. 画面共有 (最初のモニター)
            const sources = await invoke<{ id: string; name: string; is_monitor: boolean }[]>('get_capture_sources');
            const monitor = sources.find(s => s.is_monitor);
            if (!monitor) throw new Error('no monitor source');
            await deps.startCustomScreenShare(monitor.id, true);
            await sleep(3000);
            const vOut0 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'video');
            await sleep(3000);
            const vOut1 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'video');
            step('screen_share_sending', vOut1 > vOut0, { videoBytesDelta: vOut1 - vOut0 });

            // 4. リモート操作を許可
            deps.setRemoteControlAllowed(true);
            await sleep(1000);
            step('remote_control_allowed', true, { allowed: true });

            // 5. システム音声
            await deps.startSystemAudio();
            const aOut0 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'audio');
            await sleep(4000);
            const aOut1 = bytesSum(await deps.getPeerStats(), 'outbound-rtp', 'audio');
            step('system_audio_sending', aOut1 > aOut0, { audioBytesDelta: aOut1 - aOut0 });

            // 6. チャット送信 & ゲストからの受信
            deps.sendChatMessage('E2E-ping-from-host');
            const gotGuestChat = await waitFor(
                () => deps.chatMessages.some(m => m.content.includes('E2E-ping-from-guest')),
                15000, 'guest chat'
            );
            step('chat_roundtrip', gotGuestChat, { received: deps.chatMessages.length });

            // 後片付け
            await deps.stopSystemAudio();
            deps.stopScreenShare();
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

            // 2. 参加
            await deps.joinRoom(code, 'E2E-Guest');
            const twoPeers = await waitFor(() => deps.participants.size >= 1, 30000, 'host discover');
            step('joined_room', twoPeers, { participants: deps.participants.size });
            if (!twoPeers) throw new Error('could not join');

            // 3. ホスト映像の受信
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

            // 4. リモート操作許可バッジ (control:remote_allowed 受信)
            const ctrlAllowed = await waitFor(
                () => [...deps.peerControlAllowed.values()].some(v => v === true),
                20000, 'CTRL badge'
            );
            step('remote_control_badge', ctrlAllowed, { peerControlAllowed: [...deps.peerControlAllowed.values()] });

            // 5. ホストのシステム音声受信
            let audioDelta = 0;
            for (let i = 0; i < 10 && audioDelta <= 0; i++) {
                const a0 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'audio');
                await sleep(4000);
                const a1 = bytesSum(await deps.getPeerStats(), 'inbound-rtp', 'audio');
                audioDelta = a1 - a0;
            }
            step('system_audio_receiving', audioDelta > 0, { audioBytesDelta: audioDelta });

            // 6. チャット往復
            deps.sendChatMessage('E2E-ping-from-guest');
            const gotHostChat = await waitFor(
                () => deps.chatMessages.some(m => m.content.includes('E2E-ping-from-host')),
                15000, 'host chat'
            );
            step('chat_roundtrip', gotHostChat, { received: deps.chatMessages.length });
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
