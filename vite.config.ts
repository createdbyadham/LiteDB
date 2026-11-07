import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import path from "path";

/** Serve @xenova/transformers' ONNX wasm from this app instead of jsDelivr. */
function onnxWasm(): Plugin {
  const src = path.resolve("node_modules/@xenova/transformers/dist");
  const files = () => fs.readdirSync(src).filter((name) => name.endsWith(".wasm"));
  return {
    name: "onnx-wasm",
    configureServer(server) {
      server.middlewares.use("/onnx", (req, res, next) => {
        const name = path.basename((req.url || "").split("?")[0]);
        const file = path.join(src, name);
        if (!name.endsWith(".wasm") || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "application/wasm");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({
          type: "asset",
          fileName: `onnx/${name}`,
          source: fs.readFileSync(path.join(src, name)),
        });
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), onnxWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 4. to make use of `TAURI_DEBUG` and other env variables
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: "assets",
    // Tauri supports es2021
    target: process.env.TAURI_PLATFORM == "windows" ? "chrome105" : "safari15",
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
