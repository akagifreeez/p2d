import type { WebRTCStats } from '../hooks/useWebRTC';

interface StatsOverlayProps {
    stats: WebRTCStats | null;
}

export function StatsOverlay({ stats }: StatsOverlayProps) {
    if (!stats) return null;

    // パケットロス率やカウントの表示制御
    // ビットレートはMbps変換
    const bitrateMbps = (stats.bitrate / 1_000_000).toFixed(2);

    return (
        <div className="fixed bottom-4 right-4 bg-black/80 text-white p-3 rounded-lg text-xs font-mono z-50 pointer-events-none shadow-lg border border-white/10">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="text-gray-400">FPS:</div>
                <div className="text-right font-bold text-green-400">{stats.fps}</div>

                <div className="text-gray-400">Bitrate:</div>
                <div className="text-right">{bitrateMbps} Mbps</div>

                <div className="text-gray-400">Res:</div>
                <div className="text-right">{stats.resolution.width}x{stats.resolution.height}</div>

                {stats.packetLoss > 0 && (
                    <>
                        <div className="text-red-400">Loss:</div>
                        <div className="text-right text-red-500 font-bold">{stats.packetLoss}</div>
                    </>
                )}
            </div>
        </div>
    );
}
