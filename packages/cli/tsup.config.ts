import { defineConfig } from 'tsup';

export default defineConfig({
  // `internal` is the `@ctxo/cli/internal` entry (ADR-018); splitting shares the code both entries use.
  entry: { index: 'src/index.ts', internal: 'src/internal.ts' },
  splitting: true,
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: [
    'tree-sitter',
    'tree-sitter-go',
    'tree-sitter-c-sharp',
    'graphology',
    'graphology-communities-louvain',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
