import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite config. The Peer Cash SDK talks to public indexer/curator
// APIs, so no server or proxy is needed for this MVP.
export default defineConfig({
  plugins: [react()],
});
