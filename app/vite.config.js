import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  plugins: [sveltekit()],
  base: "./", // Relative paths for Electron file:// loading
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
