/**
 * 招待ペイロード解析テスト (M4) — Rust側 find_join_url と同じ規則
 * 実行: node --import tsx --test --test-force-exit test/invite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvite, buildInvite } from '../src/lib/invite.js';

test('従来形式: コードのみ', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123'), { code: 'ABC123', endpoint: null, fingerprint: null });
});

test('招待v2: CODE@host:port', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@192.168.11.5:8090'), {
        code: 'ABC123',
        endpoint: '192.168.11.5:8090',
        fingerprint: null,
    });
});

test('招待v2: クエリ付きでもendpointを取り出す', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@p2d-host.local:8090?src=qr'), {
        code: 'ABC123',
        endpoint: 'p2d-host.local:8090',
        fingerprint: null,
    });
});

test('壊れたendpointはnullにフォールバック (コードは生きる)', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@:8090'), { code: 'ABC123', endpoint: null, fingerprint: null });
    assert.deepEqual(parseInvite('p2d://join/ABC123@hostonly'), { code: 'ABC123', endpoint: null, fingerprint: null });
});

test('issue#11: 招待v3の ;fp= を取り出す (endpoint有無両方)', () => {
    assert.deepEqual(parseInvite('p2d://join/ABC123@192.168.11.5:8090;fp=0123456789abcdef'), {
        code: 'ABC123',
        endpoint: '192.168.11.5:8090',
        fingerprint: '0123456789abcdef',
    });
    assert.deepEqual(parseInvite('p2d://join/ABC123;fp=ffffffffffffffff'), {
        code: 'ABC123',
        endpoint: null,
        fingerprint: 'ffffffffffffffff',
    });
    // fpの直後にクエリが続いてもOK
    assert.deepEqual(parseInvite('p2d://join/ABC123;fp=0123456789abcdef?x=1'), {
        code: 'ABC123',
        endpoint: null,
        fingerprint: '0123456789abcdef',
    });
    // 長さ不足・非hexのfpは採用しない (照合しないが参加は妨げない)
    assert.equal(parseInvite('p2d://join/ABC123;fp=123')?.fingerprint, null);
    assert.equal(parseInvite('p2d://join/ABC123;fp=zzzzzzzzzzzzzzzz')?.fingerprint, null);
});

test('手入力コード', () => {
    assert.deepEqual(parseInvite('cwh4k6'), { code: 'CWH4K6', endpoint: null, fingerprint: null });
    assert.equal(parseInvite('abc'), null);
    assert.equal(parseInvite(''), null);
    assert.equal(parseInvite('not a code!'), null);
});

test('buildInvite: v2/v3往復', () => {
    const payload = buildInvite('ABC123', '192.168.11.5:8090');
    assert.equal(payload, 'p2d://join/ABC123@192.168.11.5:8090');
    assert.deepEqual(parseInvite(payload), { code: 'ABC123', endpoint: '192.168.11.5:8090', fingerprint: null });
    assert.equal(buildInvite('ABC123'), 'p2d://join/ABC123');

    // issue#11: 指紋同梱の往復
    const withFp = buildInvite('ABC123', '192.168.11.5:8090', '0123456789abcdef');
    assert.equal(withFp, 'p2d://join/ABC123@192.168.11.5:8090;fp=0123456789abcdef');
    assert.deepEqual(parseInvite(withFp), {
        code: 'ABC123',
        endpoint: '192.168.11.5:8090',
        fingerprint: '0123456789abcdef',
    });
    // endpointなし+指紋あり
    const fpOnly = buildInvite('ABC123', null, 'ffffffffffffffff');
    assert.deepEqual(parseInvite(fpOnly), {
        code: 'ABC123',
        endpoint: null,
        fingerprint: 'ffffffffffffffff',
    });
});
