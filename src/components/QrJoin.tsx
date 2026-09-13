/**
 * P2D - QRコード接続 (F-012)
 *
 * QrModal: ルーム内で参加リンク (p2d://join/<code>) のQRを表示する。
 * QrScannerModal: 参加画面でカメラからQRを読み取りルームコードを取得する。
 *   読み取りは jsQR (純JS) で行うためWebView2でも動作する。
 */

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { buildInvite } from '../lib/invite';

export function QrModal({ roomCode, inviteEndpoint, keyFingerprint, onClose }: { roomCode: string; inviteEndpoint?: string | null; keyFingerprint?: string | null; onClose: () => void }) {
    const [dataUrl, setDataUrl] = useState('');
    const [copied, setCopied] = useState('');

    // 招待v2: 内蔵サーバーが動いている場合は住所を埋め込む (サーバーレス参加, M4)
    const invitePayload = buildInvite(roomCode, inviteEndpoint);
    const inviteText = `P2Dで画面共有に招待します!\n参加リンク: ${invitePayload}\n(P2Dインストール済みならクリックで自動参加 / コード: ${roomCode})`;

    useEffect(() => {
        QRCode.toDataURL(invitePayload, {
            width: 280,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' },
        })
            .then(setDataUrl)
            .catch(() => setDataUrl(''));
    }, [invitePayload]);

    const copyText = (text: string, key: string) => {
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(key);
            window.setTimeout(() => setCopied(''), 1500);
        });
    };

    return (
        <div className="md-scrim">
            <div className="md-dialog p-6 max-w-sm w-full animate-slide-up text-center">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-semibold">QRで招待</h2>
                    <button onClick={onClose} className="md-icon-btn"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" /></svg></button>
                </div>
                {dataUrl ? (
                    <img src={dataUrl} alt={`p2d://join/${roomCode}`} className="mx-auto rounded-xl" />
                ) : (
                    <div className="h-[280px] flex items-center justify-center text-[var(--md-on-surface-variant)]">QR生成中…</div>
                )}
                <div className="mt-5 text-2xl font-mono font-bold tracking-[0.3em] text-[var(--md-primary)]">{roomCode}</div>
                {keyFingerprint && (
                    <div className="mt-2 text-[10px] font-mono text-[var(--md-on-surface-variant)]" title="ホストの署名鍵の指紋。配信木経由でも受信映像が本物のホスト産か、この照合で帯域外検証できます">
                        鍵FP: <span className="tracking-normal">{keyFingerprint}</span>
                    </div>
                )}
                <p className="text-xs text-[var(--md-on-surface-variant)] mt-2">
                    カメラで読み取ると <span className="font-mono">{invitePayload}</span> が開き、P2Dが自動参加します。
                    読めない場合は上のコードを手入力してください。
                    {inviteEndpoint && (
                        <>住所埋め込み (招待v2) のため、シグナリングサーバーが無くてもLANで参加できます。</>
                    )}
                </p>
                <div className="grid grid-cols-1 gap-2 mt-4">
                    <button
                        onClick={() => copyText(roomCode, 'code')}
                        className="btn-secondary w-full py-2 text-sm"
                    >
                        {copied === 'code' ? 'コピーしました' : 'コードをコピー'}
                    </button>
                    <button
                        onClick={() => copyText(inviteText, 'invite')}
                        className="btn-secondary w-full py-2 text-sm"
                        title="Discordのチャットに貼り付けて招待できます (F-052)"
                    >
                        {copied === 'invite' ? '招待文をコピーしました' : 'Discord招待文をコピー'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function QrScannerModal({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        let stream: MediaStream | null = null;
        let raf = 0;
        let stopped = false;

        void (async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment' },
                });
                if (stopped) return;
                const video = videoRef.current;
                if (!video) return;
                video.srcObject = stream;
                await video.play();

                const canvas = canvasRef.current;
                if (!canvas) return;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) return;

                const tick = () => {
                    if (stopped) return;
                    const v = videoRef.current;
                    if (v && v.readyState >= 2 && v.videoWidth > 0) {
                        canvas.width = v.videoWidth;
                        canvas.height = v.videoHeight;
                        ctx.drawImage(v, 0, 0);
                        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const found = jsQR(img.data, img.width, img.height);
                        if (found?.data) {
                            // p2d://join/CODE / p2d://join/CODE@host:port / 素のコードを受け付ける
                            const v2 = /p2d:\/\/join\/([A-Za-z0-9]{4,8})@([A-Za-z0-9.\-]+:[0-9]+)/.exec(found.data);
                            if (v2) {
                                onScan(`p2d://join/${v2[1]}@${v2[2]}`);
                                return;
                            }
                            const m = /p2d:\/\/join\/([A-Za-z0-9]{4,8})/.exec(found.data);
                            const raw = m ? m[1] : found.data.trim();
                            if (/^[A-Za-z0-9]{4,8}$/.test(raw)) {
                                onScan(raw.toUpperCase());
                                return;
                            }
                        }
                    }
                    raf = requestAnimationFrame(tick);
                };
                raf = requestAnimationFrame(tick);
            } catch (e) {
                setError('カメラを開けませんでした。カメラの権限を確認してください。');
                console.error('[QR] camera error:', e);
            }
        })();

        return () => {
            stopped = true;
            cancelAnimationFrame(raf);
            stream?.getTracks().forEach(t => t.stop());
        };
        // onScan は親の再描画で変わってもスキャンループを止めたくないので依存に入れない
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="md-scrim">
            <div className="md-dialog p-6 max-w-sm w-full animate-slide-up">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold">QRスキャン</h2>
                    <button onClick={onClose} className="md-icon-btn"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" /></svg></button>
                </div>
                {error ? (
                    <div className="p-4 rounded-xl bg-[var(--md-error-container)] text-[var(--md-on-error-container)] text-sm">{error}</div>
                ) : (
                    <div className="relative rounded-xl overflow-hidden bg-[var(--md-surface-lowest)] aspect-video">
                        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                        <div className="absolute inset-8 border-2 border-[var(--md-primary)]/70 rounded-lg pointer-events-none" />
                    </div>
                )}
                <canvas ref={canvasRef} className="hidden" />
                <p className="text-xs text-[var(--md-on-surface-variant)] mt-3">ホスト側のQRコードをカメラにかざしてください</p>
            </div>
        </div>
    );
}
