# P2D - 仮アイコン
このディレクトリにはTauriのビルドに必要なアイコンを配置してください。

## 必要なファイル
- 32x32.png
- 128x128.png
- 128x128@2x.png
- icon.icns (macOS)
- icon.ico (Windows)

## 生成方法
実際のアイコン画像を作成後、以下のコマンドで各サイズを生成できます：
```bash
npx tauri icon ./path/to/source-icon.png
```
