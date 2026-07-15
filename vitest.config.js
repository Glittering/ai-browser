import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentOptions: {
      jsdom: {
        runScripts: 'dangerously',
        resources: 'usable',
      },
    },
    testTimeout: 15000,
    include: ['tests/**/*.test.*', 'tests/**/test_*.js'],
  },
});