import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The API server's port: PM_PORT from the repo's .env (written by `npm run setup`) or the environment.
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'PM_');
  return {
    plugins: [react()],
    server: {
      host: true,
      proxy: { '/api': `http://localhost:${env.PM_PORT || '8080'}` },
    },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  };
});
