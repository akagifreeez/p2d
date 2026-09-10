use tauri::command;
use xcap::{Monitor, Window};
use serde::{Serialize, Deserialize};
use std::io::Cursor;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::DynamicImage;

#[derive(Serialize, Deserialize, Debug)]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    pub thumbnail_base64: String, // Data URL (image/png)
    pub is_monitor: bool,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

#[command]
pub async fn get_capture_sources() -> Result<Vec<CaptureSource>, String> {
    let tasks = {
        let mut tasks = Vec::new();

        // 1. Monitors
        let monitors = Monitor::all().map_err(|e| e.to_string())?;
        for monitor in monitors {
            let monitor_id = monitor.id().map_err(|e| e.to_string())?.to_string();
            
            tasks.push(tokio::task::spawn_blocking(move || {
                let monitors = Monitor::all().map_err(|e| e.to_string())?;
                let monitor = monitors.into_iter().find(|m| m.id().map(|id| id.to_string()).unwrap_or_default() == monitor_id)
                    .ok_or_else(|| format!("Monitor {} not found in task", monitor_id))?;

                let img = monitor.capture_image().map_err(|e| e.to_string())?;
                
                let aspect_ratio = img.width() as f32 / img.height() as f32;
                let thumb_width = 300;
                let thumb_height = (thumb_width as f32 / aspect_ratio) as u32;
                
                let thumb = image::imageops::thumbnail(&img, thumb_width, thumb_height);
                
                let mut buf = Vec::new();
                let mut cursor = Cursor::new(&mut buf);
                // JPEGはRGBAをサポートしていないため、RGBに変換して書き込む
                DynamicImage::ImageRgba8(thumb).to_rgb8().write_to(&mut cursor, image::ImageFormat::Jpeg).map_err(|e: image::ImageError| e.to_string())?;
                
                let b64 = BASE64.encode(&buf);
                
                Ok::<CaptureSource, String>(CaptureSource {
                    id: monitor.id().map_err(|e| e.to_string())?.to_string(),
                    name: monitor.name().map_err(|e| e.to_string())?,
                    thumbnail_base64: format!("data:image/jpeg;base64,{}", b64),
                    is_monitor: true,
                    width: monitor.width().map_err(|e| e.to_string())?,
                    height: monitor.height().map_err(|e| e.to_string())?,
                    x: monitor.x().map_err(|e| e.to_string())?,
                    y: monitor.y().map_err(|e| e.to_string())?,
                })
            }));
        }

        // 2. Windows
        let windows = Window::all().map_err(|e| e.to_string())?;
        for window in windows {
            let window_id = window.id().map_err(|e| e.to_string())?.to_string();

            tasks.push(tokio::task::spawn_blocking(move || {
                let windows = Window::all().map_err(|e| e.to_string())?;
                let window = windows.into_iter().find(|w| w.id().map(|id| id.to_string()).unwrap_or_default() == window_id)
                    .ok_or_else(|| format!("Window {} not found in task", window_id))?;

                if window.is_minimized().map_err(|e| e.to_string())? || 
                   window.width().map_err(|e| e.to_string())? < 50 || 
                   window.height().map_err(|e| e.to_string())? < 50 {
                    return Err("Skipping: too small or minimized".to_string());
                }

                let title = window.title().map_err(|e| e.to_string())?;
                if title.is_empty() {
                    return Err("Skipping: no title".to_string());
                }

                let img = window.capture_image().map_err(|e| e.to_string())?;
                
                let aspect_ratio = img.width() as f32 / img.height() as f32;
                let thumb_width = 300;
                let thumb_height = (thumb_width as f32 / aspect_ratio) as u32;
                
                let thumb = image::imageops::thumbnail(&img, thumb_width, thumb_height);
                
                let mut buf = Vec::new();
                let mut cursor = Cursor::new(&mut buf);
                // JPEGはRGBAをサポートしていないため、RGBに変換して書き込む
                DynamicImage::ImageRgba8(thumb).to_rgb8()
                    .write_to(&mut cursor, image::ImageFormat::Jpeg)
                    .map_err(|e: image::ImageError| e.to_string())?;
                
                let b64 = BASE64.encode(&buf);
                
                Ok::<CaptureSource, String>(CaptureSource {
                    id: window.id().map_err(|e| e.to_string())?.to_string(),
                    name: title,
                    thumbnail_base64: format!("data:image/jpeg;base64,{}", b64),
                    is_monitor: false,
                    width: window.width().map_err(|e| e.to_string())?,
                    height: window.height().map_err(|e| e.to_string())?,
                    x: window.x().map_err(|e| e.to_string())?,
                    y: window.y().map_err(|e| e.to_string())?,
                })
            }));
        }
        tasks
    };

    let mut sources = Vec::new();
    for task in tasks.into_iter() {
        match task.await {
            Ok(Ok(src)) => {
                sources.push(src);
            }
            Ok(Err(_)) => {
            }
            Err(_) => {
            }
        }
    }

    Ok(sources)
}

/// シンプルなフレーム取得コマンド - JPEG + Base64で安定動作
#[command]
pub async fn get_source_frame(id: String, is_monitor: bool, width: Option<u32>, height: Option<u32>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // キャプチャ対象を取得
        let img = if is_monitor {
            let monitors = Monitor::all().map_err(|e| e.to_string())?;
            let monitor = monitors.into_iter()
                .find(|m| m.id().map(|mid| mid.to_string()).unwrap_or_default() == id)
                .ok_or_else(|| "Monitor not found".to_string())?;
            monitor.capture_image().map_err(|e| e.to_string())?
        } else {
            let windows = Window::all().map_err(|e| e.to_string())?;
            let window = windows.into_iter()
                .find(|w| w.id().map(|wid| wid.to_string()).unwrap_or_default() == id)
                .ok_or_else(|| "Window not found".to_string())?;
            window.capture_image().map_err(|e| e.to_string())?
        };

        // リサイズ（必要な場合）
        let img_to_encode = if let (Some(w), Some(h)) = (width, height) {
            if img.width() > w || img.height() > h {
                image::imageops::thumbnail(&img, w, h)
            } else {
                img
            }
        } else {
            img
        };

        // JPEG エンコード（RGBに変換が必要）
        let mut buf = Vec::new();
        let rgb_img = DynamicImage::ImageRgba8(img_to_encode).to_rgb8();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 70);
        encoder.encode_image(&rgb_img).map_err(|e| e.to_string())?;

        // Base64 Data URL として返す
        Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(&buf)))
    }).await.map_err(|e| e.to_string())?
}
