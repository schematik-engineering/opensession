import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "./shared/atomic-write";

export type StableFrontendSnapshot = {
  releaseRoot: string;
  version: string;
  indexHtml: string;
  publishedAt: string;
};

export function stableFrontendSnapshotPath(deployState: string): string {
  return join(deployState, "stable-frontend.json");
}

export function publishStableFrontendSnapshot(
  deployState: string,
  snapshot: Omit<StableFrontendSnapshot, "publishedAt">,
): void {
  writeFileAtomic(
    stableFrontendSnapshotPath(deployState),
    `${JSON.stringify({ ...snapshot, publishedAt: new Date().toISOString() })}\n`,
    0o600,
  );
}

function parseSnapshot(deployState: string): StableFrontendSnapshot | null {
  try {
    const value = JSON.parse(
      readFileSync(stableFrontendSnapshotPath(deployState), "utf8"),
    ) as Partial<StableFrontendSnapshot>;
    if (
      typeof value.releaseRoot !== "string" ||
      typeof value.version !== "string" ||
      typeof value.indexHtml !== "string" ||
      typeof value.publishedAt !== "string"
    ) return null;
    const releases = resolve(deployState, "releases");
    const root = resolve(value.releaseRoot);
    if (!root.startsWith(`${releases}${sep}`) || !existsSync(join(root, ".opensession-release"))) {
      return null;
    }
    return { ...value, releaseRoot: root } as StableFrontendSnapshot;
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  woff2: "font/woff2",
};

function response(
  status: string,
  body: Buffer,
  headers: Record<string, string>,
  head: boolean,
): Buffer {
  const lines = [
    `HTTP/1.1 ${status}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${body.byteLength}`,
    "Connection: close",
    "",
    "",
  ];
  const headBytes = Buffer.from(lines.join("\r\n"));
  return head ? headBytes : Buffer.concat([headBytes, body]);
}

function parsedRequest(request: Buffer): {
  method: "GET" | "HEAD";
  pathname: string;
  acceptsHtml: boolean;
  socialCrawler: boolean;
} | null {
  if (request.byteLength > 64 * 1024) return null;
  const text = request.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const lines = text.slice(0, headerEnd).split("\r\n");
  const match = /^(GET|HEAD) ([^ ]+) HTTP\/1\.[01]$/.exec(lines[0] || "");
  if (!match) return null;
  let pathname: string;
  try {
    pathname = new URL(match[2], "http://localhost").pathname;
  } catch {
    return null;
  }
  const accept = lines.find((line) => /^accept:/i.test(line))?.slice(7).trim() || "";
  const userAgent = lines.find((line) => /^user-agent:/i.test(line))?.slice(11).trim() || "";
  return {
    method: match[1] as "GET" | "HEAD",
    pathname,
    acceptsHtml: accept.includes("text/html") || accept.includes("*/*"),
    socialCrawler: /bot|crawler|spider|slackbot|facebookexternalhit|twitterbot|linkedinbot/i.test(userAgent),
  };
}

const BACKEND_PATH_PREFIXES = [
  "/api/",
  "/ws",
  "/media",
  "/rpc",
  "/run-ws",
  "/rpc-ws",
  "/d/",
];

/**
 * Serve only immutable frontend assets, the SPA document, and liveness while a
 * gateway child is unavailable. API and mutation traffic remains parked for
 * the generation-checked backend; the stable ingress never impersonates it.
 */
export function stableFrontendHttpResponse(
  deployState: string,
  request: Buffer,
): Buffer | null {
  const parsed = parsedRequest(request);
  if (!parsed) return null;
  const head = parsed.method === "HEAD";
  if (parsed.pathname === "/live") {
    return response(
      "200 OK",
      Buffer.from('{"ok":true,"phase":"handoff","backendReady":false}\n'),
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      head,
    );
  }
  if (
    parsed.pathname === "/ready" || parsed.pathname === "/api" ||
    BACKEND_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  ) return null;

  const snapshot = parseSnapshot(deployState);
  if (!snapshot) return null;
  const name = parsed.pathname.slice(1);
  if (name && basename(name) === name) {
    const asset = join(snapshot.releaseRoot, ".frontend-dist", name);
    if (existsSync(asset)) {
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      return response(
        "200 OK",
        readFileSync(asset),
        {
          "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
        head,
      );
    }
  }
  if (
    !parsed.acceptsHtml || parsed.socialCrawler ||
    /\.[a-z0-9]{1,8}$/i.test(parsed.pathname)
  ) return null;
  return response(
    "200 OK",
    Buffer.from(snapshot.indexHtml),
    {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
    head,
  );
}
