import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

/**
 * Fail-closed preload barrier for a future supervised gateway handoff.
 *
 * A standby process may parse and statically import the gateway graph, but it
 * must stop here before touching the shared state namespace, binding a socket,
 * starting a Worker/timer, or contacting an integration. Only the parent IPC
 * channel that launched it can release the barrier, using the exact nonce.
 */
export type GatewayRole = "active" | "standby";

export type GatewayActivationMessage = {
  type: "opensession_gateway_activate";
  nonce: string;
};

export type GatewayPreloadedMessage = {
  type: "opensession_gateway_preloaded";
  nonce: string;
  pid: number;
};

type ProcessPort = {
  pid: number;
  send?: (message: GatewayPreloadedMessage) => boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
};

type GatewayEnvironment = Record<string, string | undefined>;

export function gatewayRole(env: GatewayEnvironment = process.env): GatewayRole {
  const value = env.OPENSESSION_GATEWAY_ROLE?.trim() || "active";
  if (value !== "active" && value !== "standby") {
    throw new Error(`Invalid OPENSESSION_GATEWAY_ROLE: ${value}`);
  }
  return value;
}

function activationMessage(value: unknown): GatewayActivationMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<GatewayActivationMessage>;
  return message.type === "opensession_gateway_activate" &&
    typeof message.nonce === "string"
    ? message as GatewayActivationMessage
    : null;
}

type GatewayLeaseOwner = { pid: number; nonce: string };

function readLeaseOwner(lockPath: string): GatewayLeaseOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as
      Partial<GatewayLeaseOwner>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
        typeof value.nonce === "string" && value.nonce.length > 0
      ? { pid: Number(value.pid), nonce: value.nonce }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireGatewayActivationLease(options: {
  env?: GatewayEnvironment;
  pid?: number;
  nonce?: string;
  processAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<{ release(): Promise<void> }> {
  const env = options.env ?? process.env;
  const state = env.OPENSESSION_DEPLOY_STATE ||
    `${env.HOME || ""}/.opensession/deploy`;
  const lockPath = env.OPENSESSION_GATEWAY_LEASE || `${state}/gateway-active.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const waitSeconds = env.OPENSESSION_GATEWAY_LEASE_WAIT_SECS || "5";
  if (!/^\d+$/.test(waitSeconds)) {
    throw new Error("Invalid OPENSESSION_GATEWAY_LEASE_WAIT_SECS");
  }
  const pid = options.pid ?? process.pid;
  const nonce = options.nonce ?? crypto.randomUUID();
  const processAlive = options.processAlive ?? processIsAlive;
  const sleep = options.sleep ?? Bun.sleep;
  const reclaimPath = `${lockPath}.reclaim`;
  const deadline = Date.now() + Number(waitSeconds) * 1_000;

  // An atomic directory is the portable cross-process primitive here: Linux
  // ships `flock`, macOS does not. The owner record lets a successor reclaim
  // after a crash, while a second atomic reclaim directory serializes stale
  // cleanup so it cannot rename a newly acquired lease out from under it.
  for (;;) {
    if (!existsSync(reclaimPath)) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        try {
          writeFileSync(
            join(lockPath, "owner.json"),
            `${JSON.stringify({ pid, nonce })}\n`,
            { mode: 0o600 },
          );
        } catch (error) {
          rmSync(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    const owner = readLeaseOwner(lockPath);
    const ownerIsLive = owner ? processAlive(owner.pid) : true;
    const lockAgeMs = (() => {
      try {
        return Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        return 0;
      }
    })();
    const unownedAndStale = !owner && lockAgeMs >= Number(waitSeconds) * 1_000;
    if ((!ownerIsLive || unownedAndStale) && !existsSync(reclaimPath)) {
      let claimedReclaim = false;
      try {
        mkdirSync(reclaimPath, { mode: 0o700 });
        claimedReclaim = true;
        const current = readLeaseOwner(lockPath);
        const currentIsStale = current
          ? !processAlive(current.pid)
          : (() => {
              try {
                return Date.now() - statSync(lockPath).mtimeMs >= Number(waitSeconds) * 1_000;
              } catch {
                return false;
              }
            })();
        if (currentIsStale) {
          const stalePath = `${lockPath}.stale.${nonce}`;
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        }
      } catch (error) {
        if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code || ""))
          throw error;
      } finally {
        if (claimedReclaim)
          rmSync(reclaimPath, { recursive: true, force: true });
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Gateway activation lease is already held${owner ? ` by pid ${owner.pid}` : ""}`,
      );
    }
    await sleep(50);
  }

  let releasing = false;
  return {
    async release() {
      if (releasing) return;
      releasing = true;
      const owner = readLeaseOwner(lockPath);
      if (!owner || owner.pid !== pid || owner.nonce !== nonce) {
        throw new Error("Gateway activation lease ownership changed before release");
      }
      const releasedPath = `${lockPath}.released.${nonce}`;
      renameSync(lockPath, releasedPath);
      rmSync(releasedPath, { recursive: true, force: true });
    },
  };
}

export async function waitForRuntimePeerGeneration(options: {
  env?: GatewayEnvironment;
  fetchReady?: (url: string) => Promise<Response>;
  readReadyFile?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  const fallback = (
    env.OPENSESSION_PEER_GENERATION ?? env.OPENSESSION_RELEASE_GENERATION
  )?.trim();
  const expectedKernel = (env.OPENSESSION_KERNEL_GENERATION ?? fallback)?.trim();
  const expectedExecutor = (env.OPENSESSION_EXECUTOR_GENERATION ?? fallback)?.trim();
  const executorDisabled = env.OPENSESSION_EXECUTOR === "0";
  if (
    (!expectedKernel || expectedKernel === "development") &&
    (executorDisabled || !expectedExecutor || expectedExecutor === "development")
  ) return;
  for (const expected of [expectedKernel, ...(executorDisabled ? [] : [expectedExecutor])]) {
    if (!expected || !/^[0-9a-f]{40,64}$/.test(expected)) {
      throw new Error("Invalid runtime peer generation");
    }
  }
  const fetchReady = options.fetchReady ?? ((url: string) =>
    fetch(url, { signal: AbortSignal.timeout(1_000) }));
  const readReadyFile = options.readReadyFile ?? ((path: string) => readFileSync(path, "utf8"));
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const kernelUrl = new URL(
    "/ready",
    env.OPENSESSION_SESSION_KERNEL_URL ?? "http://127.0.0.1:3849",
  ).toString();
  const executorReadyFile = env.OPENSESSION_EXECUTOR_READY_FILE ?? "/run/opensession-executor/ready";

  while (Date.now() < deadline) {
    try {
      const [kernel, executorText] = await Promise.all([
        fetchReady(kernelUrl).then(async (response) =>
          response.ok ? await response.json() as { generation?: string } : null),
        executorDisabled
          ? Promise.resolve(undefined)
          : Promise.resolve().then(() => readReadyFile(executorReadyFile)),
      ]);
      const executor = executorText
        ? JSON.parse(executorText) as { generation?: string }
        : undefined;
      if (
        kernel?.generation === expectedKernel &&
        (executorDisabled || executor?.generation === expectedExecutor)
      ) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(
    executorDisabled
      ? `Runtime peer did not reach kernel ${expectedKernel!.slice(0, 10)}`
      : `Runtime peers did not reach kernel ${expectedKernel!.slice(0, 10)} / ` +
        `executor ${expectedExecutor!.slice(0, 10)}`,
  );
}

export async function waitForGatewayActivationIfStandby(options: {
  env?: GatewayEnvironment;
  processPort?: ProcessPort;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (gatewayRole(env) === "active") return;

  const nonce = env.OPENSESSION_GATEWAY_NONCE?.trim();
  if (!nonce) {
    throw new Error("A standby gateway requires OPENSESSION_GATEWAY_NONCE");
  }
  const port = options.processPort ?? process;
  if (typeof port.send !== "function") {
    throw new Error("A standby gateway requires a supervised IPC channel");
  }

  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = activationMessage(raw);
      if (!message) return;
      port.removeListener("message", onMessage);
      if (message.nonce !== nonce) {
        reject(new Error("Gateway activation nonce mismatch"));
        return;
      }
      resolve();
    };
    port.on("message", onMessage);
    const sent = port.send!({
      type: "opensession_gateway_preloaded",
      nonce,
      pid: port.pid,
    });
    if (sent === false) {
      port.removeListener("message", onMessage);
      reject(new Error("Gateway preload acknowledgement was not delivered"));
    }
  });
}
