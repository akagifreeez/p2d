/**
 * 招待ペイロード解析テスト (M4) — Rust側 find_join_url と同じ規則
 * 実行: node --import tsx --test --test-force-exit test/invite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvite, buildInvite } from '../src/lib/invite.js';

test('従来形式: コードのみ', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123'), { code: 'ABC123', endpoint: null });
});

test('招待v2: CODE@host:port', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@192.168.11.5:8090'), {
        code: 'ABC123',
        endpoint: '192.168.11.5:8090',
    });
});

test('招待v2: クエリ付きでもendpointを取り出す', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@p2d-host.local:8090?src=qr'), {
        code: 'ABC123',
        endpoint: 'p2d-host.local:8090',
    });
});

test('壊れたendpointはnullにフォールバック (コードは生きる)', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@:8090'), { code: 'ABC123', endpoint: null });
    assert.deepEqual(parseInvite('p2d://join/ABC123@hostonly'), { code: 'ABC123', endpoint: null });
});

test('手入力コード', () => {
    assert.deepEqual(parseInvite('cwh4k6'), { code: 'CWH4K6', endpoint: null });
    assert.equal(parseInvite('abc'), null);
    assert.equal(parseInvite(''), null);
    assert.equal(parseInvite('not a code!'), null);
});

test('buildInvite: v2往復', () => {
    const payload = buildInvite('ABC123', '192.168.11.5:8090');
    assert.equal(payload, 'p2d://join/ABC123@192.168.11.5:8090');
    assert.deepEqual(parseInvite(payload), { code: 'ABC123', endpoint: '192.168.11.5:8090' });
    assert.equal(buildInvite('ABC123'), 'p2d://join/ABC123');
});
