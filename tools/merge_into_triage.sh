#!/usr/bin/env bash
# Reproduce the triage + fly/connectome merge rehearsal on a NEW LOCAL branch.
# Verified 2026-09-27 on triage 68033b6 + fly/connectome: 158 passed, 1 skipped (fast
# tests), tsc and vite build clean. It never pushes; review, then push where the team agrees.
#
#   bash tools/merge_into_triage.sh [branch-name]      (run from a clean checkout)
set -euo pipefail
BRANCH=${1:-merge/triage-fly}
PATCH=docs/fly-connectome/rehearsal-triage.patch

git fetch origin triage fly/connectome
git show origin/fly/connectome:$PATCH > /tmp/rehearsal-triage.patch
git checkout -b "$BRANCH" origin/triage
git merge --no-edit origin/fly/connectome || true   # 12 known conflicts, resolved below

# 1) Fly-only files: fly/connectome wins. The old scaffold test moved to test_reflex_isolation.py.
git checkout origin/fly/connectome -- bench/__init__.py reflex/__init__.py reflex/config.py \
  reflex/server.py tests/test_reflex_isolation.py web/vite.config.ts
git rm -q --cached --ignore-unmatch tests/test_scaffold.py; rm -f tests/test_scaffold.py
# 2) Ground-station tests: triage wins, unchanged.
git checkout origin/triage -- tests/test_config.py
# 3) Mission prototype and shared files: triage + the rehearsal patch (only these files).
FILES=".gitignore AGENTS.md README.md docs/SETUP.md docs/TEAM.md pyproject.toml uv.lock
  server/app.py server/mission/loop.py server/protocol.py tests/test_inspection_integration.py
  web/package.json web/package-lock.json web/src/inspection.ts web/src/main.ts web/src/queue.ts
  web/src/store.ts web/src/style.css web/src/ws.ts"
INCLUDE=()
for f in $FILES; do
  git checkout origin/triage -- "$f" 2>/dev/null || { git rm -q --cached --ignore-unmatch "$f"; rm -f "$f"; }
  INCLUDE+=("--include=$f")
done
git apply "${INCLUDE[@]}" /tmp/rehearsal-triage.patch
# Everything else (fly docs, inspect page, scene, tools) stays as fly/connectome has it.

git add -A
if grep -rIl '^<<<<<<< ' --exclude-dir=node_modules --exclude-dir=.git . ; then
  echo "Conflict markers remain in the files above"; exit 1
fi
git commit -q -m "Merge fly/connectome into triage (rehearsal resolutions)"
echo "Merged on $BRANCH. Next: uv sync --extra fly && uv run pytest -m 'not slow';"
echo "cd web && npm ci && npx tsc --noEmit && npm run build. Then change the mission deadline (HANDOFF.md)."
