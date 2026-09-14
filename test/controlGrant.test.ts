/**
 * リモート操作グラント (視聴者ごとの明示承認・期限付き) の単体テスト (issue#8)
 * 実行: node --import tsx --test --test-force-exit test/controlGrant.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isControlAllowed, pruneExpired, resolveInputOrigin, CONTROL_TTL_OPTIONS,
    type ControlGrant,
} from '../src/lib/controlGrant.js';

const T0 = 1_000_000_000_000;

test('既定OFF: グラントが無い視聴者の入力は適用されない', () => {
    const grants = new Map<string, ControlGrant>();
    assert.equal(isControlAllowed(grants, 'viewer-a', T0), false);
    // peerId不明も不可
    assert.equal(isControlAllowed(grants, undefined, T0), false);
    assert.equal(isControlAllowed(grants, null, T0), false);
    assert.equal(isControlAllowed(grants, '', T0), false);
});

test('許可ONの視聴者と未許可の視聴者が混在できる', () => {
    const grants = new Map<string, ControlGrant>([
        ['allowed-viewer', { allowed: true, expiresAt: 0 }],
    ]);
    assert.equal(isControlAllowed(grants, 'allowed-viewer', T0), true);
    assert.equal(isControlAllowed(grants, 'other-viewer', T0), false, '未許可の視聴者は不可');
});

test('期限付き許可: 期限内は可・期限ちょうどと経過後は不可', () => {
    const grants = new Map<string, ControlGrant>([
        ['v', { allowed: true, expiresAt: T0 + 5 * 60_000 }],
    ]);
    assert.equal(isControlAllowed(grants, 'v', T0), true);
    assert.equal(isControlAllowed(grants, 'v', T0 + 5 * 60_000 - 1), true, '期限直前は可');
    assert.equal(isControlAllowed(grants, 'v', T0 + 5 * 60_000), false, '期限ちょうどは不可');
    assert.equal(isControlAllowed(grants, 'v', T0 + 5 * 60_000 + 1), false, '期限切れは不可');
});

test('allowed=falseのグラントは期限に関係なく不可', () => {
    const grants = new Map<string, ControlGrant>([
        ['v', { allowed: false, expiresAt: T0 + 60_000 }],
    ]);
    assert.equal(isControlAllowed(grants, 'v', T0), false);
});

test('pruneExpired: 期限切れだけを除去し、無期限と他人は残る', () => {
    const grants = new Map<string, ControlGrant>([
        ['expired', { allowed: true, expiresAt: T0 - 1 }],
        ['just-expired', { allowed: true, expiresAt: T0 }],
        ['still-valid', { allowed: true, expiresAt: T0 + 60_000 }],
        ['unlimited', { allowed: true, expiresAt: 0 }],
        ['revoked', { allowed: false, expiresAt: T0 - 1 }],
    ]);
    const expired = pruneExpired(grants, T0);
    assert.deepEqual(expired.sort(), ['expired', 'just-expired']);
    assert.equal(grants.has('expired'), false);
    assert.equal(grants.has('just-expired'), false);
    assert.equal(grants.has('still-valid'), true);
    assert.equal(grants.has('unlimited'), true);
    assert.equal(grants.has('revoked'), true, '取消済みは許可ではないのでprune対象外');
});

test('resolveInputOrigin: 直接受信はsenderId、木経由はoriginIdを優先', () => {
    // 直接 (DC / リレー直接): payloadにoriginIdが無い → senderIdが発信者
    const direct = resolveInputOrigin('viewer-1', { type: 'input:scroll', payload: { deltaX: 0 } });
    assert.equal(direct.originId, 'viewer-1');
    assert.equal(direct.type, 'input:scroll');

    // 配信木の中継経由: 中継がoriginIdを付与 → 検証対象は実際の視聴者
    const relayed = resolveInputOrigin('relay-node', {
        type: 'input:scroll', payload: { deltaY: 0 }, originId: 'viewer-2',
    });
    assert.equal(relayed.originId, 'viewer-2');
    assert.equal(relayed.type, 'input:scroll');
    assert.deepEqual(relayed.payload, { deltaY: 0 });

    // 悪意ある/壊れた中継がoriginIdを消しても senderId (中継) のグラントで判定される
    const stripped = resolveInputOrigin('relay-node', { type: 'input:scroll', payload: {} });
    assert.equal(stripped.originId, 'relay-node');

    // null/undefined payloadも安全
    assert.equal(resolveInputOrigin('viewer-3', null).originId, 'viewer-3');
    assert.equal(resolveInputOrigin('viewer-3', undefined).type, '');
});

test('TTL選択肢は5分/30分/無期限', () => {
    assert.deepEqual(CONTROL_TTL_OPTIONS.map(o => o.label), ['5分', '30分', '無期限']);
    assert.deepEqual(CONTROL_TTL_OPTIONS.map(o => o.ms), [300_000, 1_800_000, 0]);
});
