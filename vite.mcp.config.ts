// The MCP server (src/mcp/main.ts) as one Node module: the science, tables and bundled CIFs inlined (one file, so a
// rebuild never pulls a chunk from under a running server), the MCP SDK and zod imported from node_modules.
// `npm run mcp` builds it and starts it on stdio.
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@materia": fileURLToPath(new URL("./src/materia", import.meta.url)) },
  },
  publicDir: false,
  build: {
    ssr: "src/mcp/main.ts",
    outDir: "dist-mcp",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        entryFileNames: "nexplan-mcp.mjs",
        inlineDynamicImports: true,
        banner: (chunk) => (chunk.isEntry ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});
