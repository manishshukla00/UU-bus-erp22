import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The React app lives in web/ and builds into dist/, which Express (npm start), Netlify and Vercel serve.
// `npm run dev:web` serves it with hot reload on :5173 and sends /api to the Node server on :3000.
export default defineConfig({
  root: 'web',
  publicDir: '../public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
});
