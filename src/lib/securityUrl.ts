/**
 * P2D - 平文URL検出 (issue#3 / 監査#3)
 *
 * シグナリング (ws://) とTURN (turn://) の両方について、ローカル/プライベート網
 * 以外への暗号化なし接続を検出して警告文を返す。公開環境の公式手順は
 * wss:// と turns:// のみ (DOCKER.md「公開環境での TLS」節)。
 */

/** host部がローカル (localhost/127.0.0.1/::1) またはプライベート網か */
export function isLocalOrPrivateHost(hostRaw: string): boolean {
    // IPv6はブラケット付きで返る ([::1]) ので剥がしてから判定
    const h = hostRaw.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
    return h === 'localhost' || h === '::1' || h.endsWith('.local') ||
        /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h); // CGNAT (Tailscale等のVPN網)
}

/**
 * 平文 (暗号化なし) URLの警告文を返す。問題なければnull。
 * 対応スキーム: ws:// / wss:// / turn:// / turns://
 * - ws:// と turn:// は平文。ホストがローカル/プライベート網なら許容 (null)
 * - wss:// と turns:// は常にnull (暗号化済み)
 * - 未知のスキームはnull (別レイヤーのバリデーションに任せる)
 */
export function plaintextUrlWarning(rawUrl: string): string | null {
    const text = rawUrl.trim();
    if (!text) return null;

    const m = text.match(/^(wss|ws|turns|turn):(.*)$/i);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'wss' || scheme === 'turns') return null;

    // 以降は平文スキーム (ws: / turn:)。
    //   ws://host[:port]/path     → "host[:port]/path"
    //   turn:host[:port][?query]  → "host[:port][?query]"
    let rest = m[2].replace(/^\/\//, '');
    rest = rest.split(/[/?]/)[0];
    // turn:host:port は最初の : がホストとポートの区切り (IPv6はブラケット)
    let host = rest;
    if (!rest.startsWith('[')) {
        const colon = rest.indexOf(':');
        if (colon >= 0) host = rest.slice(0, colon);
    }
    if (!host) return null;

    if (isLocalOrPrivateHost(host)) return null;
    return scheme === 'ws'
        ? 'このシグナリングURLは暗号化されない ws:// です。公開環境ではリバースプロキシ等でTLS終端した wss:// を使用してください (DOCKER.md「公開環境での TLS」)。'
        : 'このTURN URLは平文の turn:// です。公開環境では証明書を設定した turns:// (ポート5349) を使用してください (DOCKER.md「公開環境での TLS」)。';
}
