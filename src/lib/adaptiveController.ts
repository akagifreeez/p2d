/**
 * P2D - Adaptive Controller
 * 
 * ネットワーク状態に応じてビットレートを動的に調整する。
 */

import type { BandwidthStats } from './bandwidthMonitor';

export interface AdaptiveConfig {
    minBitrate: number;      // 最小ビットレート (kbps)
    maxBitrate: number;      // 最大ビットレート (kbps)
    turnMaxBitrate: number;  // TURN経由時の最大 (kbps)
    stepDownPercent: number; // 品質ダウン時の減少率 (%)
    stepUpPercent: number;   // 品質アップ時の増加率 (%)
}

export const defaultAdaptiveConfig: AdaptiveConfig = {
    minBitrate: 150,
    maxBitrate: 5000,
    turnMaxBitrate: 2000,
    stepDownPercent: 20,
    stepUpPercent: 10,
};

export class AdaptiveController {
    private sender: RTCRtpSender | null = null;
    private currentBitrate: number;
    private config: AdaptiveConfig;
    private isRelayConnection = false;

    constructor(config: Partial<AdaptiveConfig> = {}) {
        this.config = { ...defaultAdaptiveConfig, ...config };
        this.currentBitrate = this.config.maxBitrate;
    }

    /**
     * RTCRtpSenderを設定
     */
    setSender(sender: RTCRtpSender): void {
        this.sender = sender;
        console.log('[AdaptiveController] Sender設定完了');
    }

    /**
     * リレー接続かどうかを設定
     */
    setRelayConnection(isRelay: boolean): void {
        this.isRelayConnection = isRelay;
        if (isRelay) {
            console.log('[AdaptiveController] TURN接続検出 → 帯域制限適用');
            // TURN経由なら最大ビットレートを制限
            this.currentBitrate = Math.min(this.currentBitrate, this.config.turnMaxBitrate);
            this.applyBitrate();
        }
    }

    /**
     * 統計情報に基づいて自動調整
     */
    async adjustBasedOnStats(stats: BandwidthStats): Promise<void> {
        if (!this.sender) return;

        const maxBitrate = this.isRelayConnection
            ? this.config.turnMaxBitrate
            : this.config.maxBitrate;

        // 調整判定
        if (stats.packetLoss > 5) {
            // パケットロスが高い → ビットレートを下げる
            console.log(`[AdaptiveController] パケットロス ${stats.packetLoss}% → 品質ダウン`);
            await this.stepDown();
        } else if (stats.rtt > 300) {
            // RTTが高い → ビットレートを少し下げる
            console.log(`[AdaptiveController] RTT ${stats.rtt}ms → 品質ダウン`);
            await this.stepDown(15);
        } else if (stats.packetLoss < 1 && stats.rtt < 100 && this.currentBitrate < maxBitrate) {
            // 良好な接続 → ビットレートを上げる
            console.log(`[AdaptiveController] 接続良好 → 品質アップ`);
            await this.stepUp();
        }
    }

    /**
     * ビットレートを段階的に下げる
     */
    async stepDown(percent?: number): Promise<void> {
        const reduction = percent || this.config.stepDownPercent;
        const newBitrate = Math.max(
            this.config.minBitrate,
            this.currentBitrate * (1 - reduction / 100)
        );

        if (newBitrate !== this.currentBitrate) {
            this.currentBitrate = Math.round(newBitrate);
            await this.applyBitrate();
        }
    }

    /**
     * ビットレートを段階的に上げる
     */
    async stepUp(): Promise<void> {
        const maxBitrate = this.isRelayConnection
            ? this.config.turnMaxBitrate
            : this.config.maxBitrate;

        const newBitrate = Math.min(
            maxBitrate,
            this.currentBitrate * (1 + this.config.stepUpPercent / 100)
        );

        if (newBitrate !== this.currentBitrate) {
            this.currentBitrate = Math.round(newBitrate);
            await this.applyBitrate();
        }
    }

    /**
     * 特定のビットレートに設定
     */
    async setTargetBitrate(kbps: number): Promise<void> {
        const maxBitrate = this.isRelayConnection
            ? this.config.turnMaxBitrate
            : this.config.maxBitrate;

        this.currentBitrate = Math.max(
            this.config.minBitrate,
            Math.min(maxBitrate, kbps)
        );
        await this.applyBitrate();
    }

    /**
     * 現在のビットレートを取得
     */
    getCurrentBitrate(): number {
        return this.currentBitrate;
    }

    /**
     * ビットレートを適用
     */
    private async applyBitrate(): Promise<void> {
        if (!this.sender) return;

        try {
            const params = this.sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }

            // maxBitrateをbps単位で設定
            params.encodings[0].maxBitrate = this.currentBitrate * 1000;

            await this.sender.setParameters(params);
            console.log(`[AdaptiveController] ビットレート適用: ${this.currentBitrate} kbps`);
        } catch (e) {
            console.error('[AdaptiveController] ビットレート設定エラー:', e);
        }
    }
}
