# Deployment

Status (Phase 7, 2026-10-31): development setup verified; the production database driver, backups, restore and
readiness check are tested here. Production deployment is **not performed** (no hosting chosen; see
`hosting-comparison.md`), so the release procedure below has not been run against real infrastructure.
Operations: `operations.md`; backups: `backup-recovery.md`; acceptance status: `acceptance.md`.

## Environment variables (API)

See `server/.env.example`. Required in production: `NODE_ENV=production`, `DATABASE_URL`,
`CORS_ORIGINS`, `PUBLIC_APP_URL`, `HOST=0.0.0.0`, `TRUST_PROXY=true` behind a proxy.
The API refuses to start in production without `DATABASE_URL` (embedded PGlite is development-only).
`REPORT_MAX_ROWS` (default 20,000) limits the rows per table in a PDF / Excel export. CORS exposes only
`Content-Disposition`, so the web app can name downloaded report files.

## Environment variables (app)

`EXPO_PUBLIC_API_URL` — public API base URL, bundled into the app (not secret). See `.env.example`.

## Web hosting

- The web app is a single-page build (`app.json` → `web.output: "single"`). The host must serve `index.html` for
  every path that is not a real file (e.g. Netlify `/*  /index.html  200`; Vercel rewrite `/:path*` → `/`).
- App screens live under `/inventory/...` (not `/assets/...`, which Expo reserves for bundled files).
- Camera scanning in browsers requires HTTPS (or `localhost`).
- Browser QR scanning uses a self-hosted decoder at `/zxing/zxing_reader.wasm`. Serve `.wasm` files with
  `Content-Type: application/wasm`, and allow WebAssembly in the CSP: add `'wasm-unsafe-eval'` to `script-src`.
  No third-party CDN is needed. After upgrading expo-camera, run `npm run sync:zxing`.

## Uploaded files

Photos and documents are stored in `UPLOAD_DIR` (default `server/.data/uploads`, outside any web root) and are only
served through the API. **Back this folder up together with the database** — the database stores only references.
In production use a persistent volume or S3-compatible storage (the `FileStore` interface in `server/src/storage.ts`).
`MAX_UPLOAD_MB` (default 5) sets the per-file limit; a reverse proxy in front must allow requests at least that large.

## Shared code

The API imports `shared/` (asset ID/QR formats, label-layout rules) from the repository root. Deploy the
server together with the `shared/` folder (e.g. build the container from the repository root). `shared/`
files used by the server have no third-party dependencies.

## Database migrations

- Numbered SQL files in `server/migrations/`, applied in order, each in a transaction, recorded in `schema_migrations`.
- Applied automatically on API start, or explicitly: `npm --prefix server run migrate`.
- Forward-only. To undo a change, write a new migration. Take a backup before each production migration.

## First administrator

`npm --prefix server run create-admin -- --email <email> --name "<name>"` prints a one-time setup link
(72 h). Run it on a machine that has `DATABASE_URL` for the target database.

## Production requirements checklist

| Requirement | Details |
|---|---|
| Node.js | 22.18 or newer on the API host |
| PostgreSQL | 15 or newer (developed against PostgreSQL 17 semantics via PGlite); a database user that does not own the schema; no UPDATE/DELETE on `audit_events` and `asset_reviews` |
| PostgreSQL client tools | `pg_dump` / `pg_restore`, same major version, on the machine that runs backups |
| File storage | persistent volume for `UPLOAD_DIR` (or an S3-compatible store behind `FileStore`), backed up with the database |
| HTTPS | TLS at the proxy / load balancer; `TRUST_PROXY=true`; request size limit ≥ `MAX_UPLOAD_MB` |
| Environment | `NODE_ENV=production`, `DATABASE_URL`, `CORS_ORIGINS`, `PUBLIC_APP_URL`, `HOST=0.0.0.0`; optional `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `REPORT_MAX_ROWS`, SMTP settings |
| Install | `npm ci --omit=dev` in `server/` (development-only tools such as `pglite-tools` are not needed in production) |
| Health checks | load balancer / uptime monitor on `GET /health/ready` |
| Web hosting | single-page rewrite to `index.html`, `.wasm` content type, strict CSP (below) |
| Mobile | EAS builds with `EXPO_PUBLIC_API_URL` set to the HTTPS API address |

## Production release procedure (not yet run against real infrastructure)

1. Back up: `npm --prefix server run backup -- --out <folder>` (`backup-recovery.md`), plus a managed snapshot.
2. Deploy the API; it runs migrations on start (or run `migrate` as a release step).
3. Check `GET /health/ready` returns 200 (`"migrations": "ok"`).
4. Publish the web build (`npx expo export --platform web`) to static hosting with a strict CSP, e.g.
   `default-src 'self'; connect-src 'self' https://<api host>; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'`.
   The Google Fonts entries load the Roboto font (`src/global.css`); remove them to self-host the font or use system fonts.
5. Mobile: `npx eas-cli@latest build` for store/MDM distribution. Expo Go is for development only.
