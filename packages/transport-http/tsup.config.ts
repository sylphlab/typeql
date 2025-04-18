import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: false, // Use tsc --build for declarations
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: '../../tsconfig.base.json', // Explicitly use base config for DTS context
  external: [], // Workspace deps should not be external for DTS
})