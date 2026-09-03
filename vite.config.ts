import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发模式经 15924 后端转发访问，HMR websocket 固定直连 5173（后端不代理 ws）
    hmr: { clientPort: 5173 },
    proxy: {
      // 备用：直接访问 5173 时 /api 也转发到后端
      '/api': 'http://127.0.0.1:15924',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
