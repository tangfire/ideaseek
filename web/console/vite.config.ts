import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端只产出一份静态目录（`dist/`），交给 `prepare_site` 的 `webDirectory`。
 * 业务路由一律挂在 `/functions/v1/app/*`——`/api` 是平台保留命名空间，
 * 见 docs/web-console/SPIKE_SITES_RUNTIME.md §7。
 *
 * dev proxy 指向线上站点，方便本地预览真实数据。网关校验 Origin，
 * 所以代理要把 Origin/Referer 改写成站点地址，否则 POST 一律 403。
 * `ws: true` 是必需的：没有它代理不转发 Upgrade，实时帧在本地根本测不到。
 */
const SITE = 'https://ideaseek-t7xsgawx37d.qoder.zone';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/functions/v1/app': {
        target: SITE,
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', SITE);
            proxyReq.setHeader('referer', `${SITE}/`);
          });
        },
      },
    },
  },
});
