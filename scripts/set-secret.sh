#!/usr/bin/env bash
# Usage: scripts/set-secret.sh KEY [--restart]
# Sets one key of the pr-reviewer-secrets Secret. The value is read from stdin
# (or typed hidden on a terminal) and travels over ssh stdin, never in argv.
set -euo pipefail
KEY=${1:?usage: scripts/set-secret.sh KEY [--restart]}
SSH=(ssh -i "${SSH_KEY:-$HOME/.ssh/tracker_ci}" root@ssh.sviniabanditka.com)
K="KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pr-reviewer"

if [ -t 0 ]; then read -rsp "$KEY: " VALUE; echo; else VALUE=$(cat); fi
[ -n "$VALUE" ] || { echo "empty value" >&2; exit 1; }
B64=$(printf %s "$VALUE" | base64 | tr -d '\n')

"${SSH[@]}" "$K get secret pr-reviewer-secrets >/dev/null 2>&1 || $K create secret generic pr-reviewer-secrets"
printf '{"data":{"%s":"%s"}}' "$KEY" "$B64" | "${SSH[@]}" "$K patch secret pr-reviewer-secrets --patch-file /dev/stdin"
if [ "${2:-}" = "--restart" ]; then
  "${SSH[@]}" "$K rollout restart deployment/pr-reviewer && $K rollout status deployment/pr-reviewer --timeout=180s"
fi
