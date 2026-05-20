import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

// Vite config tuned for Tauri 2 (desktop + mobile). Key Tauri requirements:
//   - clearScreen: false  → preserve Rust compile output above Vite logs
//   - server.port = 1420  → matches tauri.conf.json devUrl; avoids studio's 5173
//   - server.strictPort   → fail rather than drift to a random port
//   - server.host         → bound to TAURI_DEV_HOST when on a real device
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Don't reload Vite when Rust code changes — that's tauri dev's job.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
}));
