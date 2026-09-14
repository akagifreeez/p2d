/**
 * リレー停滞ウォッチドッグの単体テスト (配信木計画書 §7 / M5 フェーズA)
 * 実行: node --import tsx --test --test-force-exit test/relayWatchdog.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initWatchdogState, noteActivity, disarmWatchdog, checkWatchdog, noteSwitch,
    WATCHDOG_DEFAULTS, type WatchdogState,
} from '../src/lib/relayWatchdog.js';

const T0 = 1_000_000_000_000;
const D = WATCHDOG_DEFAULTS;

function armed(at: number): WatchdogState {
    // メディアを1回受けた直後の状態 (監視アリ)
    return noteActivity({ ...initWatchdogState(at), phase: 'watching' }, at);
}

test('メディア受信直後・無音4秒未満は何もしない', () => {
    let st = armed(T0);
    const r = checkWatchdog(st, T0 + D.tickStaleMs - 1);
    assert.equal(r.action, 'none');
    assert.equal(r.state.phase, 'watching');
});

test('無音4秒で停滞検知 → parent_lost送信、3秒毎に再送', () => {
    let st = armed(T0);
    let r = checkWatchdog(st, T0 + D.tickStaleMs);
    assert.equal(r.action, 'notify_parent_lost');
    assert.equal(r.state.pendingSince, T0 + D.tickStaleMs);
    assert.equal(r.state.pendingAttempts, 1);
    st = r.state;

    // 再送間隔未満では送らない
    r = checkWatchdog(st, T0 + D.tickStaleMs + 1000);
    assert.equal(r.action, 'none');
    // 間隔到達で再送 (attempts増)
    r = checkWatchdog(st, T0 + D.tickStaleMs + D.retryIntervalMs);
    assert.equal(r.action, 'notify_parent_lost');
    assert.equal(r.state.pendingAttempts, 2);
});

test('停滞解消 (メディア再開) でpending解除・復帰', () => {
    let st = armed(T0);
    st = checkWatchdog(st, T0 + D.tickStaleMs).state; // 発動
    assert.equal(st.pendingSince !== 0, true);
    st = noteActivity(st, T0 + D.tickStaleMs + 500); // メディア再開
    assert.equal(st.pendingSince, 0);
    const r = checkWatchdog(st, T0 + D.tickStaleMs + 1000);
    assert.equal(r.action, 'none');
});

test('ギブアップ: 再割当が12秒来なければ強制再接続を指示', () => {
    let st = armed(T0);
    st = checkWatchdog(st, T0 + D.tickStaleMs).state; // 発動 (pendingSince=T0+4s)
    const giveUpAt = st.pendingSince! + D.giveUpMs;
    const r = checkWatchdog(st, giveUpAt);
    assert.equal(r.action, 'force_reconnect');
    assert.equal(r.state.lastSwitchAt, giveUpAt, '強制再接続も切替として記録');
    assert.equal(r.state.pendingSince, 0);
    // 直後はクールダウン中なので、停滞していても発動しない
    st = noteActivity(r.state, giveUpAt + 1000); // 再接続後もしばらく無音
    const r2 = checkWatchdog(st, giveUpAt + 1000 + D.tickStaleMs);
    assert.equal(r2.action, 'none', 'クールダウン中は発動を見送る');
});

test('クールダウン明けは再び発動できる', () => {
    let st = armed(T0);
    st = checkWatchdog(st, T0 + D.tickStaleMs).state; // 発動
    st = noteSwitch(st, T0 + 40_000); // 切替 (T0+40s)
    // クールダウン中 (切替から30秒): T0+54sに無音4秒 → 切替から14秒なので見送り
    st = noteActivity(st, T0 + 50_000);
    let r = checkWatchdog(st, T0 + 54_000);
    assert.equal(r.action, 'none', '切替後30秒内は見送り');
    assert.equal(r.state.phase, 'stalled');
    // クールダウン明け (切替から30秒超): 再発動
    r = checkWatchdog(st, T0 + 71_000);
    assert.equal(r.action, 'notify_parent_lost');
});

test('share_state解除で監視オフ、何があっても発動しない', () => {
    let st = armed(T0);
    st = disarmWatchdog(st, T0 + 1000);
    assert.equal(st.phase, 'idle');
    const r = checkWatchdog(st, T0 + 60_000);
    assert.equal(r.action, 'none');
});

test('join直後 (未受信) は監視しない', () => {
    const st = initWatchdogState(T0);
    const r = checkWatchdog(st, T0 + 60_000);
    assert.equal(r.action, 'none');
});
