import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'happy-dom', // Switch to happy-dom
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      threads: {
        // execArgv: ['--max-old-space-size=8192'], // Keep commented out for now
        // singleThread: true // Re-enable parallel execution
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  }
});