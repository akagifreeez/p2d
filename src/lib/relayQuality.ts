/**
 * P2D - WSリレーの品質プリセット管理 (ホスト側のエンコード設定)
 *
 * 設定はlocalStorageに保存し、変更時にイベントを飛ばす。
 * useWebRTCはこのイベントを受けて稼働中のリレーループ/エンコーダを作り直す。
 */

export type RelayQualityKey = 'eco' | 'standard' | 'high';

export interface RelayQualityPreset {
    key: RelayQualityKey;
    label: string;
    /** 送信フレームの最大幅 (px) */
    maxWidth: number;
    /** H264ビットレート (bps) */
    bitrate: number;
    /** フレームレート (fps) */
    fps: number;
    /** JPEGフォールバックの品質 (0-1) */
    jpegQuality: number;
}

export const RELAY_QUALITY_PRESETS: Record<RelayQualityKey, RelayQualityPreset> = {
    eco: { key: 'eco', label: '省データ', maxWidth: 1024, bitrate: 1_000_000, fps: 10, jpegQuality: 0.5 },
    standard: { key: 'standard', label: '標準', maxWidth: 1600, bitrate: 2_500_000, fps: 12, jpegQuality: 0.6 },
    high: { key: 'high', label: '高画質', maxWidth: 1920, bitrate: 5_000_000, fps: 15, jpegQuality: 0.75 },
};

const LS_KEY = 'p2d-relay-quality';

/** 品質変更を通知するイベント名 (useWebRTCが購読してループを作り直す) */
export const RELAY_QUALITY_CHANGED_EVENT = 'p2d-relay-quality-changed';

export function getRelayQualityKey(): RelayQualityKey {
    const saved = localStorage.getItem(LS_KEY) as RelayQualityKey | null;
    return saved && saved in RELAY_QUALITY_PRESETS ? saved : 'standard';
}

export function getRelayQualityPreset(): RelayQualityPreset {
    return RELAY_QUALITY_PRESETS[getRelayQualityKey()];
}

export function setRelayQuality(key: RelayQualityKey): void {
    localStorage.setItem(LS_KEY, key);
    window.dispatchEvent(new CustomEvent(RELAY_QUALITY_CHANGED_EVENT, { detail: key }));
}

/** UIからの変更も同じイベント経路でuseWebRTCへ届くよう統一する */
export function applyRelayQuality(key: RelayQualityKey): void {
    setRelayQuality(key);
}
