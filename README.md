# OutdoorHours · KOUT-7

Standalone Vite + React frontend for the KOUT-7 weather report at https://bilko.run/projects/outdoor-hours/.

Hosted on bilko.run via the **static-path** contract (see `~/Projects/Bilko/docs/host-contract.md`):
- This repo builds to `dist/`.
- `pnpm sync` copies `dist/` into `~/Projects/Bilko/public/projects/outdoor-hours/`.
- Bilko serves the bundle at `/projects/outdoor-hours/`; React Router uses that as basename.

Data files live at `bilko.run/outdoor-hours/*.json` and are produced by the sibling `outdoor-hours-etl` repo.

## Develop

```
pnpm install
pnpm dev
```

## Ship

```
pnpm build && pnpm sync
cd ../Bilko && git add public/projects/outdoor-hours && git commit -m "OutdoorHours: ..."
```
