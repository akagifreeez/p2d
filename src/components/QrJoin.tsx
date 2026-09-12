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

export function QrModal({ roomCode, onClose }: { roomCode: string; onClose: () => void }) {
    const [dataUrl, setDataUrl] = useState('');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        QRCode.toDataURL(`p2d://join/${roomCode}`, {
            width: 280,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' },
        })
            .then(setDataUrl)
            .catch(() => setDataUrl(''));
    }, [roomCode]);

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
            <div className="glass-card p-8 max-w-sm w-full border-cyan-500/30 animate-slide-up text-center">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-bold text-white">QRで招待</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
                </div>
                {dataUrl ? (
                    <img src={dataUrl} alt={`p2d://join/${roomCode}`} className="mx-auto rounded-xl" />
                ) : (
                    <div className="h-[280px] flex items-center justify-center text-gray-500">QR生成中…</div>
                )}
                <div className="mt-5 text-2xl font-mono font-bold tracking-[0.3em] text-cyan-300">{roomCode}</div>
                <p className="text-xs text-gray-500 mt-2">
                    カメラで読み取ると <span className="font-mono">p2d://join/{roomCode}</span> が開き、P2Dが自動参加します。
                    読めない場合は上のコードを手入力してください。
                </p>
                <button
                    onClick={() => {
                        void navigator.clipboard.writeText(roomCode).then(() => {
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                    className="btn-secondary w-full mt-4 py-2 text-sm"
                >
                    {copied ? 'コピーしました' : 'コードをコピー'}
                </button>
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
                            // p2d://join/CODE 形式でも素のコードでも受け付ける
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-fade-in">
            <div className="glass-card p-6 max-w-sm w-full border-purple-500/30 animate-slide-up">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold text-white">QRスキャン</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
                </div>
                {error ? (
                    <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{error}</div>
                ) : (
                    <div className="relative rounded-xl overflow-hidden bg-black/50 aspect-video">
                        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                        <div className="absolute inset-8 border-2 border-cyan-400/60 rounded-lg pointer-events-none" />
                    </div>
                )}
                <canvas ref={canvasRef} className="hidden" />
                <p className="text-xs text-gray-500 mt-3">ホスト側のQRコードをカメラにかざしてください</p>
            </div>
        </div>
    );
}
