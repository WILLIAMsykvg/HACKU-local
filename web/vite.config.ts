import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 浏览器端直接复用 src/ 里的计分和规范化代码
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
