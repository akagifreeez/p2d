import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface CaptureSource {
    id: string;
    name: string;
    thumbnail_base64: string;
    is_monitor: boolean;
    width: number;
    height: number;
    x: number;
    y: number;
}

interface MonitorPickerProps {
    onSelect: (sourceId: string, isMonitor: boolean) => void;
    onCancel: () => void;
    onNativeCapture?: () => void; // ブラウザネイティブキャプチャ用
}

export const MonitorPicker = ({ onSelect, onCancel, onNativeCapture }: MonitorPickerProps) => {
    const [sources, setSources] = useState<CaptureSource[]>([]);
    const [activeTab, setActiveTab] = useState<'screen' | 'window'>('screen');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadSources();
    }, []);

    const loadSources = async () => {
        setIsLoading(true);
        try {
            const res = await invoke<CaptureSource[]>('get_capture_sources');
            setSources(res);
        } catch (e) {
            console.error("Failed to load capture sources:", e);
        } finally {
            setIsLoading(false);
        }
    };

    const filteredSources = sources.filter(s => activeTab === 'screen' ? s.is_monitor : !s.is_monitor);

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-8">
            <div className="glass-panel w-full max-w-5xl h-[80vh] flex flex-col rounded-2xl border border-white/10 shadow-2xl relative overflow-hidden">
                {/* Header */}
                <div className="p-6 border-b border-white/10 flex justify-between items-center bg-black/40">
                    <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
                        Select Screen to Share
                    </h2>
                    <button onClick={onCancel} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                        <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Native Capture Option - Recommended */}
                {onNativeCapture && (
                    <div className="p-4 bg-gradient-to-r from-green-500/10 to-cyan-500/10 border-b border-white/10">
                        <button
                            onClick={onNativeCapture}
                            className="w-full p-4 rounded-xl bg-gradient-to-r from-green-500/20 to-cyan-500/20 border border-green-500/50 hover:border-green-400 hover:shadow-[0_0_25px_rgba(34,197,94,0.3)] transition-all flex items-center justify-center gap-3 group"
                        >
                            <div className="p-2 bg-green-500/20 rounded-lg group-hover:bg-green-500/30 transition-colors">
                                <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                            </div>
                            <div className="text-left">
                                <div className="text-white font-bold text-lg">ブラウザ標準キャプチャを使用</div>
                                <div className="text-green-300 text-sm">⚡ 推奨 - 高FPS・高画質・低負荷</div>
                            </div>
                            <div className="ml-auto">
                                <svg className="w-6 h-6 text-green-400 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                </svg>
                            </div>
                        </button>
                        <p className="text-xs text-gray-400 mt-2 text-center">
                            下の「Screens」「Windows」はカスタムキャプチャ（低速）です
                        </p>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-8 px-8 py-4 border-b border-white/5 bg-white/5">
                    <button
                        onClick={() => setActiveTab('screen')}
                        className={`text-lg font-medium pb-2 transition-colors relative ${activeTab === 'screen' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        Screens
                        {activeTab === 'screen' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]"></div>}
                    </button>
                    <button
                        onClick={() => setActiveTab('window')}
                        className={`text-lg font-medium pb-2 transition-colors relative ${activeTab === 'window' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        Windows
                        {activeTab === 'window' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]"></div>}
                    </button>
                </div>

                {/* Grid */}
                <div className="flex-1 overflow-y-auto p-6 bg-black/20">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-500"></div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                            {filteredSources.map(source => (
                                <div
                                    key={source.id}
                                    className="group relative flex flex-col gap-2 p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 hover:border-cyan-500/50 hover:shadow-[0_0_20px_rgba(6,182,212,0.15)] transition-all cursor-pointer"
                                    onClick={() => onSelect(source.id, source.is_monitor)}
                                >
                                    <div className="aspect-video bg-black/50 rounded-lg overflow-hidden relative">
                                        <img src={source.thumbnail_base64} alt={source.name} className="w-full h-full object-contain" />
                                        <div className="absolute inset-0 bg-cyan-500/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            <span className="bg-black/60 px-4 py-2 rounded-full text-white font-medium backdrop-blur-md">Share</span>
                                        </div>
                                    </div>
                                    <div className="px-1">
                                        <div className="text-white font-medium truncate text-sm" title={source.name}>{source.name}</div>
                                        <div className="text-xs text-gray-500 mt-0.5">{source.width}x{source.height}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 bg-black/40 border-t border-white/10 flex justify-end gap-3 text-sm text-gray-400">
                    <div>Hardware Acceleration: <span className="text-green-400 font-mono">ON (NVENC)</span></div>
                </div>
            </div>
        </div>
    );
};
