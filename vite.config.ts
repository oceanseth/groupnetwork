import { defineConfig } from 'vite';

/**
 * Multi-page build, matching the layout oceanseth/masky uses: each top-level
 * HTML file is its own entry, so the landing page never ships the app bundle.
 *
 *   index.html  the public marketing page
 *   join.html   sign-in, the Masky OAuth redirect target, and onboarding
 *   app.html    the signed-in application
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html',
        join: './join.html',
        app: './app.html',
      },
      output: {
        // three is large and only the landing page needs it; keeping it in its
        // own chunk stops it from being pulled into the app bundle.
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: {
    port: 5173,
  },
});
