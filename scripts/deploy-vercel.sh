#!/usr/bin/env bash
# One-shot Vercel deploy (README "Deploy on Vercel"). Run from the repo root:
#   bash scripts/deploy-vercel.sh kassa-demo.vercel.app            # first time: link, Postgres, env, deploy, seed
#   bash scripts/deploy-vercel.sh kassa-demo.vercel.app --redeploy  # later: just deploy
# DOMAIN is the production host people open (passkeys are bound to it). Set AGENT_MODE=LIVE and
# ANTHROPIC_API_KEY in your shell to use a live model instead of the recorded replay.
set -euo pipefail

DOMAIN="${1:?usage: bash scripts/deploy-vercel.sh <production-domain> [--redeploy]}"
cd "$(dirname "$0")/.."
command -v vercel >/dev/null || npm i -g vercel

if [[ "${2:-}" != "--redeploy" ]]; then
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

  put PUBLIC_ORIGIN "https://$DOMAIN"
  put RP_ID "$DOMAIN"
  put MOCK_PUBLIC_URL "https://$DOMAIN"
  put KASSA_APP_URL "https://$DOMAIN"
  put DEMO_ENABLED true
  put ISSUING_PROVIDER fake
  put AGENT_MODE "${AGENT_MODE:-REPLAY}"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && put ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
fi

vercel deploy --prod

if [[ "${2:-}" != "--redeploy" ]]; then
  # shellcheck disable=SC1091
  . ./.env.vercel
  curl -fsS -X POST "https://$DOMAIN/api/demo/reset" -H "x-kassa-demo-token: $DEMO_ADMIN_TOKEN" \
    -H 'content-type: application/json' -d '{}' >/dev/null && echo "demo data seeded"
fi
curl -fsS "https://$DOMAIN/api/health" && echo
