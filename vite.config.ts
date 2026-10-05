/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// GitHub Pages serves from a repo subpath; override with VITE_BASE if needed.
const base = process.env.VITE_BASE ?? "/nexplan/";

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: { "@materia": fileURLToPath(new URL("./src/materia", import.meta.url)) },
  },
  worker: { format: "es" },
  build: {
    // three.js (~540 kB minified) is its own chunk, loaded only with a 3D view; warn about anything larger.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes("/node_modules/three/") ? "three" : undefined) },
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
