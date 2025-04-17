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
    // fakeTimers: {}, // Disable fake timers globally to check for conflicts
    poolOptions: {
      threads: {
        singleThread: true // Keep single-threaded for now
      }
    },
    // Add any other global configurations needed
  },
  // threads: false, // Incorrect placement
});