import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // Static assets from 001's static directory
      persistState: false,
    }),
  ],
  build: {
    target: "es2022",
    rollupOptions: {
      input: "workers/app.ts",
    },
  },
  publicDir: "static",
});
