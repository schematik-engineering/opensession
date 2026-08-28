import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishStableFrontendSnapshot,
  stableFrontendHttpResponse,
} from "./stable-frontend";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const state = mkdtempSync(join(tmpdir(), "stable-frontend-"));
  roots.push(state);
  const sha = "a".repeat(40);
  const releaseRoot = join(state, "releases", sha);
  mkdirSync(join(releaseRoot, ".frontend-dist"), { recursive: true });
  writeFileSync(join(releaseRoot, ".opensession-release"), `${sha}\n`);
  writeFileSync(join(releaseRoot, ".frontend-dist", "App-hash.js"), "window.loaded = true;");
  publishStableFrontendSnapshot(state, {
    releaseRoot,
    version: "App-hash.js|styles.css",
    indexHtml: '<!doctype html><script src="/App-hash.js"></script>',
  });
  return { state };
}

function request(path: string, accept = "text/html", userAgent = "OS1 test browser"): Buffer {
  return Buffer.from(
    `GET ${path} HTTP/1.1\r\nHost: os.test\r\nAccept: ${accept}\r\nUser-Agent: ${userAgent}\r\n\r\n`,
  );
}

function body(response: Buffer): string {
  return response.toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
}

describe("stable frontend ingress", () => {
  test("serves the last rendered SPA and immutable assets without a gateway", () => {
    const { state } = fixture();
    const page = stableFrontendHttpResponse(state, request("/workspace/demo"));
    expect(page?.toString()).toContain("HTTP/1.1 200 OK");
    expect(body(page!)).toContain("App-hash.js");

    const asset = stableFrontendHttpResponse(
      state,
      request("/App-hash.js", "*/*"),
    );
    expect(asset?.toString()).toContain("Cache-Control: public, max-age=31536000, immutable");
    expect(body(asset!)).toBe("window.loaded = true;");
  });

  test("owns liveness but leaves APIs and unsafe paths to the fenced backend", () => {
    const { state } = fixture();
    expect(body(stableFrontendHttpResponse(state, request("/live", "*/*"))!)).toContain(
      '"phase":"handoff"',
    );
    expect(stableFrontendHttpResponse(state, request("/ready", "*/*"))).toBeNull();
    expect(stableFrontendHttpResponse(state, request("/api/sessions", "application/json"))).toBeNull();
    expect(stableFrontendHttpResponse(state, request("/../secret.js", "*/*"))).toBeNull();
    expect(stableFrontendHttpResponse(
      state,
      request("/session/social-preview", "text/html", "Slackbot-LinkExpanding 1.0"),
    )).toBeNull();
    expect(stableFrontendHttpResponse(
      state,
      Buffer.from("POST /workspace HTTP/1.1\r\nHost: os.test\r\n\r\n"),
    )).toBeNull();
  });
});
