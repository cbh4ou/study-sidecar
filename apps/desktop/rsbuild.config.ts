import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/main.tsx" }, define: { "window.__SIDECAR_TOKEN__": JSON.stringify(process.env.SIDECAR_TOKEN ?? ""), "window.__SIDECAR_PORT__": JSON.stringify(process.env.SIDECAR_PORT ?? "4321") } },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  html: { template: "./index.html" },
});
