import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom', // Revert back to jsdom environment
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