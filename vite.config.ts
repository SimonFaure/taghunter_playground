import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  resolve: {
    alias: {
      'serialport': '/src/lib/empty-module.js',
      'picocolors': '/src/lib/empty-module.js',
      'node:readline': '/src/lib/empty-module.js',
      'buffer': 'buffer/'
    }
  },
  define: {
    'global': 'globalThis',
  }
}));
