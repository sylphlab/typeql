import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true, // Generate .d.ts files
  splitting: false,
  sourcemap: true,
  clean: true, // Clean dist folder before build
  external: [
    // Mark workspace dependencies as external
    '@sylphlab/typeql-client',
    '@sylphlab/typeql-shared',
  ],
  // Consider adding 'treeshake: true' if applicable later
});