import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { App } from './app';
import './tokens.css';

/**
 * 深链用 hash 路由：静态托管 + 无服务端 rewrite 的降级路径与它同构，
 * 不依赖 SPA 兜底是否开启（PLAN.md §1 路由一行的理由）。
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      // 投影是批更新的，不是逐条写的；陈旧标记按批到达时间才有意义。
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('index.html 缺少 #root');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Router hook={useHashLocation}>
        <App />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
