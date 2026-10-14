import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'ui',
          include: ['tests/unit/**/*.test.tsx'],
          environment: 'jsdom',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Each file spins up its own local chain; keep them sequential to avoid port/CPU contention.
          fileParallelism: false,
        },
      },
    ],
  },
});
