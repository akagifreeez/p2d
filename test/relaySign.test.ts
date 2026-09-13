/**
 * リレーチャンク署名の単体テスト (M3, 配信木計画書 §3.5)
 * 実行: node --import tsx --test --test-force-exit test/relaySign.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateRelayKeyPair, signChunk, verifyChunk, chunkDataFromB64, b64encode, b64decode,
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
