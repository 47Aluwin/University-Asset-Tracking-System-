# University Asset Tracking System (ATS)

A system for registering, labelling, verifying, relocating and maintaining university assets across
departments. It has one central database, a mobile app for fieldwork, and a browser app for
administration and reporting.

**Current status: all 7 phases implemented, awaiting review — implementation-complete, not yet approved for
production.** Accounts and access control; asset registration, QR labels and printing; post-registration review and
correction; physical verification, schedules, relocation; condition, damage and department-managed maintenance;
dashboard and four reports with PDF/Excel export; offline fieldwork with safe synchronisation; backups with tested
restore. What production approval still needs (hosting, devices, printers, decisions) is in
[docs/acceptance.md](docs/acceptance.md). See [docs/implementation-plan.md](docs/implementation-plan.md) for progress
and [docs/decisions-and-limitations.md](docs/decisions-and-limitations.md) for open decisions.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | Expo app (iOS, Android, browser). Screens are in `src/app/` (Expo Router). |
| `server/` | API server (Node.js + Fastify) and database migrations (`server/migrations/`). |
| `shared/` | Code used by both app and server: asset ID / QR formats, money, label layout and QR generation. |
| `tests/` | Tests for `shared/`. |
| `e2e/` | Browser journey tests that drive the real app against the real API. |
| `docs/` | Architecture, data model, access control, hosting, testing, security, deployment. |

## Prerequisites

- Node.js 22.18 or newer (developed on 24.19).
- No database install is needed for development: the server uses an embedded PostgreSQL (PGlite)
  stored in `server/.data/`. Production uses a real PostgreSQL server (see [docs/deployment.md](docs/deployment.md)).
- For the browser tests: Microsoft Edge or Google Chrome.

## Quick start (development)

```bash
# 1. Install
npm install
npm --prefix server install

# 2. Create example departments, categories and locations (prefixed "Dev:") and the first administrator
npm --prefix server run seed-dev
npm --prefix server run create-admin -- --email you@university.example --name "Your Name"
#    → prints a one-time link. Open it once the app is running to set your password.

# 3. Start the API (http://localhost:4000)
npm run server:dev

# 4. In another terminal, start the app
npx expo start          # press w for browser, or scan the QR code with Expo Go
```

To use the app on a phone, see `.env.example` for how to point it at your computer's API address.

## Checks

```bash
npm run server:test       # API + database tests (180 tests, embedded PostgreSQL)
npm --prefix server run test:pg-wire   # the same tests through the production PostgreSQL driver
npm run test:shared       # QR / label / money / date tests (12 tests)
npm run server:typecheck
npm run typecheck         # app
npx expo lint
npm run test:e2e          # browser journeys (builds web app, starts API, drives Edge/Chrome)
node server/scripts/perf.ts 100000   # performance check with 100,000 assets (in memory)
```

## Operations

```bash
npm --prefix server run backup            # database + uploaded files + manifest (stop the dev API first)
npm --prefix server run restore -- <backup> --data-dir <new> --upload-dir <new>
npm --prefix server run cleanup-uploads   # lists unused uploaded files (add -- --delete to remove)
```

## Documentation

- [Requirements](docs/requirements.md) · [Architecture](docs/architecture.md) · [Data model](docs/data-model.md)
- [Access control](docs/access-control.md) · [Security](docs/security.md) · [Offline sync design](docs/offline-sync.md)
- [QR codes and label printing](docs/qr-printing.md) · [Hosting comparison](docs/hosting-comparison.md) · [Deployment](docs/deployment.md) · [Testing](docs/testing.md)
- [Decisions and limitations](docs/decisions-and-limitations.md) · [Implementation plan](docs/implementation-plan.md)
- [User guide](docs/user-guide.md) · [Operations](docs/operations.md) · [Backup and recovery](docs/backup-recovery.md) · [Final acceptance](docs/acceptance.md)
