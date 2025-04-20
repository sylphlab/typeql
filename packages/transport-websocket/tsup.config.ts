import { defineConfig } from 'tsup';

export default defineConfig({
  format: ['esm', 'cjs'], // Output both ESM and CJS formats
  entry: ['src/transport.ts'], // Entry point, adjust if index.ts is added
  dts: true, // Generate declaration files (.d.ts)
  splitting: false, // Keep code in single file per format
  sourcemap: true, // Generate sourcemaps
  clean: true, // Clean output directory before build
  external: [
    // Mark workspace dependencies as external
    /^@sylphlab\/.*/,
    // Mark potential Node.js specific dependencies as external if needed
    'ws',
  ],
});
