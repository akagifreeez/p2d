/**
 * P2D - Quality Config Panel (Modern)
 */

import { useState } from 'react';

// Setting Types
export interface QualityConfig {
    resolution: '720p' | '1080p' | 'native';
    frameRate: 15 | 30 | 60;
    bitrate: number | 'auto';
    codec: 'auto' | 'av1' | 'vp9' | 'vp8' | 'h264';
    contentHint: 'detail' | 'motion';
}

export const defaultQualityConfig: QualityConfig = {
    resolution: '1080p',
    frameRate: 30,
    bitrate: 'auto',
    codec: 'auto',
    contentHint: 'detail',
};

const resolutionOptions = [
    { value: '720p', label: '720p', sub: 'Low BW', description: 'Good for slow connections' },
    { value: '1080p', label: '1080p', sub: 'Balanced', description: 'Best balance' },
    { value: 'native', label: 'Native', sub: 'Maximum', description: 'Highest quality' },
] as const;

const frameRateOptions = [
    { value: 15, label: '15 FPS', sub: 'Slides', description: 'Low motion content' },
    { value: 30, label: '30 FPS', sub: 'Video', description: 'Standard video' },
    { value: 60, label: '60 FPS', sub: 'Game', description: 'High motion content' },
] as const;

const bitrateOptions = [
    { value: 'auto', label: 'Auto', sub: 'Adaptive' },
    { value: 1000, label: '1 Mbps', sub: 'Low' },
    { value: 2500, label: '2.5 M', sub: 'Std' },
    { value: 5000, label: '5 Mbps', sub: 'High' },
    { value: 10000, label: '10 M', sub: 'Ultra' },
    { value: 0, label: 'Max', sub: 'LAN' },
] as const;

const codecOptions = [
    { value: 'auto', label: 'Auto', sub: 'Smart' },
    { value: 'av1', label: 'AV1', sub: 'High Comp' },
    { value: 'vp9', label: 'VP9', sub: 'YouTube' },
    { value: 'h264', label: 'H.264', sub: 'Fast' },
    { value: 'vp8', label: 'VP8', sub: 'Legacy' },
] as const;

const contentHintOptions = [
    { value: 'detail', label: 'Text', sub: 'Sharpness', description: 'Prioritize text clarity' },
    { value: 'motion', label: 'Motion', sub: 'Fluidity', description: 'Prioritize movement' },
] as const;

interface QualitySettingsProps {
    config: QualityConfig;
    onChange: (config: QualityConfig) => void;
    disabled?: boolean;
}

export function QualitySettings({ config, onChange, disabled = false }: QualitySettingsProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    const update = (key: keyof QualityConfig, value: any) => {
        onChange({ ...config, [key]: value });
    };

    return (
        <div className={`glass-card overflow-hidden transition-all duration-300 ${isExpanded ? 'bg-black/40' : 'bg-transparent border-0 shadow-none'}`}>
            {/* Header / Toggle */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={`w-full flex items-center justify-between text-left p-4 rounded-xl transition-colors ${isExpanded ? 'bg-white/5' : 'glass-card hover:bg-white/10'}`}
            >
                <div className="flex items-center space-x-3">
                    <div className="p-2 bg-cyan-500/10 rounded-lg text-cyan-400">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                    </div>
                    <div>
                        <h3 className="font-bold text-sm text-gray-200">STREAM QUALITY</h3>
                        <p className="text-xs text-gray-500 font-mono mt-0.5">
                            {config.resolution} • {config.frameRate}FPS • {String(config.codec).toUpperCase()}
                        </p>
                    </div>
                </div>
                <svg
                    className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {/* Settings Body */}
            {isExpanded && (
                <div className="p-4 space-y-6 animate-fade-in border-t border-white/5">

                    {/* Resolution */}
                    <div>
                        <Label text="RESOLUTION" />
                        <div className="grid grid-cols-3 gap-2">
                            {resolutionOptions.map(opt => (
                                <OptionBtn
                                    key={opt.value}
                                    active={config.resolution === opt.value}
                                    label={opt.label}
                                    sub={opt.sub}
                                    onClick={() => update('resolution', opt.value)}
                                    disabled={disabled}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Frame Rate */}
                    <div>
                        <Label text="FRAMERATE" />
                        <div className="grid grid-cols-3 gap-2">
                            {frameRateOptions.map(opt => (
                                <OptionBtn
                                    key={opt.value}
                                    active={config.frameRate === opt.value}
                                    label={opt.label}
                                    sub={opt.sub}
                                    onClick={() => update('frameRate', opt.value)}
                                    disabled={disabled}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Bitrate */}
                    <div>
                        <Label text="BITRATE LIMIT" />
                        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                            {bitrateOptions.map(opt => (
                                <OptionBtn
                                    key={String(opt.value)}
                                    active={config.bitrate === opt.value}
                                    label={opt.label}
                                    sub={opt.sub}
                                    onClick={() => update('bitrate', opt.value)}
                                    disabled={disabled}
                                    compact
                                />
                            ))}
                        </div>
                    </div>

                    {/* Advanced Row */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Codec */}
                        <div>
                            <Label text="CODEC" />
                            <div className="grid grid-cols-3 gap-2">
                                {codecOptions.slice(0, 3).map(opt => (
                                    <OptionBtn
                                        key={opt.value}
                                        active={config.codec === opt.value}
                                        label={opt.label}
                                        onClick={() => update('codec', opt.value)}
                                        disabled={disabled}
                                        compact
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Mode */}
                        <div>
                            <Label text="OPTIMIZATION" />
                            <div className="grid grid-cols-2 gap-2">
                                {contentHintOptions.map(opt => (
                                    <OptionBtn
                                        key={opt.value}
                                        active={config.contentHint === opt.value}
                                        label={opt.label}
                                        sub={opt.sub}
                                        onClick={() => update('contentHint', opt.value)}
                                        disabled={disabled}
                                        compact
                                    />
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Bandwidth Estimation */}
                    <div className="mt-4 p-3 rounded-lg bg-white/5 border border-white/5 flex justify-between items-center text-xs font-mono">
                        <span className="text-gray-500">EST. BANDWIDTH</span>
                        <span className="text-cyan-400 font-bold">{estimateBandwidth(config)}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// Sub-components
const Label = ({ text }: { text: string }) => (
    <div className="text-[10px] font-bold text-gray-500 tracking-widest uppercase mb-2 ml-1">{text}</div>
);

interface OptionBtnProps {
    active: boolean;
    label: string;
    sub?: string;
    onClick: () => void;
    disabled: boolean;
    compact?: boolean;
}

const OptionBtn = ({ active, label, sub, onClick, disabled, compact }: OptionBtnProps) => (
    <button
        onClick={onClick}
        disabled={disabled}
        className={`relative group flex flex-col items-center justify-center text-center rounded-lg border transition-all duration-200 overflow-hidden ${compact ? 'py-2 px-1' : 'py-3 px-2'
            } ${active
                ? 'bg-cyan-500/20 border-cyan-500 text-white shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                : 'bg-black/30 border-white/5 text-gray-400 hover:bg-white/5 hover:border-white/20 hover:text-gray-200'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
        <span className={`font-bold ${compact ? 'text-xs' : 'text-sm'}`}>{label}</span>
        {sub && <span className={`text-[9px] mt-0.5 ${active ? 'text-cyan-200' : 'text-gray-600 group-hover:text-gray-500'}`}>{sub}</span>}
    </button>
);

function estimateBandwidth(config: QualityConfig): string {
    if (config.bitrate === 0) return 'UNLIMITED';
    if (config.bitrate !== 'auto') return `${(config.bitrate / 1000).toFixed(1)} Mbps`;
    const baseRate = config.resolution === 'native' ? 5000 : config.resolution === '1080p' ? 3000 : 1500;
    const fpsMultiplier = config.frameRate / 30;
    return `~${((baseRate * fpsMultiplier) / 1000).toFixed(1)} Mbps`;
}

export function saveQualityConfig(config: QualityConfig): void {
    localStorage.setItem('p2d_quality_config', JSON.stringify(config));
}

export function loadQualityConfig(): QualityConfig {
    try {
        const saved = localStorage.getItem('p2d_quality_config');
        if (saved) return { ...defaultQualityConfig, ...JSON.parse(saved) };
    } catch { }
    return defaultQualityConfig;
}
