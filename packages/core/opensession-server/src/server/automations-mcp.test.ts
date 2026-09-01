import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setAcpAccountsPathForTest,
  addAcpAccountFromHome,
} from "./acp-accounts";
import {
  automationBaselineMcpServers,
  automationWorkflowSessionPolicy,
  validateAutomationAccountPin,
} from "./automations";

describe("automation MCP fallback", () => {
  test("rebuilds the complete always-mounted automation-safe set", () => {
    const servers = automationBaselineMcpServers(
      { id: "auto-health", name: "Health Monitor" },
      "os-health-run",
    );

    expect(Object.keys(servers).sort()).toEqual([
      "opensession-audit",
      "opensession-health",
      "opensession-report",
      "opensession-turn",
    ]);
    for (const server of Object.values(servers)) {
      expect(server).toMatchObject({ type: "sdk" });
      expect((server as { instance?: unknown }).instance).toBeTruthy();
    }
  });

  test("durable sessions require a separate repository and Runner policy", () => {
    expect(
      automationWorkflowSessionPolicy({
        id: "auto-renderer",
        name: "Renderer",
        workflows: true,
        workflowSessions: true,
      }),
    ).toBeUndefined();
    expect(
      automationWorkflowSessionPolicy({
        id: "auto-renderer",
        name: "Renderer",
        workflows: true,
        workflowSessions: true,
        workflowSessionRepos: ["renderer"],
        workflowSessionRunners: ["mac-studio"],
      }),
    ).toEqual({
      automationId: "auto-renderer",
      automationName: "Renderer",
      allowedRepos: ["renderer"],
      allowedRunners: ["mac-studio"],
    });
  });

  test("accepts ACP account pins only for their model provider", () => {
    const scratch = mkdtempSync(join(tmpdir(), "automation-acp-pin-"));
    const store = join(scratch, "accounts.json");
    const previousStore = __setAcpAccountsPathForTest(store).store;
    const home = join(scratch, "grok-home");
    const auth = join(home, ".grok", "auth.json");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      auth,
      JSON.stringify({ issuer: { key: "token", email: "test@example.test" } }),
      { mode: 0o600 },
    );
    chmodSync(auth, 0o600);

    try {
      const account = addAcpAccountFromHome("grok", home);
      if ("error" in account) throw new Error(account.error);

      expect(
        validateAutomationAccountPin({
          model: "grok/grok-4.6",
          accountId: account.id,
        }),
      ).toBeNull();
      expect(
        validateAutomationAccountPin({
          model: "cursor/auto",
          accountId: account.id,
        }),
      ).toEqual({
        error: `Model account id "${account.id}" belongs to grok, not cursor`,
      });
      expect(
        validateAutomationAccountPin({
          model: "grok/grok-4.6",
          accountId: "missing-account",
        }),
      ).toEqual({ error: 'Unknown model account id "missing-account"' });
    } finally {
      __setAcpAccountsPathForTest(previousStore);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
