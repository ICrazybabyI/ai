import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 监听所有地址，允许通过IP访问
    watch: {
      ignored: ['**/dify/**', '**/node_modules/**'], // 排除dify目录和node_modules目录
    },
    proxy: {
      // Dify API代理
      '/v1': {
        target: 'http://192.168.31.245:8888',
        changeOrigin: true,
      },
      // 我们的后端API代理
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // WebSocket代理
      '/ws': {
        target: 'http://localhost:3002',
        ws: true,
        changeOrigin: true,
      },
    },
    hmr: {
      overlay: false, // 禁用错误覆盖层
    },
  },
})