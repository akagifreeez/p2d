/**
 * シグナリングサーバー統合テスト (実サーバーを子プロセスで起動)
 * 監査#1: 部屋外からの peer:offer / relay:* 中継が拒否されること
 * 監査#4: ルーム移動時に移動元へ peer:left が通知されること
 * 監査#6: 上限超過の join が ROOM_FULL エラーで拒否されること
 * 実行: node --import tsx --test test/signaling.integration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Msg = { type: string; senderId?: string; targetId?: string; payload?: Record<string, unknown> };

class TestClient {
    readonly ws: WebSocket;
    myId = '';
    readonly messages: Msg[] = [];
    private readonly opened: Promise<void>;

    constructor(private readonly url: string) {
        this.ws = new WebSocket(url);
        this.opened = new Promise<void>((resolve, reject) => {
            this.ws.once('open', () => resolve());
            this.ws.once('error', reject);
        });
        this.ws.on('message', (data: Buffer) => {
            const m = JSON.parse(data.toString()) as Msg;
            this.messages.push(m);
            const myId = m.payload?.myId;
            if (m.type === 'room:joined' && typeof myId === 'string' && !this.myId) {
                this.myId = myId;
            }
        });
    }

    async connect(): Promise<void> {
        await this.opened;
        await this.waitFor(m => m.type === 'room:joined'); // 接続確認 (ダミーroom:joined)
    }

    send(type: string, payload?: unknown, targetId?: string): void {
        this.ws.send(JSON.stringify({ type, payload, targetId, timestamp: Date.now() }));
    }

    /** 実際のルーム参加完了を待つ (roomIdが空でない = 接続確認ダミーではない) */
    async waitJoined(): Promise<Msg> {
        return this.waitFor(m => m.type === 'room:joined' && typeof m.payload?.roomId === 'string' && m.payload.roomId !== '');
    }

    async waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
        const found = this.messages.find(pred);
        if (found) return found;
        return new Promise((resolve, reject) => {
            const onMsg = (data: Buffer) => {
                const m = JSON.parse(data.toString()) as Msg;
                if (pred(m)) {
                    cleanup();
                    resolve(m);
                }
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`waitFor timeout: types=[${this.messages.map(m => m.type).join(',')}] readyState=${this.ws.readyState} url=${this.url}`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                this.ws.off('message', onMsg);
            };
            this.ws.on('message', onMsg);
        });
    }

    /** ms間待ってもpredに一致するメッセージが届かないこと (監査#1の中継拒否の確認) */
    async expectSilence(pred: (m: Msg) => boolean, ms = 700): Promise<void> {
        await new Promise(r => setTimeout(r, ms));
        const hit = this.messages.find(pred);
        assert.ok(!hit, `届くべきでないメッセージを受信: ${JSON.stringify(hit)}`);
    }

    close(): void {
        this.ws.close();
    }
}

function startServer(extraEnv: Record<string, string> = {}): { proc: ChildProcess; port: number } {
    const p = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, PORT: String(p), ...extraEnv },
        // stdoutを握りつぶすとWindowsで子プロセスの書き込みが詰まり、
        // ソケット応答ごと止まって見えることがあるため必ずpipeで拾う
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', () => { }); // ドレインのみ (子プロセスの書き込みが詰まらないように)
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server:${p}] ${d}`));
    return { proc, port: p };
}

async function waitListening(p: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>(resolve => {
            const s = net.connect(p, '127.0.0.1');
            s.once('connect', () => { s.destroy(); resolve(true); });
            s.once('error', () => resolve(false));
        });
        if (ok) return;
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`server did not start on :${p}`);
}

test('部屋外からのoffer/relay中継は拒否され、同一ルーム内は転送される (#1)', async (t) => {
    const started = startServer();
    t.after(() => started.proc.kill());
    await waitListening(started.port);
    const url = `ws://127.0.0.1:${started.port}`;
    const c1 = new TestClient(url);
    const c2 = new TestClient(url);
    const c3 = new TestClient(url);
    await Promise.all([c1.connect(), c2.connect(), c3.connect()]);

    try {
        // 3人ともroom1に参加 (この時点でc3はc1/c2のIDを知りうる = 攻撃の前提)
        c1.send('room:create', {});
        const created = await c1.waitFor(m => m.type === 'room:created');
        const code = String(created.payload?.roomCode);
        c2.send('room:join', { roomCode: code });
        c3.send('room:join', { roomCode: code });
        await Promise.all([c2.waitJoined(), c3.waitJoined()]);

        // c3だけ別ルームを作って移動 → c1/c2にはc3の退出が届く (#4)
        c3.send('room:create', {});
        await c3.waitFor(m => m.type === 'room:created');
        await c1.waitFor(m => m.type === 'peer:left' && m.payload?.peerId === c3.myId);
        await c2.waitFor(m => m.type === 'peer:left' && m.payload?.peerId === c3.myId);

        // 攻撃: 部屋外 (room2) から既知のIDへoffer + relay → 届かない
        c3.send('peer:offer', { sdp: { type: 'offer', sdp: 'v=0...' } }, c1.myId);
        c3.send('peer:ice', { candidate: { candidate: 'dummy' } }, c1.myId);
        c3.send('relay:chat', { id: 'evil' }, c1.myId);
        await c1.expectSilence(m => m.type === 'peer:offer' || m.type === 'peer:ice' || m.type === 'relay:chat');

        // 未所属 (room:leave済み) からの送信も届かない
        c3.send('room:leave');
        await new Promise(r => setTimeout(r, 100));
        c3.send('peer:offer', { sdp: { type: 'offer', sdp: 'v=0...' } }, c2.myId);
        await c2.expectSilence(m => m.type === 'peer:offer' && m.senderId === c3.myId);

        // positive control: 同一ルーム内のc1→c2は正常に転送される
        c1.send('peer:offer', { sdp: { type: 'offer', sdp: 'v=0...' } }, c2.myId);
        const fwd = await c2.waitFor(m => m.type === 'peer:offer' && m.senderId === c1.myId);
        assert.equal(fwd.targetId, c2.myId);
    } finally {
        [c1, c2, c3].forEach(c => c.close());
    }
});

test('上限超過のjoinはROOM_FULLエラーになる (#6)', async (t) => {
    const started = startServer({ P2D_MAX_PARTICIPANTS: '2' });
    t.after(() => started.proc.kill());
    await waitListening(started.port);

    const url = `ws://127.0.0.1:${started.port}`;
    const c1 = new TestClient(url);
    const c2 = new TestClient(url);
    const c3 = new TestClient(url);
    await Promise.all([c1.connect(), c2.connect(), c3.connect()]);

    try {
        c1.send('room:create', {});
        const created = await c1.waitFor(m => m.type === 'room:created');
        const code = String(created.payload?.roomCode);
        c2.send('room:join', { roomCode: code });
        await c2.waitJoined();

        c3.send('room:join', { roomCode: code });
        const err = await c3.waitFor(m => m.type === 'error');
        assert.equal(err.payload?.code, 'ROOM_FULL');
    } finally {
        [c1, c2, c3].forEach(c => c.close());
    }
});

// === issue#9/#10: hostToken認可モデルの実サーバー検証 ===

test('既存ルームへの無認可 room:create は拒否され、参加者リスト・peer:joined・電話帳に載らない (#9)', async (t) => {
    const started = startServer();
    t.after(() => started.proc.kill());
    await waitListening(started.port);
    const url = `ws://127.0.0.1:${started.port}`;
    const host = new TestClient(url);
    const guest = new TestClient(url);
    const stranger = new TestClient(url);
    await Promise.all([host.connect(), guest.connect(), stranger.connect()]);

    try {
        host.send('room:create', { roomCode: 'AUTH99', hostEndpoint: '10.0.0.1:8090' });
        const created = await host.waitFor(m => m.type === 'room:created');
        assert.equal(created.payload?.roomCode, 'AUTH99');
        assert.ok(created.payload?.hostToken, 'created応答にhostTokenが載る');
        assert.equal(created.payload?.hostId, host.myId);

        guest.send('room:join', { roomCode: 'AUTH99' });
        const joined = await guest.waitJoined();
        assert.equal(joined.payload?.hostId, host.myId);

        // ホストの既存コードでの無認可create → UNAUTHORIZED (トークン無しでは
        // 再権限できない。 telephone帳 (hostEndpoint) の書き換えも起こらない)
        stranger.send('room:create', { roomCode: 'AUTH99', hostEndpoint: 'evil.example:1234' });
        const err = await stranger.waitFor(m => m.type === 'error');
        assert.equal(err.payload?.code, 'UNAUTHORIZED');

        // strangerは参加者に載らず、guestにもpeer:joinedが届かない
        await guest.expectSilence(m => m.type === 'peer:joined' && m.payload?.peerId === stranger.myId);
        stranger.send('room:join', { roomCode: 'AUTH99' });
        const sj = await stranger.waitFor(m => m.type === 'room:joined' && m.payload?.roomId !== '');
        const parts = (sj.payload?.participants as { id: string }[]).map(p => p.id);
        assert.ok(!parts.includes(stranger.myId));
        // 電話帳は書き換わっていない
        assert.equal(sj.payload?.hostEndpoint, '10.0.0.1:8090');
    } finally {
        [host, guest, stranger].forEach(c => c.close());
    }
});

test('正しいhostTokenでの room:create はホスト再権限として受理される (#9/#10)', async (t) => {
    const started = startServer();
    t.after(() => started.proc.kill());
    await waitListening(started.port);
    const url = `ws://127.0.0.1:${started.port}`;
    const host = new TestClient(url);
    const guest = new TestClient(url);
    await Promise.all([host.connect(), guest.connect()]);

    try {
        host.send('room:create', { roomCode: 'RECL01', hostEndpoint: '10.0.0.1:8090' });
        const created = await host.waitFor(m => m.type === 'room:created');
        const token = String(created.payload?.hostToken);
        guest.send('room:join', { roomCode: 'RECL01' });
        await guest.waitJoined();

        // ホストのWSが切れる (切断後もゲストは部屋に残留)
        const oldHostId = host.myId;
        host.close();
        await new Promise(r => setTimeout(r, 300));

        // 別IDで再接続し、token提示で再権限
        const host2 = new TestClient(url);
        await host2.connect();
        host2.send('room:create', { roomCode: 'RECL01', hostToken: token, hostEndpoint: '10.0.0.9:8090' });
        const created2 = await host2.waitFor(m => m.type === 'room:created');
        assert.equal(created2.payload?.hostId, host2.myId);
        assert.equal(created2.payload?.hostToken, token);

        // 在席のguestへは room:host で新しいホストIDが配られる
        const hostChanged = await guest.waitFor(m => m.type === 'room:host');
        assert.equal(hostChanged.payload?.hostId, host2.myId);
        assert.notEqual(host2.myId, oldHostId);
        host2.close();
    } finally {
        guest.close();
    }
});
