import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Let tsc handle declaration generation
  splitting: false,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['react', '@sylphlab/typeql-shared', '@sylphlab/typeql-client'], // Mark internal workspace deps as external
})