import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  // `npm run dev` serves the app; `npm run dev:api` runs the worker beside it.
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: true } },
  },
  // `vite preview` inherits server.proxy unless told otherwise, which would quietly
  // connect a build meant to be tested standalone to whatever worker is running.
  preview: { proxy: {} },
});
