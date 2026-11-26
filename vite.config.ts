import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const engine = `http://localhost:${process.env.ENGINE_PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { port: 5173, proxy: { '/ws': { target: engine, ws: true } } },
});
