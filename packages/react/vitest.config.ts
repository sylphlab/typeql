import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../vitest.config'; // Adjust path relative to root config

export default mergeConfig(
  viteConfig, // Inherit from the root config
  defineConfig({
    test: {
      environment: 'jsdom', // Set the environment to jsdom for React component testing
      globals: true, // Use global APIs (describe, it, expect, etc.)
      setupFiles: [], // Add setup files if needed (e.g., './test/setup.ts')
    },
  })
);