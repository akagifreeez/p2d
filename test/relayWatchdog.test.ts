/**
 * リレー停滞ウォッチドッグの単体テスト (配信木計画書 §7 / M5 フェーズA)
 * 実行: node --import tsx --test --test-force-exit test/relayWatchdog.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    initWatchdogState, noteActivity, disarmWatchdog, checkWatchdog, noteSwitch, classifyLink,
    WATCHDOG_DEFAULTS, diagnoseLinkCause, type WatchdogState,
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

test('classifyLink: 無音時間を ok/degraded/stalled に分類する (フェーズB)', () => {
    let st = armed(T0);
    assert.equal(classifyLink(st, T0 + 1000), 'ok');
    assert.equal(classifyLink(st, T0 + D.tickStaleMs / 2), 'degraded', '警告しきい値で黄');
    assert.equal(classifyLink(st, T0 + D.tickStaleMs), 'stalled', '停滞しきい値で赤');
    // 解除済み (共有停止) は idle
    st = disarmWatchdog(st, T0 + 1000);
    assert.equal(classifyLink(st, T0 + 60_000), 'idle');
});

test('diagnoseLinkCause: 配信元高負荷と経路劣化を切り分ける', () => {
    // エンコード周期超過が3tick連続 → 配信元の高負荷
    assert.equal(diagnoseLinkCause({ tickLoadHigh: true, highStreak: 3, hostSentLastSec: 0, receivedLastSec: 0 }), 'host-load');
    // 2tick連続ではまだ判定しない (一瞬のスパイクを誤検知しない)
    assert.equal(diagnoseLinkCause({ tickLoadHigh: true, highStreak: 2, hostSentLastSec: 0, receivedLastSec: 0 }), null);
    // ホストは沢山送っているのに受信が3割未満 → 経路の劣化
    assert.equal(diagnoseLinkCause({ tickLoadHigh: false, highStreak: 0, hostSentLastSec: 200_000, receivedLastSec: 40_000 }), 'route');
    // ホストの送信自体が少ない (静止画の正常系) は経路劣化と判定しない
    assert.equal(diagnoseLinkCause({ tickLoadHigh: false, highStreak: 0, hostSentLastSec: 20_000, receivedLastSec: 1_000 }), null);
    // 受信が送信の3割以上あれば正常
    assert.equal(diagnoseLinkCause({ tickLoadHigh: false, highStreak: 0, hostSentLastSec: 200_000, receivedLastSec: 100_000 }), null);
});
