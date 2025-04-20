import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../vitest.config'; // Import root config if it exists and is compatible

export default mergeConfig(
  // If root viteConfig exists and you want to inherit from it:
  // viteConfig ?? {},
  defineConfig({
    test: {
      environment: 'happy-dom', // Use happy-dom environment
      globals: true, // Optional: Use global APIs like describe, it, expect
      setupFiles: ['./test/setup.ts'], // Point to setup file
    },
  })
);