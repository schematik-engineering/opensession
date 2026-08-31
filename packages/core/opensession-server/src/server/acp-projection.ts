import {
  chmodSync,
  copyFileSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { RunHostSpec } from "../runner-host/protocol";
import { pickAcpAccount } from "./acp-accounts";
import { isAcpProvider, refreshAcpAuthSource } from "./acp-config";
import {
  acpSessionExhaustedAccounts,
  readAcpAccountBinding,
} from "./acp-state";
import { providerFor } from "./models";

export type AcpRunCredentialProjection =
  | { kind: "not-required"; paths: [] }
  | { kind: "unavailable"; message: string; paths: [] }
  | { kind: "ready"; accountId: string; paths: string[] };

function removeFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

/** Project one pooled ACP credential into a private detached-run directory. */
export async function projectAcpRunCredentials(
  spec: RunHostSpec,
  runDir: string,
): Promise<AcpRunCredentialProjection> {
  const provider = providerFor(spec.model);
  if (!isAcpProvider(provider)) return { kind: "not-required", paths: [] };

  const account = pickAcpAccount(provider, {
    exclude: acpSessionExhaustedAccounts(spec.osSessionId, provider),
    sessionKey: spec.accountAffinityKey || spec.osSessionId,
    accountId:
      spec.accountId || readAcpAccountBinding(spec.osSessionId, provider),
    strict: spec.accountStrict,
    user: spec.user,
  });
  if (!account) {
    return {
      kind: "unavailable",
      message: `${provider} has no usable subscription account`,
      paths: [],
    };
  }

  const authSource = await refreshAcpAuthSource(provider, account.authPath);
  if (!existsSync(authSource)) {
    return {
      kind: "unavailable",
      message: `${provider} subscription authentication is not configured`,
      paths: [],
    };
  }

  const paths: string[] = [];
  try {
    const authDestination = `${runDir}/acp-auth.json`;
    paths.push(authDestination);
    copyFileSync(authSource, authDestination);
    chmodSync(authDestination, 0o600);

    if (account.agentIdPath && existsSync(account.agentIdPath)) {
      const agentIdDestination = `${runDir}/acp-agent-id`;
      paths.push(agentIdDestination);
      copyFileSync(account.agentIdPath, agentIdDestination);
      chmodSync(agentIdDestination, 0o600);
    }

    const accountIdDestination = `${runDir}/acp-account-id`;
    paths.push(accountIdDestination);
    writeFileSync(accountIdDestination, account.id, { mode: 0o600 });
    chmodSync(accountIdDestination, 0o600);
  } catch (error) {
    removeFiles(paths);
    throw error;
  }

  return { kind: "ready", accountId: account.id, paths };
}
