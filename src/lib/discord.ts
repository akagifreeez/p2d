/**
 * P2D - Discord Rich Presence 連携 (F-050/F-051)
 *
 * クライアントIDの解決: 起動引数 (--p2d-discord-client-id=) > localStorage (設定画面)。
 * 未設定なら何もしない。Discord未起動時のIPC失敗はRust側で握りつぶされるためUIに影響しない。
 */

import { invoke } from '@tauri-apps/api/core';

const LS_KEY = 'p2d-discord-client-id';

export function getStoredDiscordClientId(): string {
    return (localStorage.getItem(LS_KEY) || '').trim();
}

export function setStoredDiscordClientId(id: string): void {
    localStorage.setItem(LS_KEY, id.trim());
}

/** 起動引数 → localStorage の順でクライアントIDを解決する */
export async function resolveDiscordClientId(): Promise<string | null> {
    try {
        const cfg = await invoke<{ clientId: string | null }>('get_discord_config');
        if (cfg.clientId && cfg.clientId.trim()) return cfg.clientId.trim();
    } catch {
        // ignore
    }
    return getStoredDiscordClientId() || null;
}

export interface PresenceInfo {
    roomCode: string;
    /** 「画面共有中」「ルーム待機中」など短い説明 */
    details: string;
    /** 自分を除く参加者数 */
    viewers: number;
}

let startTs: number | null = null;

/** プレゼンスを更新する (ルーム入室中・参加者数変更・共有ON/OFF時に呼ぶ) */
export async function updatePresence(clientId: string | null, info: PresenceInfo): Promise<void> {
    if (!clientId) return;
    if (startTs === null) startTs = Math.floor(Date.now() / 1000);
    try {
        await invoke('discord_set_presence', {
            clientId,
            roomCode: info.roomCode,
            details: info.details,
            viewers: info.viewers,
            startTs,
        });
    } catch {
        // ignore
    }
}

/** プレゼンスをクリアする (退出時) */
export async function clearPresence(): Promise<void> {
    startTs = null;
    try {
        await invoke('discord_clear_presence');
    } catch {
        // ignore
    }
}
