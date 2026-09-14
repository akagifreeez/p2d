/**
 * P2D - リモート操作許可のグラント管理 (issue#8 / F-022)
 *
 * 「ホスト単位の全か無か」だったリモート操作許可を、視聴者ごとの明示承認 +
 * 期限付きにするための純粋ロジック。ホスト側の状態は Map<peerId, ControlGrant>。
 * - 既定OFF: グラントが無い視聴者の入力は適用されない
 * - 期限: expiresAt (epoch ms)。0 = 無期限。期限切れは自動で無効
 * - 発信者検証: 配信木の中継経由では入力に発信者ID (originId) が封筒に載る。
 *   中継は転送のみで、ホストは originId (無ければ senderId) のグラントを検証する
 */

export interface ControlGrant {
    allowed: boolean;
    /** 絶対期限 (epoch ms)。0 = 無期限 */
    expiresAt: number;
}

/** 許可ダイアログの期限候補 (ms)。0 = 無期限 */
export const CONTROL_TTL_OPTIONS = [
    { key: '5min', label: '5分', ms: 5 * 60_000 },
    { key: '30min', label: '30分', ms: 30 * 60_000 },
    { key: 'unlimited', label: '無期限', ms: 0 },
] as const;

export type ControlTtlKey = (typeof CONTROL_TTL_OPTIONS)[number]['key'];

/**
 * その視聴者の入力を今適用してよいか。
 * peerId不明・グラント無し・allowed=false・期限切れのいずれも false。
 */
export function isControlAllowed(
    grants: Map<string, ControlGrant>,
    peerId: string | null | undefined,
    now: number,
): boolean {
    if (!peerId) return false;
    const g = grants.get(peerId);
    if (!g || !g.allowed) return false;
    return g.expiresAt === 0 || g.expiresAt > now;
}

/**
 * 期限切れのグラントを除去し、切れた視聴者の一覧を返す
 * (バッジ更新 + 視聴者への許可解除通知に使う)。
 */
export function pruneExpired(grants: Map<string, ControlGrant>, now: number): string[] {
    const expired: string[] = [];
    for (const [id, g] of grants) {
        if (g.allowed && g.expiresAt !== 0 && g.expiresAt <= now) expired.push(id);
    }
    for (const id of expired) grants.delete(id);
    return expired;
}

/**
 * 入力メッセージの発信者を確定する (ホスト側)。
 * - 直接受信 (DC / リレー直接): senderId がそのまま発信者
 * - 配信木の中継経由: 中継が originId を付与する。 senderId は中継になるため
 *   検証対象を originId に差し替える (中継自体のグラントで代用しない)
 */
export function resolveInputOrigin(
    senderId: string,
    payload: { originId?: unknown; type?: unknown; payload?: unknown } | null | undefined,
): { originId: string; type: string; payload: unknown } {
    const p = payload || {};
    const type = typeof p.type === 'string' ? p.type : '';
    const originId = typeof p.originId === 'string' && p.originId ? p.originId : senderId;
    return { originId, type, payload: p.payload };
}
