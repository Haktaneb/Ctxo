import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['e2e/__tests__/**/*.test.ts'],
    testTimeout: 120_000,
    // No e2e test exists until a later task adds one; the CI step must still pass.
    passWithNoTests: true,
  },
});
