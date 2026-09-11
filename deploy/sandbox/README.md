# `opensession-runner` image

The reference runner environment: the tool versions and absolute paths every
Sandbox reproduces. Remote sandboxes (Daytona, Box; operator guide:
`docs/self-hosting-sandboxes.md`) do not run this image directly. Their
bootstrap (`src/server/sandbox/adapters/bootstrap.ts`) installs the same
payload into the provider's base VM and keeps its pins aligned with the
Dockerfile, so a run behaves identically on the host, in the published image,
and inside a Sandbox. The local Docker provider runs this image as a
per-session container.

## What it contains

| Component                         | Purpose                                                                                                                                                                                      | Pin                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `bun`                             | runs the runner bundle + Bun `$` exec                                                                                                                                                        | `1.4.0` (host)                                    |
| Node.js LTS                       | native-dep builds, tooling                                                                                                                                                                   | `24.x`                                            |
| `git`, `gh`                       | clone / status / diff / push / PR                                                                                                                                                            | apt latest                                        |
| `ripgrep`                         | @-mention file search                                                                                                                                                                        | apt                                               |
| `python3`, `build-essential`      | worktree `bun install` native deps                                                                                                                                                           | apt                                               |
| `just`, `direnv`, `lsof`          | common repo dev-server bring-up chains (Portals / in-sandbox previews)                                                                                                                       | apt / pinned release                              |
| Claude Code CLI                   | baked at the identical host CLI path for session-resume parity                                                                                                                               | `2.1.218` (host); build FAILS on version mismatch |
| Grok CLI (ACP)                    | official SuperGrok subscription agent (`grok agent stdio`)                                                                                                                                   | `1.0.16`; build FAILS on version mismatch         |
| Cursor Agent (ACP)                | official Cursor subscription agent (`cursor-agent acp`)                                                                                                                                      | `2026.08.25-3e8eec8`; immutable package pin       |
| runner bundle                     | stable container path (`/home/ubuntu/.opensession-runner`): root manifests, lockfile, patches and `tsconfig.json`; copied protocol, server, and root runtime scripts; installed dependencies | from lockfile                                     |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error                                                                                                                                                   | `{}`                                              |

Runs as uid **1000** user `ubuntu` (matches the host uid) so bind-mounted
worktrees keep sane ownership. Default `CMD` is `sleep infinity` — the Docker
provider starts the container long-lived and `docker exec`s runs into it;
there's no baked ENTRYPOINT. Canonical state parents such as `~/.opensession`
are created by that user before Docker mounts provider files beneath them, so
runtime state directories never inherit root ownership from mount
materialization.

Remote bootstrap installs the same payload at `/home/ubuntu/projects/opensession`
inside Daytona/Box VMs. Keep those absolute paths in lockstep with
`bootstrap.ts`; do not "tidy" either contracted path.

## Why path parity matters

The runner config points at the claude CLI at
`/home/ubuntu/.local/bin/claude`, the stable Docker runner bundle at
`/home/ubuntu/.opensession-runner`, and (in Docker bind mode) the session
worktree bind-mounted at its **same** host path. The fixed bundle path
deliberately does not mirror the host checkout: immutable releases run from
SHA-named worktrees, while the image must remain valid across promotions. If
any contracted path drifts, the in-container runner can't find the CLI, its
dependencies, or the worktree.

## Build

```sh
deploy/sandbox/build.sh
```

Tags `opensession-runner:latest` and `opensession-runner:<git-sha>` from the
repo root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.
`.github/workflows/sandbox-release.yml` publishes and signs the release image.

Version pins are Dockerfile `ARG`s: `BUN_VERSION`, `CLAUDE_VERSION`,
`GROK_VERSION`, `NODE_MAJOR`, and `JUST_VERSION`. Keep them aligned with
`bootstrap.ts`'s pins; the remote bootstrap treats a pin change as a reason to
re-bootstrap every Sandbox. `build.sh` supports `IMAGE=...` but does not
forward command-line options. To override a pin, invoke `docker build` directly
with `--build-arg` or change the Dockerfile default. The runner root is a code
contract, not a deployment-specific build argument. The image build also
bundles the runner-host entry as a throwaway module-graph smoke check; a missing
root runtime import fails the build before the image can be promoted.

## Verification

`deploy/sandbox/conformance.ts` is the live provider certification matrix:

```sh
bun run deploy/sandbox/conformance.ts [docker-socket] [docker-ws] [daytona] [box]
```

It redirects every store to a scratch directory before importing server code,
creates sbxtest-labeled sandboxes, proves ensure/reuse, exec semantics,
in-sandbox workspace git, Portal exposure, a real engine round trip, snapshot
publication and adoption, sleep/wake, and destroy, then audits the provider
account for leftovers. Credentials are read from the live connection store
and only ever written to the scratch config.

`deploy/sandbox/opensession` is the in-sandbox CLI shim installed at
`~/.local/bin/opensession`; today it exposes `sandbox id-token` for workload
identity exchange.
