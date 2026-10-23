#!/usr/bin/env bash
# Installs ci/ci.yml as the GitHub Actions workflow and pushes it.
#
# Pushing files under .github/workflows/ needs a token with the `workflow` scope.
# With the GitHub CLI, grant it first:
#   gh auth refresh -h github.com -s workflow
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .github/workflows
cp ci/ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "CI: enable GitHub Actions workflow (Node 20/22 tests + composite action smoke test)"
git push
