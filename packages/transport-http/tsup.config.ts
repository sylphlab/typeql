import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: { // Generate declaration files, resolve referenced types
    resolve: true,
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: '../../tsconfig.base.json', // Explicitly use base config for DTS context
  external: ['@sylphlab/typeql-shared'], // Mark shared as external
})