import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RunHostSpec } from "../runner-host/protocol";
import {
  __setAcpAccountsPathForTest,
  addAcpAccountFromHome,
} from "./acp-accounts";
import { projectedAcpBootstrapFiles } from "./acp-config";
import { projectAcpRunCredentials } from "./acp-projection";
import { __resetModelCachesForTest } from "./models";

let scratch: string;
let previousStore: string;
let previousJournal: string | undefined;
let previousModel: string | undefined;
let previousStateDir: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-host-acp-"));
  previousStore = __setAcpAccountsPathForTest(
    join(scratch, "accounts.json"),
  ).store;
  previousJournal = process.env.OPENSESSION_RUN_JOURNAL;
  previousModel = process.env.OPENSESSION_MODEL;
  previousStateDir = process.env.OPENSESSION_STATE_DIR;
});

afterEach(() => {
  __setAcpAccountsPathForTest(previousStore);
  if (previousJournal === undefined) delete process.env.OPENSESSION_RUN_JOURNAL;
  else process.env.OPENSESSION_RUN_JOURNAL = previousJournal;
  if (previousModel === undefined) delete process.env.OPENSESSION_MODEL;
  else process.env.OPENSESSION_MODEL = previousModel;
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  __resetModelCachesForTest();
  rmSync(scratch, { recursive: true, force: true });
});

function grokLoginHome(): string {
  const home = join(scratch, "grok-home");
  const auth = join(home, ".grok/auth.json");
  mkdirSync(join(auth, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    auth,
    JSON.stringify({
      "https://auth.x.ai::client-id": {
        key: "current-access-token",
        auth_mode: "oidc",
        refresh_token: "refresh-token",
        expires_at: "2099-01-01T00:00:00.000Z",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-id",
        email: "reviewer@example.test",
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(auth, 0o600);
  writeFileSync(join(home, ".grok/agent_id"), "agent-1", { mode: 0o600 });
  return home;
}

describe("host ACP credential projection", () => {
  test("projects a pooled account before dispatching the detached host", () => {
    const source = readFileSync(
      new URL("./host-client.ts", import.meta.url),
      "utf8",
    );
    const projection = source.indexOf(
      "await projectAcpRunCredentials(spec, dir)",
    );
    const dispatch = source.indexOf("await launchHostViaExecutor(");

    expect(projection).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(projection);
  });

  test("copies one selected Grok account into private per-run files", async () => {
    const account = addAcpAccountFromHome("grok", grokLoginHome());
    if ("error" in account) throw new Error(account.error);
    const runDir = join(scratch, "run");
    mkdirSync(runDir, { mode: 0o700 });
    const spec = {
      hostId: "host-grok-review",
      osSessionId: "os-grok-review",
      prompt: "Review this pull request",
      cwd: scratch,
      model: "grok/grok-code-fast-1",
      accountId: account.id,
    } satisfies RunHostSpec;

    const result = await projectAcpRunCredentials(spec, runDir);

    expect(result.kind).toBe("ready");
    expect(readFileSync(join(runDir, "acp-auth.json"), "utf8")).toContain(
      "current-access-token",
    );
    expect(readFileSync(join(runDir, "acp-agent-id"), "utf8")).toBe("agent-1");
    expect(readFileSync(join(runDir, "acp-account-id"), "utf8")).toBe(
      account.id,
    );
    process.env.OPENSESSION_RUN_JOURNAL = join(runDir, "journal.json");
    expect(projectedAcpBootstrapFiles()?.accountId).toBe(account.id);
    for (const name of ["acp-auth.json", "acp-agent-id", "acp-account-id"]) {
      expect(statSync(join(runDir, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("projects Grok credentials when an unset run model inherits the global default", async () => {
    process.env.OPENSESSION_STATE_DIR = join(scratch, "state");
    process.env.OPENSESSION_MODEL = "grok/grok-4.6";
    __resetModelCachesForTest();
    const account = addAcpAccountFromHome("grok", grokLoginHome());
    if ("error" in account) throw new Error(account.error);
    const runDir = join(scratch, "default-model-run");
    mkdirSync(runDir, { mode: 0o700 });
    const spec = {
      hostId: "host-default-grok-review",
      osSessionId: "os-default-grok-review",
      prompt: "Review this pull request",
      cwd: scratch,
      accountId: account.id,
    } satisfies RunHostSpec;

    const result = await projectAcpRunCredentials(spec, runDir);

    expect(result.kind).toBe("ready");
    expect(readFileSync(join(runDir, "acp-account-id"), "utf8")).toBe(
      account.id,
    );
  });
});
