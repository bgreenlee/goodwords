import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The game data lives in public/, which Vite does not content-hash, and the
// deployed files are served with a week of cache. Without this a player who
// visited recently keeps the old dictionary, so an excluded word stays in their
// trie and their missed-words column for up to a week after the deploy. The
// bundle that reads it IS hashed, so stamping the version in at build time is
// enough, and it costs nothing when the data has not changed.
const dataVersion = createHash("sha256")
  .update(readFileSync("public/data/words.txt"))
  .update(readFileSync("public/data/freq.bin"))
  .update(readFileSync("public/data/vocab.json"))
  .digest("hex")
  .slice(0, 12);

export default defineConfig({
  plugins: [react()],
  define: { __DATA_VERSION__: JSON.stringify(dataVersion) },
  build: { target: "es2022" },
  // `npm run dev` serves the app; `npm run dev:api` runs the worker beside it.
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: true } },
  },
  // `vite preview` inherits server.proxy unless told otherwise, which would quietly
  // connect a build meant to be tested standalone to whatever worker is running.
  preview: { proxy: {} },
});
