#!/usr/bin/env bash
# One-shot Vercel deploy (README "Deploy on Vercel"). Run from the repo root:
#   bash scripts/deploy-vercel.sh              # first time: link, Postgres, secrets, deploy
#   bash scripts/deploy-vercel.sh --redeploy   # later: just deploy
# No domain to type: the function uses the project's production domain (VERCEL_PROJECT_PRODUCTION_URL) for the
# passkey origin and RP ID, and loads the demo data into an empty database on its first start.
# Set AGENT_MODE=LIVE and ANTHROPIC_API_KEY in your shell to use a live model instead of the recorded replay.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v vercel >/dev/null || npm i -g vercel

if [[ "${1:-}" != "--redeploy" ]]; then
  vercel whoami >/dev/null 2>&1 || vercel login
  [[ -f .vercel/project.json ]] || vercel link

  # Postgres (sets DATABASE_URL). Skipped if the project already has one.
  if ! vercel env ls production 2>/dev/null | grep -q DATABASE_URL; then
    vercel integration add neon || { echo "Add a Postgres database in the dashboard (Storage → Neon), then re-run." >&2; exit 1; }
  fi

  # Secrets: generated once into .env.vercel (gitignored), reused on re-runs.
  [[ -f .env.vercel ]] || bun run keys:generate > .env.vercel
  put() { printf '%s' "$2" | vercel env add "$1" production --force >/dev/null && echo "env $1 set"; }
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    put "${line%%=*}" "${line#*=}"
  done < .env.vercel

  put DEMO_ENABLED true
  put ISSUING_PROVIDER fake
  put AGENT_MODE "${AGENT_MODE:-REPLAY}"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && put ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"

  # The domain comes from Vercel now; drop values an earlier version of this script set by hand.
  for name in PUBLIC_ORIGIN RP_ID MOCK_PUBLIC_URL KASSA_APP_URL; do
    vercel env rm "$name" production -y >/dev/null 2>&1 && echo "env $name removed (derived from the project domain)" || true
  done
fi

vercel deploy --prod
echo
echo "Open the production domain shown above (\"Aliased\"), e.g. https://<project>.vercel.app"
echo "Health check: https://<project>.vercel.app/api/health"
echo "If it asks you to log in to Vercel: Project → Settings → Deployment Protection → turn off Vercel Authentication."
