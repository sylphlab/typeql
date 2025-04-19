import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Enable tsup DTS generation
  splitting: false,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['preact', '@sylphlab/typeql-shared', '@sylphlab/typeql-client'], // Mark internal workspace deps as external
})