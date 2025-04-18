import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/optimisticStore.ts'
  ],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: {
    entry: 'src/index.ts',
    resolve: true, // Keep resolve: true as it might be needed now
    compilerOptions: {
      composite: false // Keep this false as client doesn't need to be composite itself? Check if needed.
    }
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  external: ['@sylphlab/typeql-shared'], // Mark shared as external
})