/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/ui',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5599',
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
