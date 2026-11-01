# Architecture

Status: Phase 0 baseline (2026-10-28). Update this document whenever a decision changes.

## 1. Starting point

The repository began as an unmodified `create-expo-app` template (Expo SDK 57, Expo Router,
React Native 0.86, React 19, TypeScript). There was no backend, database, or domain code. The template
screens are replaced; the Expo configuration, theme tokens, and tooling are kept.

Development machine findings (recorded so the environment is reproducible):

| Tool | Found | Consequence |
|---|---|---|
| Node.js 24.19 / npm 11.19 | Yes | Server runs TypeScript directly via Node's built-in type stripping. No build step needed for dev/test. |
| Git 2.49 | Yes | Source control. |
| PostgreSQL | **No** | Local dev and automated tests use **PGlite** (real PostgreSQL 17 compiled to WebAssembly, runs in-process). Production uses a normal PostgreSQL server via `DATABASE_URL`. Same SQL and migrations for both. |
| Docker | **No** | No container-based local stack. Deployment docs include a Dockerfile for the hosting environment, but it is not tested locally. |
| MySQL 8 / SQL Server | Installed, credentials unknown | Not used. PostgreSQL is chosen on technical merit (see §3). |
| Free disk on C: | ~6.6 GB | Dependencies are kept lean. |

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Client (mobile + browser) | Expo SDK 57 + React Native + React Native Web, Expo Router | Required by brief; one codebase for iOS, Android, and browser. |
| Camera / QR / barcode | `expo-camera` (`CameraView` barcode scanning) | Maintained Expo module, works in Expo Go; browser falls back to manual entry where camera scanning is unsupported. |
| Local secure storage | `expo-secure-store` (native), `sessionStorage` (web) | Session token stored in the OS keychain/keystore on devices. |
| Offline store (mobile) | `expo-sqlite` | Durable queue of pending operations that survives restarts. |
| Printing | `expo-print` (native OS print dialog / browser print) | Covers standard printers with label sheets and OS-supported label printers. See `qr-printing.md`. |
| API server | Node.js 24 + **Fastify 5** + **Zod 4** | Small, fast, well-maintained; schema validation on every request; mature rate-limit / security-header plugins. |
| Database | **PostgreSQL** (production), **PGlite** (dev/test) | Strong transactions, constraints, sequences, JSONB for audit diffs, row locking for safe ID allocation, mature managed offerings and PITR. |
| DB access | Plain parameterised SQL through a thin adapter (`server/src/db`) | Transparent, no ORM magic, identical on PGlite and `pg`. |
| Migrations | Numbered `.sql` files + a small runner that records applied versions | Reviewable, forward-only, works on both engines. |
| Password hashing | Argon2id via `@node-rs/argon2` (prebuilt binaries, no compiler needed) | Current OWASP-recommended algorithm. |
| Sessions | Opaque random tokens, stored only as SHA-256 hashes in `sessions` | Revocable instantly (deactivation, password change); no JWT signing-key management. |
| Reports | `exceljs` (XLSX), `pdfkit` (PDF), server-side | Real file formats generated from database queries; permissions enforced server-side. |
| Tests | Node's built-in test runner (`node --test`) against PGlite | Zero extra dependencies, real PostgreSQL semantics, each test file gets a fresh database. |

## 3. Why PostgreSQL rather than the installed MySQL

Both are viable. PostgreSQL is chosen because: (a) PGlite allows the full test suite to run against
real PostgreSQL without installing a server or knowing credentials; (b) `SELECT ... FOR UPDATE`, sequences,
partial unique indexes, CHECK constraints and JSONB cover the business rules directly; (c) every major
managed host offers PostgreSQL with point-in-time recovery. Switching to MySQL later would require
rewriting migrations and a few queries; it is not planned.

## 4. Component architecture

```
 ┌──────────────────────────── Expo app (one codebase) ───────────────────────────┐
 │  Phone / tablet (iOS, Android)              Browser (React Native Web)          │
 │  - scan, register, verify, move,            - administration, review queues,    │
 │    condition, maintenance                     dashboards, reports + exports     │
 │  - offline queue (expo-sqlite)              - online only (no offline queue)    │
 │  - token in SecureStore                     - token in sessionStorage           │
 └───────────────┬─────────────────────────────────────────┬──────────────────────┘
                 │ HTTPS, JSON, Authorization: Bearer <token>
                 ▼                                         ▼
 ┌──────────────────────────── API server (Fastify) ──────────────────────────────┐
 │  auth · users · access requests · departments · assets · labels · review ·     │
 │  verification · movements · condition · maintenance · dashboard · reports ·    │
 │  sync (batched idempotent operations) · attachments · audit                    │
 │  Every route: authenticate → authorise (role + department scope) → validate    │
 │  → transaction → audit                                                         │
 └───────────────┬───────────────────────────────────────┬────────────────────────┘
                 ▼                                       ▼
        PostgreSQL (one central DB)          Attachment storage (local disk in dev;
        all departments, all history          S3-compatible object storage in prod)
```

No microservices. One API process (scale horizontally behind a load balancer if needed — the API is
stateless; all state is in PostgreSQL and object storage).

## 5. Data flow

1. **Online action** (e.g. relocate asset): client sends request with a client-generated `operationId`
   → server authenticates the session, checks permission and department scope, validates input, runs the
   change and its audit event in one transaction, stores the `operationId` → responds "accepted".
2. **Offline action**: client writes the operation into the local SQLite queue with status
   *Locally saved* and the real event time → when connectivity returns, the sync worker posts batches to
   `/sync` → server processes each operation idempotently (same `operationId` never applied twice) and
   returns per-operation results: accepted, rejected (with reason), or conflict → client updates status.
3. **Reads** come from the server. The mobile app caches recently viewed assets and the user's
   department reference data for offline lookups; cached data is marked as such.

## 6. Authentication and authorisation (summary)

See `access-control.md` and `security.md`. Email + password; Argon2id; progressive lockout; expiring
single-use reset tokens; opaque session tokens checked on every request against the current user row,
so deactivation and permission changes take effect on the next request.

## 7. Deployment model

Recommended: managed cloud (see `hosting-comparison.md`) — one managed PostgreSQL instance with automated
backups and PITR, one small container/app service for the API, object storage for photos, static hosting
for the web build, EAS Build for mobile binaries. Environment configuration via environment variables only
(`server/.env.example` lists them with placeholder values).

```
  Staff phones ──┐                     ┌── Managed PostgreSQL (PITR, daily snapshots)
                 ├─ HTTPS ─▶ API app ──┤
  Browsers ──────┘   (TLS)  (container)└── Object storage (attachments, versioned)
       ▲
       └── static web build (CDN)          Mobile binaries: EAS Build → app stores / MDM
```

## 8. Offline synchronisation

See `offline-sync.md`. Key points: operation queue with unique IDs; idempotent server processing;
event time vs. server-received time stored separately; institutional IDs pre-reserved in blocks per
device so offline registration never collides; conflicts are stored, never silently overwritten.

## 9. External integrations

| Integration | Status | Notes |
|---|---|---|
| Product lookup by manufacturer barcode | Adapter interface only; **no provider configured** | See `decisions-and-limitations.md` §Product lookup. Manual entry always works. |
| Email (password reset, notifications) | Adapter interface; dev prints to server console; **no SMTP configured** | Administrators can issue reset links as a fallback. |
| Push / SMS | Not implemented | In-app notifications only. |
| Label printers | Via OS print services | Dedicated printer SDKs not integrated. See `qr-printing.md`. |

## 10. Backup, recovery, monitoring

See `backup-recovery.md` and `operations.md` (written in Phase 7). Baseline: managed DB automated
backups + PITR, nightly logical dump to separate storage, versioned object storage, health endpoint,
structured JSON logs without secrets.
