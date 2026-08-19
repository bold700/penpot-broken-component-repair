import { defineConfig } from "vite";

// Two entries are built at once: the sandbox code (plugin.js, referenced by
// manifest.json) and the iframe UI (index.html plus its own hashed chunk).
// Naming every entry chunk "plugin.js" would make Rollup rename one of them,
// which is how the manifest ends up pointing at the wrong bundle.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        plugin: "src/plugin.ts",
        index: "index.html",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "plugin" ? "plugin.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
