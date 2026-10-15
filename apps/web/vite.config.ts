import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the UI and API share one origin through this proxy, so session cookies just work.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/socket.io": { target: "http://127.0.0.1:4000", ws: true },
    },
  },
});
