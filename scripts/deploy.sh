#!/usr/bin/env bash
# Tests, builds the image for the cluster (amd64), pushes it, applies the manifests and
# waits for the rollout. Settings come from .deploy.env (see .deploy.env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .deploy.env; set +a
[ -f config.json ] || { echo "config.json missing (copy config.example.json)" >&2; exit 1; }

IMAGE="$REGISTRY/$IMAGE_NAME"
TAG=${TAG:-$(date +%Y%m%d-%H%M%S)}
SSH=(ssh -i "${DEPLOY_SSH_KEY/#\~/$HOME}" "$DEPLOY_SSH")
K="KUBECONFIG=$KUBECONFIG_REMOTE kubectl -n $NAMESPACE"

bun test tests
docker buildx build --platform linux/amd64 -t "$IMAGE:$TAG" --push .

sed "s#name: pr-reviewer\$#name: $NAMESPACE#" k8s/namespace.yaml | "${SSH[@]}" "KUBECONFIG=$KUBECONFIG_REMOTE kubectl apply -f -"
"${SSH[@]}" "$K create configmap pr-reviewer-config --from-file=config.json=/dev/stdin --dry-run=client -o yaml | $K apply -f -" < config.json

CONFIG_SHA=$(shasum -a 256 config.json | cut -c1-16)
{ cat k8s/app.yaml; echo ---; cat k8s/ingress.yaml; } \
  | sed -e "s#image: IMAGE#image: $IMAGE:$TAG#" -e "s#CONFIG_SHA#\"$CONFIG_SHA\"#" -e "s#PUBLIC_HOST#$PUBLIC_HOST#g" -e "s#namespace: pr-reviewer#namespace: $NAMESPACE#" \
  | "${SSH[@]}" "$K apply -f -"
"${SSH[@]}" "$K rollout status deployment/pr-reviewer --timeout=180s"
echo "deployed $IMAGE:$TAG"
