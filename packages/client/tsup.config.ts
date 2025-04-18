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
    resolve: true,
    compilerOptions: {
      composite: false
    }
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  external: ['@sylphlab/typeql-shared'], // Mark shared as external
})