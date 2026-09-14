/**
 * リレーチャンク署名の単体テスト (M3, 配信木計画書 §3.5)
 * 実行: node --import tsx --test --test-force-exit test/relaySign.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateRelayKeyPair, signChunk, verifyChunk, chunkDataFromB64, b64encode, b64decode,
    keyFingerprint, acceptKeyCandidate,
} from '../src/lib/relaySign.js';

test('正しい鍵で署名したチャンクは検証に通る', () => {
    const keys = generateRelayKeyPair();
    const data = chunkDataFromB64(b64encode(new Uint8Array([1, 2, 3, 4, 5])));
    const sig = signChunk(keys.secretKeyB64, 7, 1234567890, data);
    assert.ok(verifyChunk(keys.publicKeyB64, 7, 1234567890, data, sig));
});

test('データ改ざんは検知される', () => {
    const keys = generateRelayKeyPair();
    const data = new Uint8Array([9, 9, 9]);
    const sig = signChunk(keys.secretKeyB64, 1, 1, data);
    const tampered = new Uint8Array([8, 9, 9]);
    assert.equal(verifyChunk(keys.publicKeyB64, 1, 1, tampered, sig), false);
});

test('別鍵での署名 (なりすまし) は検知される', () => {
    const real = generateRelayKeyPair();
    const fake = generateRelayKeyPair();
    const data = new Uint8Array([1, 1]);
    const sig = signChunk(fake.secretKeyB64, 1, 1, data);
    assert.equal(verifyChunk(real.publicKeyB64, 1, 1, data, sig), false);
});

test('リプレイ (seq/tsの付け替え) は検知される', () => {
    const keys = generateRelayKeyPair();
    const data = new Uint8Array([5, 5]);
    const sig = signChunk(keys.secretKeyB64, 10, 100, data);
    assert.equal(verifyChunk(keys.publicKeyB64, 11, 100, data, sig), false); // seq差し替え
    assert.equal(verifyChunk(keys.publicKeyB64, 10, 200, data, sig), false); // ts差し替え
});

test('不正なbase64・長さ不一致でも例外ではなくfalse', () => {
    const keys = generateRelayKeyPair();
    const data = new Uint8Array([1]);
    assert.equal(verifyChunk(keys.publicKeyB64, 1, 1, data, 'not-base64!!'), false);
    assert.equal(verifyChunk(keys.publicKeyB64, 1, 1, data, b64encode(new Uint8Array(4))), false);
    assert.equal(verifyChunk('aG9nZQ==', 1, 1, data, b64encode(new Uint8Array(64))), false);
});

test('base64往復でバイト一致', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const round = b64decode(b64encode(bytes));
    assert.deepEqual([...round], [...bytes]);
});

// === issue#11: 全形式JPEG/frameへの署名適用 + 鍵pin-first・指紋照合ポリシー ===

test('JPEG frame (relay:frame) も同じ鍵と検証で守れる', () => {
    const keys = generateRelayKeyPair();
    // 実際のJPEGフレーム相当 (数十KB) を検証
    const jpeg = new Uint8Array(40_000).map((_, i) => (i * 7 + 3) % 256);
    const sig = signChunk(keys.secretKeyB64, 1, 1000, jpeg);
    assert.equal(verifyChunk(keys.publicKeyB64, 1, 1000, jpeg, sig), true, '正規フレームは通る');
    // 1バイト改ざんされたJPEG
    const tampered = jpeg.slice();
    tampered[12345] ^= 0xff;
    assert.equal(verifyChunk(keys.publicKeyB64, 1, 1000, tampered, sig), false, '改ざんJPEGは破棄判定');
});

test('acceptKeyCandidate: pin-first — 差し替え要求は拒否、初回だけ受理', () => {
    const real = generateRelayKeyPair();
    const attacker = generateRelayKeyPair();
    assert.deepEqual(acceptKeyCandidate(null, null, real.publicKeyB64), { accept: true });
    // pin済みの後から攻撃者の鍵へ差し替え → 拒否
    assert.deepEqual(acceptKeyCandidate(null, real.publicKeyB64, attacker.publicKeyB64),
        { accept: false, reason: 'already-pinned' });
    // pin済みに同一鍵が再送 (中継者のキャッシュ再配布など) → 受理しないが無害
    assert.deepEqual(acceptKeyCandidate(null, real.publicKeyB64, real.publicKeyB64),
        { accept: false, reason: 'same-as-pinned' });
});

test('acceptKeyCandidate: 招待の指紋と不一致の鍵は初回でも拒否 (先出し偽鍵対策)', () => {
    const real = generateRelayKeyPair();
    const attacker = generateRelayKeyPair();
    const fp = keyFingerprint(real.publicKeyB64);
    // 攻撃者がホストより先に偽鍵を送っても、fpが一致しないので受理されない
    assert.deepEqual(acceptKeyCandidate(fp, null, attacker.publicKeyB64),
        { accept: false, reason: 'fingerprint-mismatch' });
    assert.deepEqual(acceptKeyCandidate(fp, null, real.publicKeyB64), { accept: true });
});

test('acceptKeyCandidate: pin済み + 指紋設定の組み合わせ', () => {
    const real = generateRelayKeyPair();
    const other = generateRelayKeyPair();
    const fp = keyFingerprint(real.publicKeyB64);
    // pinがrealだが、招待fpがother鍵のもの (ルーム再入場など非整合) → 何を送っても受理されない
    assert.equal(acceptKeyCandidate(keyFingerprint(other.publicKeyB64), real.publicKeyB64, real.publicKeyB64).accept, false);
    assert.equal(acceptKeyCandidate(fp, real.publicKeyB64, real.publicKeyB64).accept, false);
    // fp未設定でpin済み → 差し替えは拒否
    assert.equal(acceptKeyCandidate(null, real.publicKeyB64, other.publicKeyB64).accept, false);
});
