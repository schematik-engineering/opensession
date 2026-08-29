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
import {
  __setAcpAccountsPathForTest,
  addAcpAccountFromHome,
  listAcpAccountsPublic,
  markAcpAccountExhausted,
  pickAcpAccount,
  removeAcpAccount,
  setAcpAccountOwner,
} from "./acp-accounts";

let scratch: string;
let store: string;
let previousStore: string;

function loginHome(provider: "grok" | "cursor", token: string): string {
  const home = join(scratch, `${provider}-${token}`);
  const auth =
    provider === "grok"
      ? join(home, ".grok/auth.json")
      : join(home, ".config/cursor/auth.json");
  mkdirSync(join(auth, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    auth,
    JSON.stringify(
      provider === "grok"
        ? { issuer: { key: token, email: `${token}@example.test` } }
        : { accessToken: token, refreshToken: `refresh-${token}` },
    ),
    { mode: 0o600 },
  );
  chmodSync(auth, 0o600);
  return home;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-acp-accounts-"));
  store = join(scratch, "accounts.json");
  previousStore = __setAcpAccountsPathForTest(store).store;
});

afterEach(() => {
  __setAcpAccountsPathForTest(previousStore);
  rmSync(scratch, { recursive: true, force: true });
});

describe("ACP subscription accounts", () => {
  test("stores multiple private credentials without exposing their paths", () => {
    const first = addAcpAccountFromHome("grok", loginHome("grok", "one"));
    const second = addAcpAccountFromHome("grok", loginHome("grok", "two"), {
      owner: "Jack",
    });
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    const publicAccounts = listAcpAccountsPublic().filter(
      (account) => account.source === "managed",
    );
    expect(publicAccounts).toHaveLength(2);
    expect(publicAccounts.map((account) => account.email).sort()).toEqual([
      "one@example.test",
      "two@example.test",
    ]);
    expect(JSON.stringify(publicAccounts)).not.toContain(scratch);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(store, "utf8"));
    for (const account of persisted.accounts)
      expect(statSync(account.authPath).mode & 0o777).toBe(0o600);
  });

  test("keeps affinity, isolates personal accounts, and rotates a spent account", () => {
    const shared = addAcpAccountFromHome(
      "cursor",
      loginHome("cursor", "shared"),
      { identity: "shared@example.test" },
    );
    const personal = addAcpAccountFromHome(
      "cursor",
      loginHome("cursor", "personal"),
      { identity: "jack@example.test", owner: "Jack" },
    );
    if ("error" in shared || "error" in personal)
      throw new Error("fixture account failed");

    expect(
      pickAcpAccount("cursor", { sessionKey: "same", user: "Jack" })?.id,
    ).toBe(personal.id);
    expect(
      pickAcpAccount("cursor", { sessionKey: "same", user: "Mattia" })?.id,
    ).toBe(shared.id);
    markAcpAccountExhausted(personal.id);
    expect(
      pickAcpAccount("cursor", {
        sessionKey: "same",
        accountId: personal.id,
        user: "Jack",
      })?.id,
    ).toBe(shared.id);
    expect(
      pickAcpAccount("cursor", {
        accountId: personal.id,
        strict: true,
        user: "Jack",
      }),
    ).toBeUndefined();
  });

  test("updates ownership and removes only managed accounts", () => {
    const added = addAcpAccountFromHome(
      "cursor",
      loginHome("cursor", "remove"),
      { identity: "remove@example.test" },
    );
    if ("error" in added) throw new Error(added.error);
    expect(setAcpAccountOwner(added.id, "Mattia")?.owner).toBe("Mattia");
    expect(removeAcpAccount(added.id)).toBe(true);
    expect(removeAcpAccount(added.id)).toBe(false);
  });
});
