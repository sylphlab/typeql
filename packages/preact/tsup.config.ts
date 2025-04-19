import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: false, // Disable tsup DTS generation, let tsc handle it
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  external: ['preact', '@sylphlab/typeql-shared', '@sylphlab/typeql-client'], // Mark externals
})