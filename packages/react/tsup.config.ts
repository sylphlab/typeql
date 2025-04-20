import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'], // Entry point
  format: ['esm'], // Output format (ES Module)
  dts: true, // Generate declaration files (.d.ts)
  splitting: false, // Keep code in one file
  sourcemap: true, // Generate sourcemaps
  clean: true, // Clean output directory before build
  external: [
    'react', // Mark react as external (peer dependency)
    '@sylphlab/typeql-client', // Mark workspace packages as external
    '@sylphlab/typeql-shared', // Mark workspace packages as external (if used)
  ],
  // Add banner to specify 'use client' for React Server Components compatibility
  banner: {
    js: "'use client';",
  },
});