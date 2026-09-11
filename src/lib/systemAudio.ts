/**
 * P2D - システム音声キャプチャクライアント (F-031)
 *
 * 経路: Rust (WASAPI ループバック / cpal)
 *   → Channel で base64(Int16 PCM) チャンクを受信
 *   → AudioWorklet のリングバッファに供給
 *   → MediaStreamAudioDestinationNode から MediaStreamTrack を取り出す
 *
 * 生成したトラックは useWebRTC 側で全ピアへ addTrack する。
 */

import { invoke, Channel } from '@tauri-apps/api/core';

export interface SystemAudioConfig {
    sample_rate: number;
    channels: number;
    device_name: string;
}

export interface SystemAudioSession {
    stream: MediaStream;
    track: MediaStreamTrack;
    config: SystemAudioConfig;
    stop: () => Promise<void>;
}

// AudioWorklet プロセッサ (Blob URL で読み込む)
// リングバッファで揺れを吸収し、50ms プリバッファ後に再生を始める。
const WORKLET_SRC = `
class P2DSystemAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.channels = Math.max(1, Math.min(2, opts.channels || 2));
        this.frameCapacity = sampleRate * 2; // 最大2秒分
        this.ring = new Float32Array(this.frameCapacity * this.channels);
        this.writePos = 0;
        this.readPos = 0;
        this.bufferedFrames = 0;
        this.prebufferFrames = Math.floor(sampleRate * 0.05); // 50ms
        this.started = false;
        this.port.onmessage = (e) => this.pushInterleaved(e.data);
    }
    pushInterleaved(chunk) {
        const frames = chunk.length / this.channels;
        if (frames <= 0) return;
        // オーバーフロー時は最古のフレームを落として遅延の蓄積を防ぐ
        if (this.bufferedFrames + frames > this.frameCapacity) {
            const drop = this.bufferedFrames + frames - this.frameCapacity;
            this.readPos = (this.readPos + drop * this.channels) % this.ring.length;
            this.bufferedFrames -= drop;
        }
        for (let i = 0; i < chunk.length; i++) {
            this.ring[this.writePos] = chunk[i];
            this.writePos = (this.writePos + 1) % this.ring.length;
        }
        this.bufferedFrames += frames;
    }
    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length === 0) return true;
        const frames = out[0].length;
        const ch = this.channels;
        for (let i = 0; i < frames; i++) {
            if (!this.started && this.bufferedFrames >= this.prebufferFrames) this.started = true;
            const has = this.started && this.bufferedFrames >= 1;
            for (let c = 0; c < ch; c++) {
                let s = 0;
                if (has) {
                    s = this.ring[this.readPos];
                    this.readPos = (this.readPos + 1) % this.ring.length;
                }
                out[c][i] = s;
            }
            if (has) this.bufferedFrames--;
        }
        return true;
    }
}
registerProcessor('p2d-system-audio', P2DSystemAudioProcessor);
`;

function base64ToInt16(b64: string): Int16Array {
    const bin = atob(b64);
    const out = new Int16Array(bin.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    }
    return out;
}

/**
 * システム音声キャプチャを開始し、送信用の MediaStreamTrack を返す。
 * ローカルスピーカーへは出力しない (ハウリング防止)。
 */
export async function startSystemAudioCapture(): Promise<SystemAudioSession> {
    const config = await invoke<SystemAudioConfig>('get_system_audio_config');
    const channels = Math.max(1, Math.min(2, config.channels));

    const audioContext = new AudioContext({
        sampleRate: config.sample_rate,
        latencyHint: 'interactive',
    });

    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    try {
        await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    const node = new AudioWorkletNode(audioContext, 'p2d-system-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        processorOptions: { channels },
    });
    const destination = audioContext.createMediaStreamDestination();
    node.connect(destination);

    const channel = new Channel<string>();
    channel.onmessage = (b64) => {
        const i16 = base64ToInt16(b64);
        const f32 = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) {
            f32[i] = i16[i] / 32768;
        }
        node.port.postMessage(f32, [f32.buffer]);
    };

    await invoke<SystemAudioConfig>('start_system_audio_capture', { onData: channel });

    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
        await invoke('stop_system_audio_capture').catch(() => { });
        await audioContext.close();
        throw new Error('システム音声トラックの生成に失敗しました');
    }

    const stop = async () => {
        await invoke('stop_system_audio_capture').catch(() => { });
        try {
            node.port.close();
        } catch { /* noop */ }
        track.stop();
        if (audioContext.state !== 'closed') {
            await audioContext.close();
        }
    };

    console.log(`[SystemAudio] started: ${config.device_name} (${config.sample_rate}Hz / ${channels}ch)`);
    return { stream: destination.stream, track, config, stop };
}
