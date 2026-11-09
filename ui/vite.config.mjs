import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {viteSingleFile} from "vite-plugin-singlefile";
import path from "node:path";

export function localApiProxy(target = "http://127.0.0.1:4187") {
  const upstreamOrigin = new URL(target).origin;
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (outgoing, request) => {
        const port = request.socket.localPort;
        const host = request.headers.host;
        const localHost = host === "127.0.0.1:" + port || host === "localhost:" + port;
        const sameOrigin = localHost && request.headers.origin === "http://" + host;
        // Rewrite a verified dev-page origin only. The backend rejects all other POSTs.
        outgoing.setHeader("Origin", sameOrigin ? upstreamOrigin : "null");
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {"@": path.resolve(import.meta.dirname, "src")}},
  server: {
    host: "127.0.0.1",
    port: 4188,
    strictPort: true,
    proxy: {"/api": localApiProxy()}
  },
  build: {outDir: "../dist-v2", emptyOutDir: true}
});
