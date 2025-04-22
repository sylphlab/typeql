import { defineConfig } from 'tsup';
import type { Options } from 'tsup'; // Import Options type

// Define base options for reuse
const baseOptions: Options = {
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    '@sylphlab/zen-query-client',
    '@sylphlab/zen-query-shared',
    'preact',
    '@preact/signals-core', // Mark signals as external if used directly
  ],
  // Ensure JSX is handled correctly by esbuild (tsup's underlying bundler)
  // 'jsxFactory' and 'jsxFragment' might not be needed if tsconfig handles it,
  // but explicitly setting them can sometimes resolve issues.
  // jsxFactory: 'h',
  // jsxFragment: 'Fragment',
  // Or rely on tsconfig's jsxImportSource:
  inject: [], // No shims needed if using modern JSX transform
};

export default defineConfig((options) => {
  // Potentially add specific overrides based on options.watch, etc.
  console.log(`Building Preact package (watch: ${options.watch ?? false})...`);
  return {
    ...baseOptions,
    // Example: Add banner in non-watch mode
    // banner: !options.watch ? { js: '"use client";' } : {},
  };
});