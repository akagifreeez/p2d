/**
 * ウィンドウ位置管理フック
 * - 終了時に位置を保存
 * - 起動時に位置を復元
 * - モニター間移動をサポート
 */

import { useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface WindowPosition {
    x: number;
    y: number;
    width: number;
    height: number;
    monitor_name: string | null;
}

const STORAGE_KEY = 'p2d_window_position';

export function useWindowPosition() {
    // 位置を保存
    const savePosition = useCallback(async () => {
        try {
            const pos = await invoke<WindowPosition>('get_window_position');
            localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
            console.log('[WindowPosition] Saved:', pos);
        } catch (e) {
            console.error('[WindowPosition] Failed to save:', e);
        }
    }, []);

    // 位置を復元
    const restorePosition = useCallback(async () => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const pos: WindowPosition = JSON.parse(saved);
                await invoke('set_window_position', { pos });
                console.log('[WindowPosition] Restored:', pos);
            }
        } catch (e) {
            console.error('[WindowPosition] Failed to restore:', e);
        }
    }, []);

    // 次のモニターへ移動
    const moveNext = useCallback(async () => {
        try {
            await invoke('move_to_next_monitor');
            console.log('[WindowPosition] Moved to next monitor');
        } catch (e) {
            console.error('[WindowPosition] Failed to move next:', e);
        }
    }, []);

    // 前のモニターへ移動
    const movePrev = useCallback(async () => {
        try {
            await invoke('move_to_prev_monitor');
            console.log('[WindowPosition] Moved to prev monitor');
        } catch (e) {
            console.error('[WindowPosition] Failed to move prev:', e);
        }
    }, []);

    // 起動時に復元、終了時に保存
    useEffect(() => {
        restorePosition();

        // キーボードショートカット (Ctrl + Shift + ArrowLeft/Right)
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.shiftKey) {
                if (e.key === 'ArrowRight') {
                    moveNext();
                } else if (e.key === 'ArrowLeft') {
                    movePrev();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        // ウィンドウクローズ時に保存
        const handleBeforeUnload = () => {
            // 同期的に保存（非同期だとブラウザが待たない可能性）
            const pos = localStorage.getItem(STORAGE_KEY);
            if (pos) {
                // 既に保存済みなら更新
                invoke('get_window_position').then(newPos => {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(newPos));
                });
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        // 定期的に位置を保存（1分ごと）
        const interval = setInterval(savePosition, 60000);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('beforeunload', handleBeforeUnload);
            clearInterval(interval);
            savePosition(); // アンマウント時に保存
        };
    }, [restorePosition, savePosition, moveNext, movePrev]);

    return {
        savePosition,
        restorePosition,
        moveNext,
        movePrev,
    };
}
