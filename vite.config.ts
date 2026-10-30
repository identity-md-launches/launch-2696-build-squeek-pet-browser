import { defineConfig } from 'vite';

// Relative base so the export works from any IPFS gateway path or ENS name.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
