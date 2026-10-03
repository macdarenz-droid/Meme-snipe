import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_PREVIEW=1 is set only for the APK build (pnpm build:preview). Defining it here, even when
// unset, makes it a build-time constant, so the sample screen is dropped from a normal build.
const preview = process.env['VITE_PREVIEW'] === '1' ? '1' : '';

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_PREVIEW': JSON.stringify(preview) },
  build: { target: 'es2022', sourcemap: false },
});
