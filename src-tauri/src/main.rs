// P2D - メインプロセス
// Tauriアプリケーションのエントリーポイント

// デフォルトのコマンドラインウィンドウを非表示（Windows）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    p2d_lib::run()
}
