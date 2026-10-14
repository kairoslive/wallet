import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the popup UI. Background/content/inpage scripts are bundled by scripts/build.mjs with esbuild.
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis' },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome114',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { popup: 'popup.html' } },
  },
});
