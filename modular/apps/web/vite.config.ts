import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: { dedupe: ["solid-js"] },
  server: { proxy: { "/api": "http://127.0.0.1:3174" } },
})
