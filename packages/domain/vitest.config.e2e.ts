import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['e2e/__tests__/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
