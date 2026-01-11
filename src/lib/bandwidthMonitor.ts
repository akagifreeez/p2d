/**
 * P2D - Bandwidth Monitor
 * 
 * RTCPeerConnectionの統計情報を定期取得し、帯域・RTT・パケットロスを監視する。
 */

export interface BandwidthStats {
    timestamp: number;
    bytesSent: number;
    bytesReceived: number;
    outboundBitrate: number;    // kbps
    inboundBitrate: number;     // kbps
    rtt: number;                // ms
    packetLoss: number;         // %
    candidateType: 'host' | 'srflx' | 'relay' | 'unknown';
    qualityLevel: 'excellent' | 'good' | 'fair' | 'poor';
}

export class BandwidthMonitor {
    private pc: RTCPeerConnection;
    private intervalId: number | null = null;
    private onUpdate: (stats: BandwidthStats) => void;

    // 前回の統計値（差分計算用）
    private lastBytesSent = 0;
    private lastBytesReceived = 0;
    private lastTimestamp = 0;

    constructor(pc: RTCPeerConnection, onUpdate: (stats: BandwidthStats) => void) {
        this.pc = pc;
        this.onUpdate = onUpdate;
    }

    /**
     * 監視開始
     */
    start(intervalMs: number = 2000): void {
        if (this.intervalId) return; // 既に開始済み

        console.log('[BandwidthMonitor] 監視開始');
        this.lastTimestamp = Date.now();

        this.intervalId = window.setInterval(async () => {
            try {
                const stats = await this.collectStats();
                this.onUpdate(stats);
            } catch (e) {
                console.error('[BandwidthMonitor] 統計取得エラー:', e);
            }
        }, intervalMs);
    }

    /**
     * 監視停止
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('[BandwidthMonitor] 監視停止');
        }
    }

    /**
     * 統計情報を収集
     */
    private async collectStats(): Promise<BandwidthStats> {
        const now = Date.now();
        const stats = await this.pc.getStats();

        let bytesSent = 0;
        let bytesReceived = 0;
        let rtt = 0;
        let packetsLost = 0;
        let packetsReceived = 0;
        let candidateType: BandwidthStats['candidateType'] = 'unknown';

        stats.forEach(report => {
            // 送信バイト数
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
                bytesSent += report.bytesSent || 0;
            }

            // 受信バイト数
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                bytesReceived += report.bytesReceived || 0;
                packetsLost += report.packetsLost || 0;
                packetsReceived += report.packetsReceived || 0;
            }

            // RTT（candidate-pairから取得）
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                rtt = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : 0;

                // 接続タイプを取得
                if (report.remoteCandidateId) {
                    const remoteCandidate = stats.get(report.remoteCandidateId);
                    if (remoteCandidate) {
                        candidateType = this.mapCandidateType(remoteCandidate.candidateType);
                    }
                }
            }
        });

        // ビットレート計算（kbps）
        const elapsed = (now - this.lastTimestamp) / 1000; // 秒
        const outboundBitrate = elapsed > 0
            ? ((bytesSent - this.lastBytesSent) * 8) / elapsed / 1000
            : 0;
        const inboundBitrate = elapsed > 0
            ? ((bytesReceived - this.lastBytesReceived) * 8) / elapsed / 1000
            : 0;

        // パケットロス率
        const packetLoss = packetsReceived > 0
            ? (packetsLost / (packetsLost + packetsReceived)) * 100
            : 0;

        // 品質レベル判定
        const qualityLevel = this.calculateQualityLevel(rtt, packetLoss, outboundBitrate);

        // 次回の差分計算用に保存
        this.lastBytesSent = bytesSent;
        this.lastBytesReceived = bytesReceived;
        this.lastTimestamp = now;

        return {
            timestamp: now,
            bytesSent,
            bytesReceived,
            outboundBitrate: Math.round(outboundBitrate),
            inboundBitrate: Math.round(inboundBitrate),
            rtt: Math.round(rtt),
            packetLoss: Math.round(packetLoss * 10) / 10,
            candidateType,
            qualityLevel,
        };
    }

    /**
     * 候補タイプをマッピング
     */
    private mapCandidateType(type: string): BandwidthStats['candidateType'] {
        switch (type) {
            case 'host': return 'host';
            case 'srflx': return 'srflx';
            case 'relay': return 'relay';
            default: return 'unknown';
        }
    }

    /**
     * 品質レベルを計算
     */
    private calculateQualityLevel(
        rtt: number,
        packetLoss: number,
        bitrate: number
    ): BandwidthStats['qualityLevel'] {
        // RTTが高すぎる or パケットロスが多い or ビットレートが低い → poor
        if (rtt > 500 || packetLoss > 10 || (bitrate > 0 && bitrate < 100)) return 'poor';
        if (rtt > 300 || packetLoss > 5 || (bitrate > 0 && bitrate < 300)) return 'fair';
        if (rtt > 150 || packetLoss > 2 || (bitrate > 0 && bitrate < 500)) return 'good';
        return 'excellent';
    }
}
