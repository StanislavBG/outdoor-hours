import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Built into bilko.run/projects/outdoor-hours/ as a static-path host.
// Data files live at bilko.run/outdoor-hours/* (synced from outdoor-hours-etl).
export default defineConfig({
  base: '/projects/outdoor-hours/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
