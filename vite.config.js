import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The React app lives in client/ and is built into dist/, which the Express server (and Netlify) serve.
// `npm run dev:client` runs it with hot reload on :5173 and sends /api calls to the server on :3000.
export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
