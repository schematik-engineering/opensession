import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AcpTerminalManager } from "./acp-terminal";

const dirs: string[] = [];

afterEach(() => {
  delete process.env.ACP_TEST_HOST_SECRET;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opensession-acp-terminal-"));
  dirs.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "tool-home");
  mkdirSync(workspace);
  mkdirSync(home);
  return { workspace, home, manager: new AcpTerminalManager(workspace, home) };
}

describe("ACP terminal containment", () => {
  test("rejects cwd traversal outside the workspace", async () => {
    const { manager, home } = fixture();
    await expect(
      manager.createTerminal({
        sessionId: "test-session",
        command: process.execPath,
        args: ["-e", "console.log('no')"],
        cwd: home,
        env: [],
        outputByteLimit: 1_000,
      }),
    ).rejects.toThrow("outside the workspace");
    await manager.close();
  });

  test("uses an isolated HOME and strips host/requested credential variables", async () => {
    const { workspace, home, manager } = fixture();
    process.env.ACP_TEST_HOST_SECRET = "host-must-not-pass";
    const created = await manager.createTerminal({
      sessionId: "test-session",
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({home:process.env.HOME,host:process.env.ACP_TEST_HOST_SECRET,api:process.env.LINEAR_API_KEY,aws:process.env.AWS_ACCESS_KEY_ID,safe:process.env.SAFE_VALUE}))",
      ],
      cwd: workspace,
      env: [
        { name: "LINEAR_API_KEY", value: "request-must-not-pass" },
        { name: "AWS_ACCESS_KEY_ID", value: "aws-must-not-pass" },
        { name: "SAFE_VALUE", value: "visible" },
      ],
      outputByteLimit: 10_000,
    });
    await manager.waitForTerminalExit({
      sessionId: "test-session",
      terminalId: created.terminalId,
    });
    const output = await manager.terminalOutput({
      sessionId: "test-session",
      terminalId: created.terminalId,
    });
    const parsed = JSON.parse(output.output.trim());
    expect(parsed).toEqual({ home, safe: "visible" });
    expect(output.output).not.toContain("must-not-pass");
    await manager.close();
  });

  test("caps output and kills a released process group", async () => {
    const { workspace, manager } = fixture();
    const created = await manager.createTerminal({
      sessionId: "test-session",
      command: process.execPath,
      args: ["-e", "console.log('x'.repeat(5000))"],
      cwd: workspace,
      env: [],
      outputByteLimit: 128,
    });
    await manager.waitForTerminalExit({
      sessionId: "test-session",
      terminalId: created.terminalId,
    });
    const output = await manager.terminalOutput({
      sessionId: "test-session",
      terminalId: created.terminalId,
    });
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(128);
    await manager.releaseTerminal({
      sessionId: "test-session",
      terminalId: created.terminalId,
    });
    await expect(
      manager.terminalOutput({
        sessionId: "test-session",
        terminalId: created.terminalId,
      }),
    ).rejects.toThrow("Unknown ACP terminal");
  });
});
