/**
 * P2D - 招待ペイロード解析 (レンデブー最小化計画 M4)
 *
 * QR / ディープリンク / 手入力を1つの解析経路に統一する。
 * Rust側 (bridge::discord::find_join_url) と同じ規則のTS実装。
 *
 *   p2d://join/<CODE>                   … 従来 (シグナリングサーバーを電話帳に使用)
 *   p2d://join/<CODE>@<host>:<port>     … 招待v2 (ホスト内蔵サーバーへ直行)
 *   <CODE>                              … 手入力 (従来)
 */

export interface InvitePayload {
    code: string;
    /** "host:port" (v2のみ)。これがあれば ws://<endpoint> に直結する */
    endpoint: string | null;
}

export function parseInvite(raw: string): InvitePayload | null {
    const text = raw.trim();
    if (!text) return null;

    if (text.startsWith('p2d://join/')) {
        const rest = text.slice('p2d://join/'.length);
        const code = rest.match(/^[A-Za-z0-9]{4,8}/)?.[0];
        if (!code) return null;
        let endpoint: string | null = null;
        const at = rest.indexOf('@');
        if (at >= 0) {
            const m = rest
                .slice(at + 1)
                .match(/^[A-Za-z0-9.\-]+:[0-9]+/);
            if (m) endpoint = m[0];
        }
        return { code, endpoint };
    }

    // 手入力: 4-8桁の英数字コード
    if (/^[A-Za-z0-9]{4,8}$/.test(text)) {
        return { code: text.toUpperCase(), endpoint: null };
    }
    return null;
}

/** 招待ペイロードを組み立てる (QR/コピー用) */
export function buildInvite(code: string, endpoint?: string | null): string {
    return endpoint ? `p2d://join/${code}@${endpoint}` : `p2d://join/${code}`;
}
