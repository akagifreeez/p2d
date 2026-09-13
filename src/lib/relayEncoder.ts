/**
 * P2D - WSリレー用 H264エンコーダ (ホスト側)
 *
 * canvas → WebCodecs VideoEncoder(H264) → mp4-muxer(fragmented fMP4) →
 * top-level box単位に再組立してonBoxへ (MSE SourceBufferにそのままappendできる単位)。
 *
 * - moof/mdat はペアでまとめて出す (MSEへのappendはboxの境界でないと失敗するため)
 * - styp/sidx などMSEに不要な箱はスキップ
 * - ゲスト側は MediaSource('video/mp4; codecs=avc1.420028') + sequence モードで受ける
 */

export const RELAY_H264_CODEC = 'avc1.420028'; // Baseline L4.0 (1600x900@15fps十分)
export const RELAY_MSE_VIDEO_MIME = 'video/mp4; codecs="avc1.420028"';
export const RELAY_MSE_AUDIO_MIME = 'audio/webm; codecs="opus"';
export const RELAY_AUDIO_REC_MIME = 'audio/webm;codecs=opus';

import { Muxer, StreamTarget } from 'mp4-muxer';

// ゲスト側の能力検出
export function detectRelayCapabilities(): { mse: boolean; webmAudio: boolean } {
    let mse = false;
    let webmAudio = false;
    try {
        if (typeof MediaSource !== 'undefined') {
            mse = MediaSource.isTypeSupported(RELAY_MSE_VIDEO_MIME);
            webmAudio = MediaSource.isTypeSupported(RELAY_MSE_AUDIO_MIME);
        }
    } catch { /* 古いエンジンはMediaSourceごと無い */ }
    return { mse, webmAudio };
}

export class RelayH264Encoder {
    private muxer: Muxer<StreamTarget> | null = null;
    private encoder: VideoEncoder | null = null;
    private writtenBytes = 0;
    private boxBuf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    private pendingMoof: Uint8Array<ArrayBufferLike> | null = null;
    private frameCount = 0;
    private timestampUs = 0;
    private readonly onBox: (data: ArrayBuffer) => void;
    private readonly onError: (e: unknown) => void;

    constructor(opts: { width: number; height: number; bitrate?: number; onBox: (data: ArrayBuffer) => void; onError?: (e: unknown) => void }) {
        this.onBox = opts.onBox;
        this.onError = opts.onError || (() => { });
        try {
            this.muxer = new Muxer({
                target: new StreamTarget({
                    onData: (data, position) => this.handleWrite(data, position),
                }),
                video: { codec: 'avc', width: opts.width, height: opts.height },
                fastStart: 'fragmented',
                firstTimestampBehavior: 'offset',
                minFragmentDuration: 0.5,
            });

            this.encoder = new VideoEncoder({
                output: (chunk, meta) => {
                    try {
                        this.muxer?.addVideoChunk(chunk, meta);
                    } catch (e) {
                        this.onError(e);
                    }
                },
                error: (e) => this.onError(e),
            });
            this.encoder.configure({
                codec: RELAY_H264_CODEC,
                width: opts.width,
                height: opts.height,
                bitrate: opts.bitrate ?? 2_500_000,
                framerate: 15,
                latencyMode: 'realtime',
                avc: { format: 'avc' }, // MP4にはannexbでなくavc形式が必要
            });
        } catch (e) {
            this.onError(e);
        }
    }

    /** canvasの現在内容を1フレーム エンコードする (約12.5fpsで呼ばれる) */
    encode(canvas: HTMLCanvasElement): void {
        if (!this.encoder || this.encoder.state !== 'configured') return;
        try {
            const frame = new VideoFrame(canvas, { timestamp: this.timestampUs });
            this.timestampUs += 80_000; // 12.5fps
            const keyFrame = this.frameCount % 13 === 0; // 約1秒ごと
            this.frameCount++;
            this.encoder.encode(frame, { keyFrame });
            frame.close();
        } catch (e) {
            this.onError(e);
        }
    }

    close(): void {
        try {
            this.encoder?.close();
        } catch { /* noop */ }
        try {
            this.muxer?.finalize();
        } catch { /* noop */ }
        this.encoder = null;
        this.muxer = null;
    }

    /**
     * muxerからの書き込み (position指定) を受けて、連続バイト列をtop-level box単位に再組立する。
     * fragmented モードは基本逐次書き込みなので、position が飛んだら異常として諦める。
     */
    private handleWrite(data: Uint8Array, position: number): void {
        if (position !== this.writtenBytes) {
            // 予期しない飛び書き (起きたらこのエンコーダは諦める)
            this.onError(new Error(`relay muxer non-sequential write: pos=${position} expected=${this.writtenBytes}`));
            return;
        }
        this.writtenBytes += data.length;
        this.boxBuf = concat(this.boxBuf, data);

        // 完全な top-level box を取り出す
        for (;;) {
            if (this.boxBuf.length < 8) break;
            const view = new DataView(this.boxBuf.buffer, this.boxBuf.byteOffset, this.boxBuf.byteLength);
            let size = view.getUint32(0);
            const type = String.fromCharCode(this.boxBuf[4], this.boxBuf[5], this.boxBuf[6], this.boxBuf[7]);
            if (size === 1) {
                if (this.boxBuf.length < 16) break;
                size = Number(view.getBigUint64(8));
            }
            if (size === 0 || this.boxBuf.length < size) break; // まだ途中

            const box = this.boxBuf.subarray(0, size);
            this.boxBuf = this.boxBuf.subarray(size);

            if (type === 'moof') {
                this.pendingMoof = new Uint8Array(box); // mdat完成まで保持
            } else if (type === 'mdat') {
                if (this.pendingMoof) {
                    const pair = concat(this.pendingMoof, box);
                    this.onBox(pair.buffer.slice(pair.byteOffset, pair.byteOffset + pair.byteLength) as ArrayBuffer);
                    this.pendingMoof = null;
                }
            } else if (type === 'ftyp' || type === 'moov') {
                this.onBox(box.slice().buffer as ArrayBuffer); // init segment
            }
            // styp / sidx / その他はスキップ
        }
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
    }
    return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
