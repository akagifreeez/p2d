/**
 * P2D - 品質設定コンポーネント
 * 
 * 解像度、FPS、ビットレートなどの配信品質を設定する。
 */

import { useState } from 'react';

// 品質設定の型定義
export interface QualityConfig {
    resolution: '720p' | '1080p' | 'native';
    frameRate: 15 | 30 | 60;
    bitrate: number | 'auto';
    codec: 'auto' | 'av1' | 'vp9' | 'vp8' | 'h264';
    contentHint: 'detail' | 'motion';
}

// デフォルト設定
export const defaultQualityConfig: QualityConfig = {
    resolution: '1080p',
    frameRate: 30,
    bitrate: 'auto',
    codec: 'auto',
    contentHint: 'detail',
};

// 解像度オプション
const resolutionOptions = [
    { value: '720p', label: '720p (1280×720)', description: '低帯域でも安定' },
    { value: '1080p', label: '1080p (1920×1080)', description: 'バランス良好' },
    { value: 'native', label: 'ネイティブ', description: '最高品質' },
] as const;

// FPSオプション
const frameRateOptions = [
    { value: 15, label: '15 FPS', description: 'プレゼン向け' },
    { value: 30, label: '30 FPS', description: '標準' },
    { value: 60, label: '60 FPS', description: '滑らか' },
] as const;

// ビットレートオプション
const bitrateOptions = [
    { value: 'auto', label: '自動', description: 'ネットワーク状況に応じて調整' },
    { value: 1000, label: '1 Mbps', description: '低帯域' },
    { value: 2500, label: '2.5 Mbps', description: '標準' },
    { value: 5000, label: '5 Mbps', description: '高品質' },
    { value: 10000, label: '10 Mbps', description: '超高品質' },
    { value: 0, label: '無制限', description: '制限なし (LAN推奨)' },
] as const;

// コーデックオプション
const codecOptions = [
    { value: 'auto', label: '自動 (推奨)', description: '最適な形式を自動選択' },
    { value: 'av1', label: 'AV1', description: '高圧縮・高負荷(GPU推奨)' },
    { value: 'vp9', label: 'VP9', description: 'YouTube等で使用' },
    { value: 'h264', label: 'H.264', description: '低負荷・高速(推奨)' },
    { value: 'vp8', label: 'VP8', description: '標準' },
] as const;

// 最適化オプション
const contentHintOptions = [
    { value: 'detail', label: '標準 (画質優先)', description: '文字や細かい映像向き' },
    { value: 'motion', label: '滑らかさ優先', description: 'ゲームや動画向き' },
] as const;

interface QualitySettingsProps {
    config: QualityConfig;
    onChange: (config: QualityConfig) => void;
    disabled?: boolean;
}

export function QualitySettings({ config, onChange, disabled = false }: QualitySettingsProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    const handleResolutionChange = (resolution: QualityConfig['resolution']) => {
        onChange({ ...config, resolution });
    };

    const handleFrameRateChange = (frameRate: QualityConfig['frameRate']) => {
        onChange({ ...config, frameRate });
    };

    const handleBitrateChange = (bitrate: QualityConfig['bitrate']) => {
        onChange({ ...config, bitrate });
    };

    const handleCodecChange = (codec: QualityConfig['codec']) => {
        onChange({ ...config, codec });
    };

    const handleContentHintChange = (contentHint: QualityConfig['contentHint']) => {
        onChange({ ...config, contentHint });
    };

    return (
        <div className="card p-4">
            {/* ヘッダー */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between text-left"
            >
                <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                    <span className="font-medium">品質設定</span>
                </div>
                <div className="flex items-center space-x-2">
                    <span className="text-sm text-dark-400">
                        {config.resolution} / {config.frameRate}fps / {config.codec === 'auto' ? 'Auto' : config.codec.toUpperCase()}
                    </span>
                    <svg
                        className={`w-4 h-4 text-dark-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </button>

            {/* 設定パネル */}
            {isExpanded && (
                <div className="mt-4 space-y-6 pt-4 border-t border-dark-700">
                    {/* 解像度 */}
                    <div>
                        <label className="block text-sm font-medium text-dark-300 mb-2">解像度</label>
                        <div className="grid grid-cols-3 gap-2">
                            {resolutionOptions.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => handleResolutionChange(option.value)}
                                    disabled={disabled}
                                    className={`p-3 rounded-lg border transition-all ${config.resolution === option.value
                                        ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                                        : 'border-dark-600 hover:border-dark-500 text-dark-300'
                                        } disabled:opacity-50`}
                                >
                                    <div className="font-medium text-sm">{option.label}</div>
                                    <div className="text-xs text-dark-500 mt-1">{option.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* フレームレート */}
                    <div>
                        <label className="block text-sm font-medium text-dark-300 mb-2">フレームレート</label>
                        <div className="grid grid-cols-3 gap-2">
                            {frameRateOptions.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => handleFrameRateChange(option.value)}
                                    disabled={disabled}
                                    className={`p-3 rounded-lg border transition-all ${config.frameRate === option.value
                                        ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                                        : 'border-dark-600 hover:border-dark-500 text-dark-300'
                                        } disabled:opacity-50`}
                                >
                                    <div className="font-medium text-sm">{option.label}</div>
                                    <div className="text-xs text-dark-500 mt-1">{option.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* コーデック (NEW) */}
                    <div>
                        <label className="block text-sm font-medium text-dark-300 mb-2">ビデオコーデック</label>
                        <div className="grid grid-cols-3 lg:grid-cols-5 gap-2">
                            {codecOptions.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => handleCodecChange(option.value)}
                                    disabled={disabled}
                                    className={`p-3 rounded-lg border transition-all ${config.codec === option.value
                                        ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                                        : 'border-dark-600 hover:border-dark-500 text-dark-300'
                                        } disabled:opacity-50`}
                                >
                                    <div className="font-medium text-sm">{option.label}</div>
                                    <div className="text-xs text-dark-500 mt-1">{option.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 最適化 (NEW) */}
                    <div>
                        <label className="block text-sm font-medium text-dark-300 mb-2">最適化ターゲット</label>
                        <div className="grid grid-cols-2 gap-2">
                            {contentHintOptions.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => handleContentHintChange(option.value)}
                                    disabled={disabled}
                                    className={`p-3 rounded-lg border text-left transition-all ${config.contentHint === option.value
                                        ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                                        : 'border-dark-600 hover:border-dark-500 text-dark-300'
                                        } disabled:opacity-50`}
                                >
                                    <div className="font-medium text-sm">{option.label}</div>
                                    <div className="text-xs text-dark-500 mt-1">{option.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ビットレート */}
                    <div>
                        <label className="block text-sm font-medium text-dark-300 mb-2">ビットレート</label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                            {bitrateOptions.map((option) => (
                                <button
                                    key={String(option.value)}
                                    onClick={() => handleBitrateChange(option.value)}
                                    disabled={disabled}
                                    className={`p-3 rounded-lg border transition-all ${config.bitrate === option.value
                                        ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                                        : 'border-dark-600 hover:border-dark-500 text-dark-300'
                                        } disabled:opacity-50`}
                                >
                                    <div className="font-medium text-sm">{option.label}</div>
                                    <div className="text-xs text-dark-500 mt-1 hidden sm:block">{option.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 推定帯域幅 */}
                    <div className="p-3 bg-dark-700/50 rounded-lg">
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-dark-400">推定必要帯域幅</span>
                            <span className="text-primary-400 font-medium">
                                {estimateBandwidth(config)}
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// 帯域幅推定
function estimateBandwidth(config: QualityConfig): string {
    if (config.bitrate === 0) {
        return '無制限 (利用可能な最大帯域)';
    }
    if (config.bitrate !== 'auto') {
        return `${(config.bitrate / 1000).toFixed(1)} Mbps`;
    }

    // 解像度とFPSから推定
    const baseRate = config.resolution === 'native' ? 5000 :
        config.resolution === '1080p' ? 3000 : 1500;
    const fpsMultiplier = config.frameRate / 30;
    const estimated = baseRate * fpsMultiplier;

    return `約 ${(estimated / 1000).toFixed(1)} Mbps`;
}

// 設定をlocalStorageに保存/読込
export function saveQualityConfig(config: QualityConfig): void {
    localStorage.setItem('p2d_quality_config', JSON.stringify(config));
}

export function loadQualityConfig(): QualityConfig {
    try {
        const saved = localStorage.getItem('p2d_quality_config');
        if (saved) {
            return { ...defaultQualityConfig, ...JSON.parse(saved) };
        }
    } catch {
        // パースエラーは無視
    }
    return defaultQualityConfig;
}
