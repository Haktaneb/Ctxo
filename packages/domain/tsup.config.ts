import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: true,
  external: ['@ctxo/cli', '@ctxo/cli/internal', 'yaml'],
});
