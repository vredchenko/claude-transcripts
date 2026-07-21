import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Loads the repo-root .env (shared with the webapi) for the dev server + proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");
  const webapiHost = env.WEBAPI_HOST || "127.0.0.1";
  const webapiPort = env.WEBAPI_PORT || "7650";
  return {
    plugins: [react()],
    // Served under /app in production (the combined image); keep dev consistent.
    base: "/app/",
    server: {
      host: env.WEBUI_HOST || "127.0.0.1",
      port: Number(env.WEBUI_PORT || 7651),
      proxy: {
        "/api": { target: `http://${webapiHost}:${webapiPort}`, changeOrigin: true },
      },
    },
    build: { outDir: "dist" },
  };
});
