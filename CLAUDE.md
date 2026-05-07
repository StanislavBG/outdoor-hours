# OutdoorHours · KOUT-7

Static-path frontend for the KOUT-7 weather report at **bilko.run/projects/outdoor-hours/**. Reads pre-computed JSON data files; the heavy lifting lives in the sibling `outdoor-hours-etl` repo.

## Layout
- `src/main.tsx` — React mount point.
- `src/OutdoorHoursPage.tsx` — the page.
- `src/index.css` — Tailwind + palette.

## Commands
- `pnpm dev` — local on `http://localhost:5173`.
- `pnpm build` — emit `dist/`.
- `pnpm sync` — `rm -rf ../Bilko/public/projects/outdoor-hours && cp -r dist ../Bilko/public/projects/outdoor-hours`.

## Deploy
Static-path sibling of Bilko. After `pnpm build && pnpm sync`, commit + push from `~/Projects/Bilko` to both remotes (`origin` = bilko-run, `content-grade`); Render redeploys ~60–90s. Or from a Claude session here, use the `bilko-host` MCP — see `~/Projects/Bilko/docs/host-contract.md`.

## Data
JSON data files served at `bilko.run/outdoor-hours/*.json` are produced by **`outdoor-hours-etl`** (sibling repo). This repo is presentation only — never compute or transform weather data here.

## Conventions
- Vite `base: '/projects/outdoor-hours/'` (not `'./'`) so React Router uses it as basename. Don't change without re-checking host routing.
- TS strict. Tailwind v4 (`@tailwindcss/vite`). No router-free assumptions — this project DOES use a router.
- See `~/Projects/Bilko/docs/host-contract.md` for the static-path contract.
