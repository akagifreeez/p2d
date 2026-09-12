/**
 * P2D - 接続履歴 (F-013)
 * ローカル限定の参加履歴。localStorageに直近MAX件を保持する。
 */

export interface RecentRoom {
    code: string;
    at: number; // 参加時刻 (epoch ms)
}

const KEY = 'p2d-recent-rooms';
const MAX = 8;

export function getRecentRooms(): RecentRoom[] {
    try {
        const raw = localStorage.getItem(KEY);
        const list = raw ? (JSON.parse(raw) as RecentRoom[]) : [];
        return Array.isArray(list) ? list.filter(r => r && typeof r.code === 'string') : [];
    } catch {
        return [];
    }
}

export function addRecentRoom(code: string): void {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    const list = getRecentRooms().filter(r => r.code !== trimmed);
    list.unshift({ code: trimmed, at: Date.now() });
    try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch {
        // ignore
    }
}

export function clearRecentRooms(): void {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // ignore
    }
}
