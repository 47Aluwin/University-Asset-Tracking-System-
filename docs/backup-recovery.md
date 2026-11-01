# Backup and recovery

Backup policy, restoration procedure, recovery objectives and test results (brief §27 item 11). Written in Phase 7
(2026-10-31). **(tested)** marks steps performed in this environment; production steps depend on the hosting, which
has not been chosen (`hosting-comparison.md`).

## 1. What a backup contains and how it is taken

A backup = the database + the uploaded files (`UPLOAD_DIR`) + `manifest.json` (row count of every table and the
SHA-256 of every file), written to a new folder; an existing backup is never overwritten.

**Production (PostgreSQL)**
1. Daily, in a quiet period (e.g. 02:00 Port Moresby time): `npm --prefix server run backup -- --out <folder>`
   with `DATABASE_URL` and `UPLOAD_DIR` set. This runs `pg_dump --format=custom` (PostgreSQL client tools must be
   installed, same major version as the server) and copies the files.
   A managed database's own point-in-time recovery should be switched on as well; this backup adds the files and
   a checkable manifest.
2. Copy the folder off the server (a different account/region), encrypted at rest. Keep 30 daily and 12 monthly.
3. Counts are taken just after the dump; if users are active during the backup, a table may show slightly more rows
   than the dump contains. Run in a quiet period, or treat counts as "at least" when checking.

**Development (embedded database)** **(tested)**: stop the API (the embedded database allows one program at a time —
the command refuses to run while the API answers), then `npm --prefix server run backup`. Backups go to
`server/backups/` (git-ignored).

## 2. Restore

Restores always go into a **new, empty** database and file folder; nothing is restored over live data.

**Production**
1. Create an empty PostgreSQL database (same major version).
2. `pg_restore --no-owner --dbname "<new DATABASE_URL>" <backup>/database.dump`
3. Copy `<backup>/uploads/` into the new `UPLOAD_DIR`.
4. Check: `DATABASE_URL=<new> UPLOAD_DIR=<new> npm --prefix server run restore -- <backup> --verify-only`
   — compares every table's row count, every file's SHA-256, that each attachment's file exists, and the migration
   history. Do not switch over unless it says "Check passed".
5. Point the API at the new database (`DATABASE_URL`), start it, confirm `GET /health/ready` is 200, sign in and
   open a few recent assets and photos.

**Development** **(tested)**:
`npm --prefix server run restore -- <backup> --data-dir <new folder> --upload-dir <new folder>` restores and runs
the same check.

## 3. Restore drill — 2026-10-31 **(tested)**

| Step | Result |
|---|---|
| Back up the development database (27 tables, 49 rows, 4 photos) | done, `server/backups/2026-10-31T13-37-16-750Z` |
| Restore into a new empty folder | done in about 7 seconds |
| Check against the manifest | **passed** (row counts, file checksums, attachment files, migrations) |
| Damage one restored photo, check again | **failed as expected**, naming the file; passed again after repair |
| Start a second API on the restored copy | applied the newer migration, `GET /health/ready` → ready |
| Automated test (`server/test/backup.test.ts`) | backup → restore → the app signs in on the restored data, opens the asset, downloads the photo byte-identical, audit log still append-only, next asset ID continues the sequence |

Recovery time objective proposed: 4 hours; recovery point objective: 24 hours (daily backup) or minutes with the
managed database's point-in-time recovery. **To confirm with the university** (D38).


## 4. What is not yet verified

- Production `pg_dump` / `pg_restore` against a real PostgreSQL server (no server or client tools here). The same
  check (`restore -- --verify-only`) is used, and the production database driver itself is tested
  (`npm --prefix server run test:pg-wire`).
- Off-site copy, encryption at rest and retention: depend on the chosen hosting.
- Recovery objectives (D38) need the university's agreement.
