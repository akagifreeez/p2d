/**
 * P2D - シグナリング経路選択 (レンデブー最小化計画 M2)
 *
 * シグナリングサーバーが死んだ後も、既存メンバーのDataChannelを伝って
 * SDP/ICEを届けるための経路決定。Reactに依存しない純関数 (単体テスト対象)。
 *
 * 経路の優先順:
 *   1. 自分のWSが生きている → そのままサーバーへ (従来経路)
 *   2. 宛先へのDCが開いている → 直接tunnel (1ホップ)
 *   3. 宛先以外のDCが開いている → そのピアに中継を依頼 (maxHopsまで)
 *   4. どこにも届かない → 送れない (呼び出し側は諦める/遅延再試行)
 */

export type SignalKind = 'offer' | 'answer' | 'ice';

export interface TunnelEnvelope {
    originalSender: string;
    kind: SignalKind;
    targetId: string;
    payload: unknown;
    hops: number; // 残り中継ホップ数
}

export const TUNNEL_MAX_HOPS = 2;

export interface RouteOptions {
    wsOpen: boolean;
    myId: string;
    /** 宛先へのDCが開いているか */
    hasDirectDc: boolean;
    /** 宛先以外にDCが開いているピアID一覧 (中継候補) */
    relayCandidates: string[];
}

export interface SignalRoute {
    via: 'ws' | 'dc-direct' | 'dc-relay' | 'none';
    /** dc-relay のときの中継ピアID */
    relayPeer?: string;
}

export function chooseSignalRoute(targetId: string, opts: RouteOptions): SignalRoute {
    if (opts.wsOpen) return { via: 'ws' };
    if (opts.hasDirectDc) return { via: 'dc-direct' };
    // 中継候補から決定論的に1つ選ぶ (IDソートの先頭 — 全員が同じ選択をする)
    const candidates = opts.relayCandidates
        .filter(id => id !== opts.myId && id !== targetId)
        .sort();
    if (candidates.length > 0) {
        return { via: 'dc-relay', relayPeer: candidates[0] };
    }
    return { via: 'none' };
}

export function makeEnvelope(
    originalSender: string, kind: SignalKind, targetId: string, payload: unknown,
): TunnelEnvelope {
    return { originalSender, kind, targetId, payload, hops: TUNNEL_MAX_HOPS };
}

/** 中継ピアが次に転送する envelope を作る (ホップを1消費) */
export function forwardEnvelope(env: TunnelEnvelope): TunnelEnvelope | null {
    if (env.hops <= 0) return null;
    return { ...env, hops: env.hops - 1 };
}
