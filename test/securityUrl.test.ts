/**
 * 平文URL検出テスト (issue#3 / 監査#3)
 * 実行: node --import tsx --test --test-force-exit test/securityUrl.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaintextUrlWarning, isLocalOrPrivateHost } from '../src/lib/securityUrl.js';

test('wss:// と turns:// は常にnull (暗号化済み)', () => {
    assert.equal(plaintextUrlWarning('wss://p2d.example.com'), null);
    assert.equal(plaintextUrlWarning('turns:p2d.example.com:5349?transport=tcp'), null);
    // 公開アドレスでも暗号化されていれば警告しない
    assert.equal(plaintextUrlWarning('wss://8.8.8.8:443'), null);
    assert.equal(plaintextUrlWarning('turns:8.8.8.8:5349'), null);
});

test('ws:// 公開ホストは警告、ローカル/プライベートはnull', () => {
    assert.match(plaintextUrlWarning('ws://p2d.example.com')!, /^このシグナリングURL/);
    assert.match(plaintextUrlWarning('ws://8.8.8.8:8080')!, /^このシグナリングURL/);
    assert.equal(plaintextUrlWarning('ws://localhost:8080'), null);
    assert.equal(plaintextUrlWarning('ws://127.0.0.1:8080'), null);
    assert.equal(plaintextUrlWarning('ws://192.168.11.4:8080'), null);
    assert.equal(plaintextUrlWarning('ws://10.0.0.5:8080'), null);
    assert.equal(plaintextUrlWarning('ws://p2d-host.local:8080'), null);
    // Tailscale CGNAT帯 (100.64/10)
    assert.equal(plaintextUrlWarning('ws://100.80.3.0:8080'), null);
    // 172.16.0.0/12 の境界 (16-31)
    assert.equal(plaintextUrlWarning('ws://172.16.0.1:8080'), null);
    assert.equal(plaintextUrlWarning('ws://172.31.255.255:8080'), null);
    assert.match(plaintextUrlWarning('ws://172.32.0.1:8080')!, /^このシグナリングURL/);
    assert.match(plaintextUrlWarning('ws://172.15.0.1:8080')!, /^このシグナリングURL/);
});

test('turn:// 公開ホストは警告、ローカル/プライベートはnull', () => {
    assert.match(plaintextUrlWarning('turn:p2d.example.com:3478')!, /^このTURN URL/);
    assert.match(plaintextUrlWarning('turn:8.8.8.8:3478?transport=udp')!, /^このTURN URL/);
    assert.equal(plaintextUrlWarning('turn:192.168.1.20:3478'), null);
    assert.equal(plaintextUrlWarning('turn:127.0.0.1:3478'), null);
});

test('空・未知スキームはnull', () => {
    assert.equal(plaintextUrlWarning(''), null);
    assert.equal(plaintextUrlWarning('   '), null);
    assert.equal(plaintextUrlWarning('https://example.com'), null);
    assert.equal(plaintextUrlWarning('just a code'), null);
});

test('isLocalOrPrivateHost: ブラケット付きIPv6・大文字小文字を正規化', () => {
    assert.equal(isLocalOrPrivateHost('[::1]'), true);
    assert.equal(isLocalOrPrivateHost('LOCALHOST'), true);
    assert.equal(isLocalOrPrivateHost('example.com'), false);
});
