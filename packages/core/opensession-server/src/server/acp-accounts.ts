/**
 * Subscription-account pools for the official Grok and Cursor ACP CLIs.
 *
 * Credentials remain in private provider-native auth files. The JSON pool
 * stores only their host paths and account metadata; public API shapes never
 * expose either the path or credential contents. The original host login is
 * represented as a stable, non-removable account so existing installations
 * continue to work while additional subscriptions are stacked beside it.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { basename, dirname, join } from "path";
import { createHash } from "crypto";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { userMatchesAny } from "./shared/user-mappings";
import { hrwScore } from "./codex-accounts";
import {
  ACP_PROVIDER_DEFINITIONS,
  acpAgentIdSource,
  acpAuthSource,
  type AcpProvider,
} from "./acp-config";

let STORE_PATH = stateDir("acp-accounts.json");
let STATE_PATH = stateDir("acp-accounts-state.json");
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;

export interface AcpAccount {
  id: string;
  provider: AcpProvider;
  name: string;
  email?: string;
  authPath: string;
  agentIdPath?: string;
  owner?: string;
  source: "host" | "managed";
  createdAt: string;
}

export interface AcpAccountPublic {
  id: string;
  provider: AcpProvider;
  name: string;
  email?: string;
  owner?: string;
  mode: "shared" | "personal";
  source: "host" | "managed";
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

interface StoreFile {
  accounts?: AcpAccount[];
  hostOwners?: Partial<Record<AcpProvider, string>>;
}

const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();

function loadState(): void {
  exhaustedUntil.clear();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    const now = Date.now();
    for (const [id, until] of Object.entries(parsed?.exhaustedUntil || {})) {
      if (typeof until === "number" && until > now)
        exhaustedUntil.set(id, until);
    }
  } catch {}
}
loadState();

function persistState(): void {
  const now = Date.now();
  const active = Object.fromEntries(
    [...exhaustedUntil].filter(([, until]) => until > now),
  );
  writeJsonAtomic(STATE_PATH, { exhaustedUntil: active }, true, 0o600);
}

function readStore(): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readManaged(): AcpAccount[] {
  const accounts = readStore().accounts;
  return Array.isArray(accounts)
    ? accounts.filter(
        (account) =>
          (account.provider === "grok" || account.provider === "cursor") &&
          account.source === "managed" &&
          typeof account.authPath === "string",
      )
    : [];
}

function writeManaged(
  accounts: AcpAccount[],
  hostOwners = readStore().hostOwners || {},
): void {
  writeJsonAtomic(STORE_PATH, { accounts, hostOwners }, true, 0o600);
}

function privateFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function emailFromGrok(path: string): string | undefined {
  try {
    const root = JSON.parse(readFileSync(path, "utf8"));
    for (const value of Object.values(root || {})) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as any).email === "string" &&
        (value as any).email.trim()
      ) {
        return (value as any).email.trim();
      }
    }
  } catch {}
  return undefined;
}

function hostAccount(provider: AcpProvider): AcpAccount | null {
  const authPath = acpAuthSource(provider);
  if (!privateFile(authPath)) return null;
  const email = provider === "grok" ? emailFromGrok(authPath) : undefined;
  const owner = readStore().hostOwners?.[provider]?.trim() || undefined;
  return {
    id: `acp-host-${provider}`,
    provider,
    name: email || `${provider === "grok" ? "Grok" : "Cursor"} host account`,
    ...(email ? { email } : {}),
    ...(owner ? { owner } : {}),
    authPath,
    ...(provider === "grok" && acpAgentIdSource(provider)
      ? { agentIdPath: acpAgentIdSource(provider) }
      : {}),
    source: "host",
    createdAt: new Date(0).toISOString(),
  };
}

export function listAcpAccounts(provider?: AcpProvider): AcpAccount[] {
  const providers = provider ? [provider] : (["grok", "cursor"] as const);
  const hosts = providers
    .map((candidate) => hostAccount(candidate))
    .filter((account): account is AcpAccount => !!account);
  const managed = readManaged().filter(
    (account) =>
      (!provider || account.provider === provider) &&
      privateFile(account.authPath),
  );
  return [...hosts, ...managed];
}

function toPublic(account: AcpAccount): AcpAccountPublic {
  const until = exhaustedUntil.get(account.id);
  const active = until !== undefined && until > Date.now();
  return {
    id: account.id,
    provider: account.provider,
    name: account.name,
    ...(account.email ? { email: account.email } : {}),
    ...(account.owner ? { owner: account.owner } : {}),
    mode: account.owner ? "personal" : "shared",
    source: account.source,
    createdAt: account.createdAt,
    exhaustedUntil: active ? new Date(until).toISOString() : null,
    usable: !active,
  };
}

export function listAcpAccountsPublic(): AcpAccountPublic[] {
  return listAcpAccounts().map(toPublic);
}

export function getAcpAccountById(id: string): AcpAccount | undefined {
  return listAcpAccounts().find((account) => account.id === id);
}

function credentialFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function addAcpAccountFromHome(
  provider: AcpProvider,
  home: string,
  options: { owner?: string; identity?: string } = {},
): AcpAccountPublic | { error: string } {
  const definition = ACP_PROVIDER_DEFINITIONS[provider];
  const source = join(home, definition.authRelativePath);
  if (!privateFile(source)) {
    return {
      error: `${provider === "grok" ? "Grok" : "Cursor"} sign-in did not create a private auth file`,
    };
  }
  const fingerprint = credentialFingerprint(source);
  if (
    listAcpAccounts().some(
      (account) => credentialFingerprint(account.authPath) === fingerprint,
    )
  ) {
    return { error: "This subscription is already connected" };
  }

  const id = crypto.randomUUID();
  const directory = stateDir(`acp-accounts/${provider}/${id}`);
  const authPath = join(directory, "auth.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(source, authPath);
  chmodSync(authPath, 0o600);

  let agentIdPath: string | undefined;
  if (definition.agentIdRelativePath) {
    const sourceAgentId = join(home, definition.agentIdRelativePath);
    if (privateFile(sourceAgentId)) {
      agentIdPath = join(directory, "agent_id");
      copyFileSync(sourceAgentId, agentIdPath);
      chmodSync(agentIdPath, 0o600);
    }
  }

  const email =
    provider === "grok"
      ? emailFromGrok(authPath)
      : options.identity?.trim() || undefined;
  const ordinal = listAcpAccounts(provider).length + 1;
  const account: AcpAccount = {
    id,
    provider,
    name:
      email || `${provider === "grok" ? "Grok" : "Cursor"} account ${ordinal}`,
    ...(email ? { email } : {}),
    authPath,
    ...(agentIdPath ? { agentIdPath } : {}),
    ...(options.owner?.trim() ? { owner: options.owner.trim() } : {}),
    source: "managed",
    createdAt: new Date().toISOString(),
  };
  writeManaged([...readManaged(), account]);
  return toPublic(account);
}

export function removeAcpAccount(id: string): boolean {
  const accounts = readManaged();
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) return false;
  writeManaged(accounts.filter((candidate) => candidate.id !== id));
  exhaustedUntil.delete(id);
  lastPickedAt.delete(id);
  persistState();
  const managedRoot = stateDir("acp-accounts");
  const directory = dirname(account.authPath);
  if (
    directory.startsWith(`${managedRoot}/`) &&
    basename(directory) === account.id
  ) {
    rmSync(directory, { recursive: true, force: true });
  }
  return true;
}

export function setAcpAccountOwner(
  id: string,
  owner?: string,
): AcpAccountPublic | null {
  const hostProvider = id.match(/^acp-host-(grok|cursor)$/)?.[1] as
    | AcpProvider
    | undefined;
  if (hostProvider) {
    const host = hostAccount(hostProvider);
    if (!host) return null;
    const hostOwners = { ...(readStore().hostOwners || {}) };
    const trimmed = owner?.trim();
    if (trimmed) hostOwners[hostProvider] = trimmed;
    else delete hostOwners[hostProvider];
    writeManaged(readManaged(), hostOwners);
    const updated = { ...host };
    if (trimmed) updated.owner = trimmed;
    else delete updated.owner;
    return toPublic(updated);
  }
  const accounts = readManaged();
  const index = accounts.findIndex((account) => account.id === id);
  if (index < 0) return null;
  const next = { ...accounts[index] };
  const trimmed = owner?.trim();
  if (trimmed) next.owner = trimmed;
  else delete next.owner;
  accounts[index] = next;
  writeManaged(accounts);
  return toPublic(next);
}

export function pickAcpAccount(
  provider: AcpProvider,
  options: {
    exclude?: Set<string>;
    sessionKey?: string;
    accountId?: string;
    strict?: boolean;
    user?: string;
  } = {},
): AcpAccount | undefined {
  const all = listAcpAccounts(provider);
  const eligible = (account: AcpAccount) =>
    !options.exclude?.has(account.id) &&
    !(exhaustedUntil.get(account.id)! > Date.now()) &&
    (!account.owner ||
      (!!options.user && userMatchesAny(options.user, [account.owner])));
  if (options.accountId) {
    const pinned = all.find(
      (account) => account.id === options.accountId && eligible(account),
    );
    if (pinned) return pinned;
    if (options.strict) return undefined;
  }
  const usable = all.filter(eligible);
  const personal = options.user
    ? usable.filter(
        (account) =>
          account.owner && userMatchesAny(options.user!, [account.owner]),
      )
    : [];
  const candidates = personal.length
    ? personal
    : usable.filter((account) => !account.owner);
  if (!candidates.length) return undefined;
  const picked = options.sessionKey
    ? candidates
        .map((account) => ({
          account,
          score: hrwScore(options.sessionKey!, account.id),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.account.id.localeCompare(right.account.id),
        )[0].account
    : candidates
        .map((account) => ({
          account,
          pickedAt: lastPickedAt.get(account.id) || 0,
        }))
        .sort((left, right) => left.pickedAt - right.pickedAt)[0].account;
  lastPickedAt.set(picked.id, Date.now());
  return picked;
}

export function markAcpAccountExhausted(
  id: string,
  until = Date.now() + DEFAULT_EXHAUST_MS,
): void {
  exhaustedUntil.set(id, until);
  persistState();
}

/** Test seam: isolate both pool files from the real server account state. */
export function __setAcpAccountsPathForTest(path: string): {
  store: string;
  state: string;
} {
  const previous = { store: STORE_PATH, state: STATE_PATH };
  STORE_PATH = path;
  STATE_PATH = path.replace(/\.json$/, "-state.json");
  exhaustedUntil.clear();
  lastPickedAt.clear();
  loadState();
  return previous;
}
