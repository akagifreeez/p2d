/**
 * P2D シグナリングサーバー E2Eテスト (実走検証用・一時ファイル)
 * 実際に ws://127.0.0.1:8080 に接続し、アプリが使う全メッセージ経路を検証する
 */
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:8080';
let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name}`); }
}

function connect(name) {
    const ws = new WebSocket(URL);
    const client = { name, ws, messages: [], waiters: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        const idx = client.waiters.findIndex(w => w.type === msg.type);
        if (idx >= 0) {
            const w = client.waiters.splice(idx, 1)[0];
            clearTimeout(w.timer);
            w.resolve(msg);
        } else {
            client.messages.push(msg);
        }
    });
    return new Promise((resolve, reject) => {
        ws.on('open', () => resolve(client));
        ws.on('error', reject);
    });
}

function waitFor(client, type, timeout = 4000) {
    const idx = client.messages.findIndex(m => m.type === type);
    if (idx >= 0) return Promise.resolve(client.messages.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const i = client.waiters.findIndex(w => w.type === type);
            if (i >= 0) client.waiters.splice(i, 1);
            reject(new Error(`timeout: ${client.name} waiting ${type}`));
        }, timeout);
        client.waiters.push({ type, resolve, timer });
    });
}

// 1. Host が接続 → 接続確認メッセージ(myId付与)
const A = await connect('Host');
const connA = await waitFor(A, 'room:joined');
check('Host 接続確認 (myId付与)', typeof connA.payload?.myId === 'string' && connA.payload.myId.length > 0);
const hostId = connA.payload.myId;

// 2. ルーム作成 → room:created + room:joined
A.send({ type: 'room:create', timestamp: Date.now(), payload: { name: 'Host' } });
const created = await waitFor(A, 'room:created');
check('room:created 応答 (6文字コード・紛らわしい文字除外)', /^[A-HJ-NP-Z2-9]{6}$/.test(String(created.payload?.roomCode || '')));
const joinedA = await waitFor(A, 'room:joined');
check('Host room:joined (作成直後は参加者0)', joinedA.payload?.roomCode === created.payload.roomCode && joinedA.payload?.participants?.length === 0);
const roomCode = created.payload.roomCode;

// 3. Guest が参加 → guest は既存参加者1人、host に peer:joined 通知
const B = await connect('Guest');
await waitFor(B, 'room:joined'); // 接続確認
B.send({ type: 'room:join', timestamp: Date.now(), payload: { roomCode, name: 'Guest' } });
const joinedB = await waitFor(B, 'room:joined');
check('Guest room:joined (既存参加者1人=Host)', joinedB.payload?.participants?.length === 1 && joinedB.payload.participants[0].name === 'Host');
const guestId = joinedB.payload.myId;
const peerJoined = await waitFor(A, 'peer:joined');
check('Host が peer:joined 受信 (Guest)', peerJoined.payload?.peerId === guestId && peerJoined.payload?.name === 'Guest');

// 4. Offer 中継 Host -> Guest
A.send({ type: 'peer:offer', targetId: guestId, timestamp: Date.now(), payload: { sdp: { type: 'offer', sdp: 'v=0 test-offer' } } });
const offer = await waitFor(B, 'peer:offer');
check('Guest が Host の peer:offer 受信 (senderId付き)', offer.senderId === hostId && offer.payload?.sdp?.sdp === 'v=0 test-offer');

// 5. Answer 中継 Guest -> Host
B.send({ type: 'peer:answer', targetId: hostId, timestamp: Date.now(), payload: { sdp: { type: 'answer', sdp: 'v=0 test-answer' } } });
const answer = await waitFor(A, 'peer:answer');
check('Host が Guest の peer:answer 受信', answer.senderId === guestId && answer.payload?.sdp?.type === 'answer');

// 6. ICE 中継 Guest -> Host
B.send({ type: 'peer:ice', targetId: hostId, timestamp: Date.now(), payload: { candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.2 50000 typ host' } } });
const ice = await waitFor(A, 'peer:ice');
check('Host が Guest の peer:ice 受信', !!ice.payload?.candidate?.candidate && ice.senderId === guestId);

// 7. Guest 切断 → Host に peer:left
B.ws.close();
const left = await waitFor(A, 'peer:left');
check('Host が peer:left 受信 (Guest切断)', left.payload?.peerId === guestId);

// 8. 誤コード参加 → error (ROOM_NOT_FOUND)
const C = await connect('Intruder');
await waitFor(C, 'room:joined');
C.send({ type: 'room:join', timestamp: Date.now(), payload: { roomCode: '999999', name: 'X' } });
const err = await waitFor(C, 'error');
check('誤コード参加で error (ROOM_NOT_FOUND)', err.payload?.code === 'ROOM_NOT_FOUND');

A.ws.close(); C.ws.close();
console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
