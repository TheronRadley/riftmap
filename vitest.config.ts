import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
  resolve: {
    // Workspace packages are consumed as TypeScript sources during tests.
    preserveSymlinks: false,
  },
});
