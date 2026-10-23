import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    // Rapier ships a wasm bundle that must not be pre-bundled by esbuild.
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
