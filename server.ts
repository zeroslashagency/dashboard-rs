import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoCollectorRouter } from "./demoCollector.ts";
import { createFleetStoreRouter } from "./fleetStore.ts";

export const DEFAULT_PORT = 3000;
export const COLLECTOR_PORT_DEFAULT = 9994;

export interface ServerConfig {
  tvMode: boolean;
  port: number;
  collectorPort: number;
  demoMode: boolean;
  root: string;
}

export const KIOSK_SNIPPET =
  "<script>document.documentElement.setAttribute('data-tv','1');" +
  "window.__VMC_TV_BOOT__=true;</script>";

function parsePort(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function webDir(base: string): string {
  if (fs.existsSync(path.join(base, "index.html"))) {
    return base;
  }
  return path.join(base, "web");
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = path.dirname(fileURLToPath(import.meta.url)),
): ServerConfig {
  const tvMode = Boolean(env.VMC_TV_ROOT && env.VMC_TV_ROOT.length > 0);
  const envPort =
    parsePort(env.PORT) ??
    (tvMode ? parsePort(env.VMC_TV_PORT) : parsePort(env.VMC_DASH_PORT)) ??
    DEFAULT_PORT;
  const collectorPort =
    parsePort(env.VMC_COLLECTOR_PORT) ??
    parsePort(env.VMC_API_PORT) ??
    COLLECTOR_PORT_DEFAULT;
  const demoMode = env.VMC_DEMO_MODE !== "0" && env.VMC_DEMO_MODE !== "false";
  const root =
    env.VMC_DASH_APP_ROOT && env.VMC_DASH_APP_ROOT.length > 0
      ? webDir(path.resolve(env.VMC_DASH_APP_ROOT))
      : webDir(baseDir);

  return {
    tvMode,
    port: envPort,
    collectorPort,
    demoMode,
    root,
  };
}

export function configJsBody(collectorPort: number, demoMode = true): string {
  const lines = [
    `window.__VMC_COLLECTOR_PORT__ = ${collectorPort};`,
    `window.__VMC_DEMO_MODE__ = ${demoMode ? "true" : "false"};`,
  ];
  if (demoMode) {
    lines.push("window.__VMC_API_BASE__ = window.location.origin;");
  }
  return `${lines.join("\n")}\n`;
}

export function isKioskPath(reqPath: string, tvMode: boolean): boolean {
  if (reqPath === "/tv" || reqPath === "/tv/" || reqPath === "/tv.html") {
    return true;
  }
  return tvMode && (reqPath === "/" || reqPath === "/index.html");
}

export function injectKiosk(html: string): string {
  const idx = html.indexOf("</head>");
  if (idx !== -1) {
    return html.slice(0, idx) + KIOSK_SNIPPET + html.slice(idx);
  }
  return KIOSK_SNIPPET + html;
}

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".mdx": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain",
};

export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function safeJoin(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const normalizedParts = decoded.replace(/\\/g, "/").split("/");
  for (const part of normalizedParts) {
    if (part === "..") return null;
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, decoded.replace(/^\/+/, ""));
  if (
    candidate !== resolvedRoot &&
    !candidate.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return path.join(candidate, "index.html");
    }
  } catch {
    return null;
  }
  return candidate;
}

function sendErrorPage(
  res: Response,
  status: number,
  message: string,
  explain: string,
): void {
  const body =
    `<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n` +
    `        <style type="text/css">\n            :root {\n                color-scheme: light dark;\n            }\n        </style>\n` +
    `        <title>Error response</title>\n    </head>\n    <body>\n` +
    `        <h1>Error response</h1>\n        <p>Error code: ${status}</p>\n` +
    `        <p>Message: ${message}.</p>\n` +
    `        <p>Error code explanation: ${status} - ${explain}.</p>\n    </body>\n</html>\n`;
  res
    .status(status)
    .setHeader("Content-Type", "text/html;charset=utf-8")
    .send(body);
}

export function createApp(cfg: ServerConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Match serve.py / router.rs: every response gets no-store + CORS *.
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Fleet Intelligence persistence (targets, downtime root-cause logs, repair logs)
  const storeBaseDir = path.dirname(fileURLToPath(import.meta.url));
  app.use("/api/fleet", createFleetStoreRouter(storeBaseDir));

  if (cfg.demoMode) {
    app.use("/api", createDemoCollectorRouter());
  }

  app.use((req: Request, res: Response) => {
    const reqPath = req.path;

    // Runtime collector port shim
    if (reqPath === "/config.js" || reqPath === "/js/config.js") {
      res
        .status(200)
        .setHeader("Content-Type", "text/javascript")
        .send(configJsBody(cfg.collectorPort, cfg.demoMode));
      return;
    }

    // TV / kiosk board
    if (isKioskPath(reqPath, cfg.tvMode)) {
      const indexPath = path.join(cfg.root, "index.html");
      try {
        const html = fs.readFileSync(indexPath, "utf8");
        res
          .status(200)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .send(injectKiosk(html));
      } catch {
        sendErrorPage(
          res,
          404,
          "dashboard index not found",
          "Nothing matches the given URI",
        );
      }
      return;
    }

    // Static assets under web/
    const rel =
      reqPath === "/" || reqPath.endsWith("/")
        ? `${reqPath.replace(/^\/+/, "")}index.html`
        : reqPath.replace(/^\/+/, "");

    const target = safeJoin(cfg.root, rel);
    if (!target) {
      sendErrorPage(res, 404, "File not found", "Nothing matches the given URI");
      return;
    }

    try {
      const data = fs.readFileSync(target);
      res.status(200).setHeader("Content-Type", mimeFor(target)).send(data);
    } catch {
      sendErrorPage(res, 404, "File not found", "Nothing matches the given URI");
    }
  });

  return app;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cfg = resolveConfig();
  const mode = cfg.tvMode ? "tv-board" : "dashboard";

  if (!fs.existsSync(path.join(cfg.root, "index.html"))) {
    console.error(
      `vmc-dashboard: WARNING index.html not found under ${cfg.root} — set VMC_DASH_APP_ROOT`,
    );
  }

  const app = createApp(cfg);
  app.listen(cfg.port, "0.0.0.0", () => {
    console.log(
      `vmc-dashboard: serving ${cfg.root} on http://0.0.0.0:${cfg.port} (mode=${mode}, demo=${cfg.demoMode}, collector_port=${cfg.collectorPort})`,
    );
  });
}
