#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Isolated integration stack for one working copy. It refuses to run against
# a stack that is not clearly a disposable test stack, so a shared or
# production deployment on the same host is never touched.
#
#   scripts/dev-stack.sh up                 build and start, then healthcheck
#   scripts/dev-stack.sh test <npm-script>… run each script, report all, fail if any failed
#   scripts/dev-stack.sh scale-core <n>     run <n> Core replicas
#   scripts/dev-stack.sh strict <on|off>    recreate Core with STRICT_RECORD_WRITES
#   scripts/dev-stack.sh down               stop and delete the stack and its volumes
#   scripts/dev-stack.sh status
set -uo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
name=$(basename "$root")
project="jx-${name#jx-}"
port=${DEV_STACK_PORT:-18080}
console_port=${DEV_STACK_CONSOLE_PORT:-13000}
die() { echo "dev-stack: $*" >&2; exit 2; }

[[ "$project" =~ ^jx-[a-z0-9][a-z0-9-]{0,30}$ ]] || die "working copy name must be jx-<id> (got $name)"
[[ "$port" != 8080 && "$console_port" != 3000 ]] || die "ports 8080/3000 belong to the shared stack"
for protected in "${DEV_STACK_PROTECTED:-$HOME/junctura-dxos}"; do
  [[ "$root" != "$(cd "$protected" 2>/dev/null && pwd -P)" ]] || die "refusing to run in the shared working copy $protected"
done

if [[ -f .env ]]; then
  current=$(grep -E '^COMPOSE_PROJECT_NAME=' .env | tail -1 | cut -d= -f2-)
  [[ "$current" == "$project" ]] || die ".env project is '${current:-unset}', expected $project; remove this .env only if it is a test copy"
  grep -qE "^PORT=$port$" .env || die ".env PORT is not $port"
elif [[ "${1:-}" == up ]]; then
  npm run --silent setup -- --project "$project" --port "$port" --console-port "$console_port" || die "setup failed"
  grep -q '^MEILI_MASTER_KEY=.\+' .env || die "setup did not generate MEILI_MASTER_KEY"
else
  die "no .env; run '$0 up' first"
fi
export COMPOSE_PROJECT_NAME="$project"
export COMPOSE_FILE="compose.yaml:infra/openbao/compose.bootstrap.yaml"
# Contract checks spawn $PYTHON; hosts that only ship python3 still work.
command -v python >/dev/null 2>&1 || export PYTHON="${PYTHON:-python3}"

case "${1:-}" in
  up)
    # A first boot on a small host can race the one-shot migration job;
    # one retry is safe because migrations are idempotent and checksummed.
    docker compose up --build --detach --wait --wait-timeout 900 ||
      docker compose up --detach --wait --wait-timeout 900 || die "stack did not become healthy"
    npm run --silent healthcheck ;;
  test)
    shift; [[ $# -gt 0 ]] || die "name at least one npm script"
    failed=(); summary=()
    for script in "$@"; do
      [[ "$script" =~ ^test:[a-z0-9:-]+$ ]] || die "only test:* scripts are allowed ($script)"
      start=$SECONDS
      if npm run --silent "$script"; then summary+=("PASS  $script  $((SECONDS-start))s")
      else summary+=("FAIL  $script  $((SECONDS-start))s"); failed+=("$script"); fi
    done
    printf '\n== dev-stack summary (%s) ==\n' "$project"; printf '%s\n' "${summary[@]}"
    [[ ${#failed[@]} -eq 0 ]] ;;
  scale-core)
    [[ "${2:-}" =~ ^[1-4]$ ]] || die "scale-core takes 1..4"
    docker compose up --detach --no-deps --scale core="$2" --wait --wait-timeout 120 core ;;
  strict)
    case "${2:-}" in on) v=true ;; off) v=false ;; *) die "strict takes on|off" ;; esac
    STRICT_RECORD_WRITES=$v docker compose up --detach --no-deps --scale core=1 --force-recreate --wait --wait-timeout 120 core
    npm run --silent healthcheck ;;
  down) docker compose down --volumes --remove-orphans ;;
  status) docker compose ps ;;
  *) die "usage: $0 up|test <script>…|scale-core <n>|strict on|off|down|status" ;;
esac
