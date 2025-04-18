import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Generate declaration files
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: '../../tsconfig.base.json', // Explicitly use base config for DTS context
  external: ['@sylphlab/typeql-shared', 'ws'], // Mark shared and ws as external
})