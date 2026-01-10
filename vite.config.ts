import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],

    // Vite設定（開発時はTauriのdevServerに接続）
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        watch: {
            // WSLを使用している場合のファイル監視最適化
            ignored: ['**/src-tauri/**'],
        },
    },
});
