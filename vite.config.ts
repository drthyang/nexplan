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
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
