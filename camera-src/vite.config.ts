import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the camera (QR stream) page into ../camera/ as plain static files for GitHub Pages.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  worker: { format: "es" },
  build: { outDir: "../camera", emptyOutDir: true, target: "es2022" },
});
