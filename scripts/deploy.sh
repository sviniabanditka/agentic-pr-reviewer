#!/usr/bin/env bash
# Tests, builds the image for the k3s node (amd64), pushes it to the cluster registry,
# applies the manifests and waits for the rollout.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=registry.sviniabanditka.com/agentic-pr-reviewer
TAG=${TAG:-$(date +%Y%m%d-%H%M%S)}
SSH=(ssh -i "${SSH_KEY:-$HOME/.ssh/tracker_ci}" root@ssh.sviniabanditka.com)
K="KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pr-reviewer"

bun test tests
docker buildx build --platform linux/amd64 -t "$IMAGE:$TAG" --push .

"${SSH[@]}" "KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f -" < k8s/namespace.yaml
"${SSH[@]}" "$K create configmap pr-reviewer-config --from-file=config.json=/dev/stdin --dry-run=client -o yaml | $K apply -f -" < config.json

CONFIG_SHA=$(shasum -a 256 config.json | cut -c1-16)
{ cat k8s/app.yaml; echo ---; cat k8s/ingress.yaml; } \
  | sed -e "s#image: IMAGE#image: $IMAGE:$TAG#" -e "s#CONFIG_SHA#\"$CONFIG_SHA\"#" \
  | "${SSH[@]}" "$K apply -f -"
"${SSH[@]}" "$K rollout status deployment/pr-reviewer --timeout=180s"
echo "deployed $IMAGE:$TAG"
