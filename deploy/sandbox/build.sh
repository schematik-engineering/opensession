#!/usr/bin/env bash
# Build + tag the opensession-runner image (sandbox rollout Phase 1).
#
#   opensession-runner:latest        (moving tag)
#   opensession-runner:<git-sha>     (immutable, current HEAD short sha)
#
# Build context is the repo root so the Dockerfile can COPY package.json/bun.lock/
# opensession.ts. A root .dockerignore trims the context (excludes node_modules,
# .git, .frontend-dist, secrets).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

IMAGE="${IMAGE:-opensession-runner}"
SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

echo "Building ${IMAGE}:latest and ${IMAGE}:${SHA}"
echo "  context:    ${REPO_ROOT}"
echo "  dockerfile: ${SCRIPT_DIR}/Dockerfile"
echo "  runner root: ${REPO_ROOT}"

docker build \
  -f "${SCRIPT_DIR}/Dockerfile" \
  --build-arg "OPENSESSION_RUNNER_ROOT=${REPO_ROOT}" \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}:${SHA}" \
  "${REPO_ROOT}"

echo
echo "Built:"
docker image ls "${IMAGE}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
