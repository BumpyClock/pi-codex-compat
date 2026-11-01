#!/usr/bin/env bash
set -euo pipefail
root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
cd "$root"
current=$(git config --get core.hooksPath || true)
if [[ -n "$current" && "$current" != .githooks ]]; then
    echo "Refusing to replace existing core.hooksPath=$current. Integrate hooks manually." >&2
    exit 1
fi
if [[ -z "$current" ]]; then
    active=$(git rev-parse --git-path hooks)
    for hook in "$active"/*; do
        if [[ -x "$hook" && "$hook" != *.sample ]]; then
            echo "Refusing to hide active hook $hook. Integrate hooks manually." >&2
            exit 1
        fi
    done
fi
if [[ ! -x .githooks/pre-push ]]; then
    echo 'Tracked .githooks/pre-push must be executable before installation.' >&2
    exit 1
fi
git config --local core.hooksPath .githooks
echo 'Opt-in hooks enabled for this repository. Re-running this installer is safe.'
