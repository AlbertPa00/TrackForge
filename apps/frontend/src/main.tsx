import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.js';
import { applyTheme } from './lib/theme.js';
import './index.css';

// Install the system-scheme change listener (index.html already painted the
// resolved theme; this keeps it in sync when pref is 'system').
applyTheme();

// staleTime>0 lets back-navigation render instantly from cache; the SSE
// stream (api/events.ts) still invalidates anything that actually changes.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
