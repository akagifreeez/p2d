/**
 * P2D - リレーチャンクのEd25519署名 (レンデブー最小化計画 M3 / 配信木計画書 §3.5)
 *
 * ホスト内蔵WSサーバー経由でメディアを配る構成では、リレー経路の信頼が
 * 「自前サーバー」から「参加者全員」へ寄る。そこでホストがルーム毎の
 * エフェメラル鍵ペア (Ed25519, tweetnacl) を生成し、各チャンクに署名する。
 * 視聴者は公開鍵 (relay:key で配布) で完全性・真正性を検証する。
 *
 * 署名対象: seq (8byte BE) ‖ ts (8byte BE) ‖ chunkバイト列
 * - seq が署名に入るためリプレイ/並べ替え/削除が検知できる
 * - 鍵はルーム毎に生成し、退出と共に無効化 (恒久鍵を持たない)
 */

import nacl from 'tweetnacl';

export interface RelayKeyPair {
    publicKeyB64: string;
    secretKeyB64: string;
}

export function b64encode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

export function b64decode(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** ルーム毎のエフェメラル鍵ペアを生成 (ホスト側) */
export function generateRelayKeyPair(): RelayKeyPair {
    const pair = nacl.sign.keyPair();
    return { publicKeyB64: b64encode(pair.publicKey), secretKeyB64: b64encode(pair.secretKey) };
}

function buildMessage(seq: number, ts: number, data: Uint8Array): Uint8Array {
    // seq/ts は 8byte big-endian (Number的安全範囲: 2^53未満)
    const msg = new Uint8Array(16 + data.length);
    const dv = new DataView(msg.buffer);
    dv.setBigUint64(0, BigInt(Math.max(0, Math.floor(seq))), false);
    dv.setBigUint64(8, BigInt(Math.max(0, Math.floor(ts))), false);
    msg.set(data, 16);
    return msg;
}

/** 1チャンクに署名する (ホスト側) */
export function signChunk(secretKeyB64: string, seq: number, ts: number, data: Uint8Array): string {
    const secret = b64decode(secretKeyB64);
    const sig = nacl.sign.detached(buildMessage(seq, ts, data), secret);
    return b64encode(sig);
}

/** 1チャンクの署名を検証する (視聴側)。falseなら改ざん/偽物/リプレイ並べ替えを検知 */
export function verifyChunk(
    publicKeyB64: string, seq: number, ts: number, data: Uint8Array, sigB64: string,
): boolean {
    try {
        const pub = b64decode(publicKeyB64);
        if (pub.length !== nacl.sign.publicKeyLength) return false;
        const sig = b64decode(sigB64);
        if (sig.length !== nacl.sign.signatureLength) return false;
        return nacl.sign.detached.verify(buildMessage(seq, ts, data), sig, pub);
    } catch {
        return false;
    }
}

/** 公開鍵のフィンガープリント (SHA-512先頭8バイトhex)。QRに同梱して帯域外照合に使う (M4) */
export function keyFingerprint(publicKeyB64: string): string {
    const h = nacl.hash(b64decode(publicKeyB64));
    return Array.from(h.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * relay:key 受信ポリシー (issue#11)。
 * - pin-first: 最初に受信した鍵を固定し、以後の差し替え要求は拒否する
 *   (中継者・参加者は鍵を自分のものに付け替えて偽映像を正規化できない)
 * - 指紋照合: 招待 (;fp=) の指紋があれば、一致しない鍵は最初から受理しない
 *   (攻撃者がホストより先に偽鍵を送って固定する競合を帯域外で防ぐ)
 */
export function acceptKeyCandidate(
    expectedFp: string | null,
    pinnedPub: string | null,
    candidatePub: string,
): { accept: boolean; reason?: 'fingerprint-mismatch' | 'already-pinned' | 'same-as-pinned' } {
    if (expectedFp && keyFingerprint(candidatePub) !== expectedFp) {
        return { accept: false, reason: 'fingerprint-mismatch' };
    }
    if (pinnedPub) {
        return candidatePub === pinnedPub
            ? { accept: false, reason: 'same-as-pinned' }
            : { accept: false, reason: 'already-pinned' };
    }
    return { accept: true };
}

/** チャンクのデータ部 (base64 → bytes) を取り出す */
export function chunkDataFromB64(dB64: string): Uint8Array {
    return b64decode(dB64);
}
