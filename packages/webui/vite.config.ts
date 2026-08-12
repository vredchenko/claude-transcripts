import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type UserConfig } from "vite";
import { DEFAULT_WEBAPI_ORIGIN, describeTarget, resolveProxyTarget } from "./dev/webapi-target";

// Loads the repo-root .env (shared with the webapi) for the dev server + proxy.
// The `UserConfig` return annotation is load-bearing: without it the object below is
// only inferred, so the proxy `configure` callback's parameters get no contextual type
// and silently become `any` — including the `res` union this file narrows by hand.
export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  const env = loadEnv(mode, "../../", "");

  // Only when serving: `vite build` has no proxy, and probing a port during a
  // production build would be latency for nothing.
  const target =
    command === "serve"
      ? await resolveProxyTarget({ host: env.WEBAPI_HOST, port: env.WEBAPI_PORT })
      : null;
  if (target) console.log(describeTarget(target));

  return {
    plugins: [react()],
    // Served under /app in production (the combined image); keep dev consistent.
    base: "/app/",
    server: {
      host: env.WEBUI_HOST || "127.0.0.1",
      port: Number(env.WEBUI_PORT || 7651),
      proxy: {
        "/api": {
          // `target` is null only under `vite build`, which never serves this proxy.
          target: target?.origin ?? DEFAULT_WEBAPI_ORIGIN,
          changeOrigin: true,
          // A refused connection reaches the browser as a bare 500 with no body, which
          // looks like the API failed rather than like it was never there. Answer with
          // the diagnosis instead — 502, because the fault is upstream, not in the SPA.
          // Vite runs `configure` before installing its own handler and then checks
          // `headersSent`, so writing here replaces its empty 500 without racing it.
          configure: (proxy) => {
            proxy.on("error", (_err, _req, res) => {
              if (!res || !("writeHead" in res) || res.headersSent || res.writableEnded) return;
              const detail = target ? describeTarget(target) : "webapi unreachable";
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "webapi_unreachable", detail }, null, 2));
            });
          },
        },
      },
    },
    build: { outDir: "dist" },
  };
});
