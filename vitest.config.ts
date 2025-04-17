import { defineConfig } from 'vitest/config';
// import tsconfigPaths from 'vite-tsconfig-paths'; // Remove conflicting plugin import
import path from 'path'; // Import path - Keep import if needed elsewhere, otherwise remove

export default defineConfig({
  // plugins: [], // Ensure plugins array is empty or remove if not needed
  // resolve: { alias: {...} }, // Remove alias configuration
  test: {
    environment: 'jsdom', // Keep jsdom environment
    globals: true, // Optional: enable global APIs like describe, it, expect
    testTimeout: 30000, // Set a 30-second timeout for each test
    hookTimeout: 30000, // Set a 30-second timeout for hooks (beforeEach, etc.)
    fakeTimers: {
      // Configure fake timers if needed, e.g., to advance time automatically
      // advanceTime: true,
    },
    poolOptions: {
      threads: {
        // singleThread: true // Remove single-threaded constraint
      }
    },
    // Add any other global configurations needed
    coverage: {
      provider: 'v8', // or 'istanbul'
      reporter: ['text', 'json', 'html'], // Choose reporters
      // include: ['src/**/*.{ts,tsx}'], // Specify files to include
      // exclude: ['src/__tests__/**'], // Specify files to exclude
      // thresholds: { // Optional: Set coverage thresholds
      //   lines: 80,
      //   functions: 80,
      //   branches: 80,
      //   statements: 80,
      // },
    },
  },
  // threads: false, // Incorrect placement
});