// P2D - システム音声キャプチャ (F-031: システム音声共有)
// Windows WASAPI ループバック (cpal) で出力デバイスの音を取得し、
// Int16 PCM を base64 文字列チャンクとしてフロントエンドへストリーミングする。
//
// cpal::Stream は WASAPI では !Send のため、生成と保持を専用スレッド内に閉じ込め、
// 停止はチャネル経由のシグナルで行う (Stream を state 間で移動させない)。
// フロント側の詳細は src/lib/systemAudio.ts を参照。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};

/// 送出チャンクの閾値 (インターリーブ済みサンプル数)。
/// 48kHz/2ch で 1920 サンプル = 約20msごとに1送信。
const CHUNK_SAMPLES: usize = 1920;

/// 実行中キャプチャの停止ハンドル。Stream 自体はスレッド内に留める。
pub struct AudioCaptureState(pub Mutex<Option<StopHandle>>);

pub struct StopHandle {
    stop_tx: mpsc::Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemAudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
}

pub fn get_config() -> Result<SystemAudioConfig, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("既定の出力デバイスが見つかりません")?;
    let name = device
        .name()
        .unwrap_or_else(|_| "Unknown Output".to_string());
    // ループバックは「出力デバイスを入力として開く」形で行うため、
    // 設定も出力側 (ミックスフォーマット) から取得する。
    // build_input_stream は eRender デバイスに自動で LOOPBACK フラグを立てる。
    let config = device
        .default_output_config()
        .map_err(|e| format!("出力デバイスのフォーマット取得に失敗しました: {e}"))?;
    Ok(SystemAudioConfig {
        sample_rate: config.sample_rate().0,
        channels: config.channels(),
        device_name: name,
    })
}

pub fn start(
    on_data: Channel<String>,
    state: State<'_, AudioCaptureState>,
) -> Result<SystemAudioConfig, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "キャプチャ状態のロックに失敗しました")?;
    if guard.is_some() {
        return Err("システム音声のキャプチャは既に実行中です".to_string());
    }

    // 準備完了/失敗の通知チャネルと停止シグナル
    let (ready_tx, ready_rx) = mpsc::channel::<Result<SystemAudioConfig, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let channel_cb = on_data;

    // 20ms分ずつまとめるバッファ (音声スレッドと IPC の間の平滑化)
    let pending: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(CHUNK_SAMPLES * 2)));

    let handle = std::thread::spawn(move || {
        let host = cpal::default_host();
        let run = || -> Result<SystemAudioConfig, String> {
            let device = host
                .default_output_device()
                .ok_or("既定の出力デバイスが見つかりません")?;
            let name = device
                .name()
                .unwrap_or_else(|_| "Unknown Output".to_string());
            let config = device
                .default_output_config()
                .map_err(|e| format!("出力デバイスのフォーマット取得に失敗しました: {e}"))?;
            let info = SystemAudioConfig {
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
                device_name: name,
            };

            let pending_cb = pending.clone();
            let stream = device
                .build_input_stream(
                    &config.config(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut buf = match pending_cb.lock() {
                            Ok(b) => b,
                            Err(_) => return, // 音声スレッドではパニックしない
                        };
                        for &s in data {
                            let clamped = s.clamp(-1.0, 1.0);
                            buf.push((clamped * 32767.0) as i16);
                        }
                        if buf.len() >= CHUNK_SAMPLES {
                            let bytes: Vec<u8> =
                                buf.iter().flat_map(|v| v.to_le_bytes()).collect();
                            buf.clear();
                            let _ = channel_cb.send(BASE64.encode(&bytes));
                        }
                    },
                    |e| eprintln!("[AudioCapture] stream error: {e}"),
                    None,
                )
                .map_err(|e| format!("キャプチャストリームの作成に失敗しました: {e}"))?;

            stream
                .play()
                .map_err(|e| format!("キャプチャの開始に失敗しました: {e}"))?;
            Ok(info)
        };

        match run() {
            Ok(info) => {
                let _ = ready_tx.send(Ok(info));
                // 停止シグナル待ち。Stream はこのスレッドで drop する
                let _ = stop_rx.recv();
                println!("[AudioCapture] system audio loopback stopped");
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });

    let info = match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(info)) => info,
        Ok(Err(e)) => {
            let _ = stop_tx.send(());
            if let Some(h) = handle.join().ok() {
                let _ = h;
            }
            return Err(e);
        }
        Err(_) => {
            let _ = stop_tx.send(());
            return Err("キャプチャの初期化がタイムアウトしました".to_string());
        }
    };

    *guard = Some(StopHandle {
        stop_tx,
        handle: Some(handle),
    });

    println!(
        "[AudioCapture] system audio loopback started ({}Hz / {}ch)",
        info.sample_rate, info.channels
    );
    Ok(info)
}

pub fn stop(state: State<'_, AudioCaptureState>) -> Result<(), String> {
    let handle = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "キャプチャ状態のロックに失敗しました")?;
        guard.take()
    };
    if let Some(mut stop_handle) = handle {
        let _ = stop_handle.stop_tx.send(());
        if let Some(h) = stop_handle.handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// このマシンでループバック取得の設定が解決できるか
    #[test]
    fn loopback_config_resolves() {
        let cfg = get_config().expect("ループバック設定の解決に失敗");
        assert!(cfg.sample_rate > 0);
        assert!(cfg.channels > 0);
        println!(
            "[test] loopback: {}Hz / {}ch / {}",
            cfg.sample_rate, cfg.channels, cfg.device_name
        );
    }

    /// ループバックストリームが実際に構築・再生できるか (API経路の実走確認)
    #[test]
    fn loopback_stream_builds_and_plays() {
        let host = cpal::default_host();
        let device = host.default_output_device().expect("出力デバイスなし");
        let config = device
            .default_output_config()
            .expect("フォーマット取得に失敗");

        let got_samples = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = got_samples.clone();
        let stream = device
            .build_input_stream(
                &config.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    counter.fetch_add(data.len(), std::sync::atomic::Ordering::Relaxed);
                },
                |e| eprintln!("[test] stream error: {e}"),
                None,
            )
            .expect("ループバックストリームの構築に失敗");
        stream.play().expect("ストリームの再生に失敗");

        std::thread::sleep(Duration::from_millis(300));
        let n = got_samples.load(std::sync::atomic::Ordering::Relaxed);
        println!("[test] received {n} samples in 300ms (無音時は0でも可)");
        drop(stream);
    }
}
