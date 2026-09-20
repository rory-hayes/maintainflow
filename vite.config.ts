import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {pdfJsRenderErrors} from './scripts/pdfjs-render-errors.ts';

export default defineConfig({
  plugins: [pdfJsRenderErrors(),react()],
  // Keep development on the same guarded PDF.js transform as production builds.
  optimizeDeps: {exclude:['pdfjs-dist']},
  server: { host: '127.0.0.1', port: 5178, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } },
  build: { sourcemap: true },
});
