/** Persisted long-running sandbox setup operations. */

import { existsSync, readFileSync } from "fs";
import { stateDir } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";
import { broadcastToAll } from "../ws-hub";

const liveOperations: Set<string> = ((
  globalThis as any
).__sandboxLiveOperations ??= new Set());

const MAX_FAILED_OPERATIONS = 10;
const MAX_RESTART_FAILURES = 3;
const MAX_SUCCEEDED_OPERATIONS = 10;

export type SandboxOperationStatus = "running" | "succeeded" | "failed";

export interface SandboxOperation {
  id: string;
  kind: "qualification" | "repair" | "environment_rebuild";
  provider: string;
  repo?: string;
  status: SandboxOperationStatus;
  stage: string;
  detail?: string;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  failureCode?: string;
  failureSummary?: string;
}

function storePath(): string {
  return (
    process.env.OPENSESSION_SANDBOX_OPERATIONS_STORE ||
    stateDir("sandbox-operations.json")
  );
}

function readOperations(): SandboxOperation[] {
  try {
    if (!existsSync(storePath())) return [];
    const raw = JSON.parse(readFileSync(storePath(), "utf-8"));
    return Array.isArray(raw?.operations) ? raw.operations : [];
  } catch {
    return [];
  }
}

export function compactSandboxOperations(
  operations: SandboxOperation[],
  live: ReadonlySet<string> = liveOperations,
): SandboxOperation[] {
  let failures = 0;
  let restartFailures = 0;
  let successes = 0;
  const compacted: SandboxOperation[] = [];
  for (const source of [...operations].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )) {
    const operation =
      source.status === "running" && !live.has(source.id)
        ? {
            ...source,
            status: "failed" as const,
            stage: "Interrupted",
            updatedAt: source.updatedAt || source.createdAt,
            failureCode: "SERVER_RESTARTED",
            failureSummary:
              "The server restarted during this operation. Test again.",
          }
        : source;
    if (operation.status === "failed") {
      if (failures >= MAX_FAILED_OPERATIONS) continue;
      if (operation.failureCode === "SERVER_RESTARTED") {
        if (restartFailures >= MAX_RESTART_FAILURES) continue;
        restartFailures += 1;
      }
      failures += 1;
    } else if (operation.status === "succeeded") {
      if (successes >= MAX_SUCCEEDED_OPERATIONS) continue;
      successes += 1;
    }
    compacted.push(operation);
  }
  return compacted;
}

export function reconcileSandboxOperationsOnStartup(): void {
  const before = readOperations();
  const operations = compactSandboxOperations(before, new Set());
  if (JSON.stringify(before) !== JSON.stringify(operations)) {
    writeJsonAtomic(storePath(), { version: 1, operations });
  }
}

function persist(operation: SandboxOperation): void {
  const all = readOperations().filter(
    (candidate) => candidate.id !== operation.id,
  );
  all.push(operation);
  writeJsonAtomic(storePath(), {
    version: 1,
    operations: compactSandboxOperations(all),
  });
  broadcastToAll({ type: "sandbox_operation", operation });
}

export function listSandboxOperations(): SandboxOperation[] {
  return compactSandboxOperations(readOperations());
}

export function startSandboxOperation(
  input: Pick<SandboxOperation, "kind" | "provider" | "repo">,
  run: (
    update: (
      patch: Pick<SandboxOperation, "stage"> &
        Partial<Pick<SandboxOperation, "detail" | "progress">>,
    ) => void,
  ) => Promise<void>,
): SandboxOperation {
  const now = new Date().toISOString();
  const operation: SandboxOperation = {
    id: `sandbox-operation-${crypto.randomUUID()}`,
    kind: input.kind,
    provider: input.provider,
    ...(input.repo ? { repo: input.repo } : {}),
    status: "running",
    stage: input.kind === "qualification" ? "Checking connection" : "Queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  persist(operation);
  liveOperations.add(operation.id);
  const update = (
    patch: Pick<SandboxOperation, "stage"> &
      Partial<Pick<SandboxOperation, "detail" | "progress">>,
  ) => {
    if (operation.status !== "running") return;
    const progress =
      patch.progress == null
        ? operation.progress
        : Math.max(0, Math.min(100, patch.progress));
    if (
      operation.stage === patch.stage &&
      operation.detail === patch.detail &&
      operation.progress === progress
    )
      return;
    operation.stage = patch.stage;
    operation.detail = patch.detail;
    operation.progress = progress;
    operation.updatedAt = new Date().toISOString();
    persist(operation);
  };
  void run(update).then(
    () => {
      liveOperations.delete(operation.id);
      operation.status = "succeeded";
      operation.stage = "Complete";
      operation.detail = undefined;
      operation.progress = 100;
      operation.updatedAt = new Date().toISOString();
      persist(operation);
    },
    (error) => {
      liveOperations.delete(operation.id);
      operation.status = "failed";
      operation.stage = "Needs attention";
      operation.detail = undefined;
      operation.updatedAt = new Date().toISOString();
      operation.failureCode =
        typeof error?.code === "string" ? error.code : "OPERATION_FAILED";
      operation.failureSummary =
        error instanceof Error ? error.message : "Sandbox operation failed";
      persist(operation);
    },
  );
  return operation;
}
