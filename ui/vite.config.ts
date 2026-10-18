// The UI builds to static files (ui/dist) that the core server serves today, and that an
// Electron or Tauri shell can load later. In dev, Vite proxies /api to the core server.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const CORE = `http://127.0.0.1:${process.env.DESKPILOT_GUI_PORT ?? 4747}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./", // relative asset URLs: works from http://, file:// and custom desktop-shell protocols
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Local app loaded from disk/localhost: one bundle is fine. No inlined assets keeps the CSP strict.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] }, // shared schema in ../src
    proxy: {
      "/api": {
        target: CORE,
        changeOrigin: true, // Host header becomes the core's, which it requires
        // The core refuses foreign Origins; the dev proxy is the trusted hop, so drop the header.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
});
