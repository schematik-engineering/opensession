/** Configuration and narrow credential locations for subscription-backed ACP agents. */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "./paths";
import type { Provider } from "./models";

export type AcpProvider = Extract<Provider, "grok" | "cursor">;

interface AcpProviderSettings {
  enabled?: boolean;
  authPath?: string;
  agentIdPath?: string;
}

interface AcpSettingsFile {
  grok?: AcpProviderSettings;
  cursor?: AcpProviderSettings;
}

export interface AcpProviderDefinition {
  id: AcpProvider;
  command: readonly [string, ...string[]];
  authMethod: string;
  authRelativePath: string;
  agentIdRelativePath?: string;
}

export const ACP_PROVIDER_DEFINITIONS: Record<
  AcpProvider,
  AcpProviderDefinition
> = {
  grok: {
    id: "grok",
    command: ["grok", "agent", "stdio"],
    authMethod: "cached_token",
    authRelativePath: ".grok/auth.json",
    agentIdRelativePath: ".grok/agent_id",
  },
  cursor: {
    id: "cursor",
    command: ["cursor-agent", "acp"],
    authMethod: "cursor_login",
    authRelativePath: ".config/cursor/auth.json",
  },
};

let commandOverrides: Partial<
  Record<AcpProvider, readonly [string, ...string[]]>
> = {};

export function acpProviderCommand(
  provider: AcpProvider,
): readonly [string, ...string[]] {
  return (
    commandOverrides[provider] || ACP_PROVIDER_DEFINITIONS[provider].command
  );
}

export function __setAcpProviderCommandForTest(
  provider: AcpProvider,
  command?: readonly [string, ...string[]],
): void {
  if (command) commandOverrides[provider] = command;
  else delete commandOverrides[provider];
}

export const ACP_CONFIG_PATH = stateDir("acp.json");

function settings(): AcpSettingsFile {
  try {
    const parsed = JSON.parse(readFileSync(ACP_CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isAcpProvider(provider: Provider): provider is AcpProvider {
  return provider === "grok" || provider === "cursor";
}

export function acpProviderConfigured(provider: AcpProvider): boolean {
  const config = settings()[provider];
  if (config?.enabled === false) return false;
  return config?.enabled === true && existsSync(acpAuthSource(provider));
}

export function configuredAcpProviders(): Set<AcpProvider> {
  return new Set(
    (["grok", "cursor"] as const).filter((provider) =>
      acpProviderConfigured(provider),
    ),
  );
}

/** Host-side credential source. Never serialized into a run spec. */
export function acpAuthSource(provider: AcpProvider): string {
  return (
    settings()[provider]?.authPath || stateDir(`acp/${provider}/auth.json`)
  );
}

export function acpAgentIdSource(provider: AcpProvider): string | undefined {
  if (provider !== "grok") return undefined;
  return settings().grok?.agentIdPath || stateDir("acp/grok/agent_id");
}

/**
 * A Docker launcher projects credentials into the private run directory. The
 * ACP runner consumes and unlinks these before the first model-visible prompt.
 */
export function projectedAcpBootstrapFiles(): {
  auth: string;
  agentId: string;
} | null {
  const journal = process.env.OPENSESSION_RUN_JOURNAL;
  if (!journal) return null;
  const runDir = dirname(journal);
  return {
    auth: join(runDir, "acp-auth.json"),
    agentId: join(runDir, "acp-agent-id"),
  };
}
