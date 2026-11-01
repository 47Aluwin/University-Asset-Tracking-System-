# Offline operation and synchronisation

Status: **implemented in Phase 6 (2026-10-31)**, tested against the real API; not yet tried on a phone.
The design below was written in Phase 0; "As built" lists where the implementation differs.

## As built (Phase 6)

- **No separate `/sync` endpoint.** Saved actions are sent to the normal endpoints with `X-Operation-Id`, so every
  validation and permission rule applies exactly as online. Every write used offline is repeat-safe (stored reply in
  `api_operations`, or a unique `operation_id` on the event table).
- **Queue:** `shared/offline-queue.ts` (pure TypeScript; storage and network supplied by the app). Phones store it in
  SQLite (`pending_ops`, `kv`) via `src/lib/offline/storage.ts`; the web uses memory only and stays online-only.
- **Statuses shown:** saved — waiting to send / sending / sent and accepted / server problem — will retry / not
  accepted / conflict — needs review.
- **Retries:** network failure → wait for the connection (checked on reconnect, on returning to the app and every
  minute); server errors (5xx, 408, 429) → 15 s, 30 s, 1 min … up to 1 hour; other refusals are not retried.
  An expired sign-in pauses sending until the person signs in again.
- **Dependencies:** an action can use a value from an earlier action's reply (e.g. the new condition record's id
  for its photo). If the earlier one is refused, the later ones are held back with a clear reason.
- **ID blocks:** 20 IDs are reserved while online and topped up when fewer than 5 remain; the app stops using an ID a
  day before its 30-day expiry. The server accepts a reserved ID from the person who reserved it even after expiry
  (the label may already be on the asset). With no ID left, the registration is saved without one and the label is
  printed after it syncs.
- **Conflicts:** offline edits carry `baseValues` (what the phone showed for each changed field). If those fields are
  unchanged on the server the edit is applied, even if other things changed meanwhile; otherwise it is stored in
  `sync_conflicts` and shown for review. Resolving re-runs the edit through the normal endpoint as the reviewer.
- **Photos** are copied into the app's documents folder until uploaded, then deleted. Phones do not yet send a SHA-256
  for photos (no hashing library); the server's checksum check is in place and tested for clients that send one.

## Original design (Phase 0)

The server-side idempotency table (`api_operations`) was created in Phase 1 so every write endpoint could accept an
`operationId` from the start.

## Scope

Offline on **mobile** only: prepare registrations, record verification scans, relocations, condition
changes, damage reports with photos, maintenance requests and notes. The browser app is online-only and
says so when offline.

## Local storage

- `expo-sqlite` database `ats-local.db`:
  - `pending_ops(operation_id, type, payload_json, event_time, created_at, status, attempts, last_error, server_result_json)`
  - `cache_assets`, `cache_locations`, `cache_categories` — the user's department reference data and recently used assets.
  - `id_block` — reserved institutional IDs for offline registration.
- Session token in `expo-secure-store`. On sign-out or account deactivation the local cache and queue
  (after warning about unsynced items) are cleared.
- Photos stored in the app's private document directory until uploaded.

## Status shown to the user

`Locally saved` → `Awaiting sync` → `Syncing` → `Synced` | `Failed` (retryable or rejected with reason) | `Conflict — needs review`.
A locally saved item is never labelled as registered/accepted until the server confirms.

## Protocol

1. Each operation gets a UUID `operation_id` when created and keeps it forever.
2. `POST /sync` with up to 50 operations in event-time order. Each carries `operation_id`, `type`,
   `event_time` (device clock, UTC) and `base_version` for edits.
3. The server, per operation, in its own transaction: if `operation_id` is already in `api_operations`,
   return the stored result (idempotent replay). Otherwise authorise, validate, apply, store the result.
4. Server records `received_at` separately from `event_time`. Event times in the future (> 5 min skew)
   are rejected; very old event times are accepted but flagged.
5. Client retries with exponential back-off (max 1 h). Rejections are not retried automatically.

## Institutional IDs offline

While online, the device reserves a block (default 20) of institutional IDs:
`asset_id_reservations(id, user_id, device_id, start_seq, end_seq, expires_at)`, allocated in a
transaction with a row lock on the year's counter. Offline registrations consume IDs from the block, so
labels can be printed and attached offline with a final ID. Unused reserved IDs expire after 30 days;
gaps in the sequence are expected and documented (IDs are never reused). If the block runs out,
registration continues as a draft with a provisional local reference (`LOCAL-<uuid>`) that **cannot be
printed**; the label is printed once sync assigns the official ID.

## Conflicts

- Append-only events (verification scans, condition events, movement events) never conflict. They are
  recorded with their event time; current-state fields update only if the event is newer than the last applied one.
- A movement whose `from_location` no longer matches the server's current location is applied as a
  history event but flagged `location_discrepancy` for review.
- Edits to asset details use `base_version`. If the server row changed since then, the operation is
  stored in `sync_conflicts` with both versions; nothing is overwritten until an authorised reviewer resolves it.
- No blanket "latest timestamp wins".

## Tests (Phase 6)

Duplicate submission, retry after timeout, restart with pending queue, simultaneous edits, partial photo
upload (checksum mismatch rejected), ID block exhaustion, clock skew.
