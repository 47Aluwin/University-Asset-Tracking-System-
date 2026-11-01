# Access control

Authorisation = **role permission** AND **department scope**. Both are checked on the server for every
protected request (`server/src/authz.ts`). The client hides actions the user cannot perform, but this is
cosmetic only.

## Roles

There is **no Department Head role** and **no central maintenance team**.

| Role | Code | Scope |
|---|---|---|
| System Administrator | `SYSTEM_ADMIN` | All departments; user/role/department/settings administration. |
| Asset Management Team / Inventory Officer | `ASSET_MANAGER` | All departments, read + review/oversight. No user administration or system configuration. |
| Department Staff | `DEPARTMENT_STAFF` | Own department only, plus explicit grants. |

## Permission matrix

`own` = own department (or a department covered by an active grant). `all` = every department.

| Permission | SYSTEM_ADMIN | ASSET_MANAGER | DEPARTMENT_STAFF |
|---|---|---|---|
| `users.manage` (create, role/department change, activate/deactivate, issue reset) | all | – | – |
| `access_requests.review` | all | – | – |
| `departments.manage` | all | – | – |
| `settings.manage` (system settings, schedules, label templates, categories) | all | – | – |
| `scope_grants.manage` | all | – | – |
| `audit.read` (full audit log) | all | – | – |
| `departments.read` | all | all | all (list is public for access requests) |
| `assets.read` | all | all | own |
| `assets.read_financial` (acquisition cost, supplier, PO) | all | all | own |
| `assets.register` (create, confirm label attachment) | all | – | own |
| `assets.edit` | all | – | own |
| `labels.print` (print / reprint; read label layout) | all | – | own |
| `assets.archive` (archive a record **not yet registered**) | all | – | own |
| `assets.archive_registered` (archive a registered asset) | all | – | – |
| `assets.restore` (un-archive) | all | – | – |
| `locations.manage` (add / edit buildings and rooms) | all | – | own |
| `categories.manage` | all | – | – |
| `verification.record` (record a physical sighting) | all | – | own |
| `movement.record` (relocate; both departments for a transfer) | all | – | own |
| `missing.report` | all | – | own |
| `missing.confirm` (confirm or clear missing) | all | all | – |
| `flags.read` (review flags) | all | all | own |
| `flags.review` (resolve flags) | all | all | – |
| `schedules.manage` (verification schedules) | all | – | – |
| `condition.record` (update condition, report damage) | all | – | own |
| `maintenance.manage` (create and run requests, costs, photos) | all | – | own |
| `maintenance.read` (view requests and their photos) | all | all | own |
| `maintenance.approve` (only where the department requires approval; never one's own request) | all | – | own |
| `assets.review` (approve / return for correction; never blocks registration) | all | all | – |
| Submit corrections for a returned record (needs `assets.edit`) | all | – | own |
| `dashboard.read`, `reports.generate` | all | all | own |
| Reserve asset IDs for offline use (needs `assets.register`) | all | – | own |
| See offline edit conflicts (needs `assets.read`) | all | all | own |
| Apply or discard an offline edit conflict (needs `assets.edit`) | all | – | own |

Decisions:
- Dashboard and reports (Phase 5) use the same department scope as the data they show: staff see their own
  department (plus grants); a `read` grant shows counts but not money; access requests appear only for administrators.
- "Deleting" an asset archives it; nothing is physically removed. Staff may archive only their own
  department's records that have **not** completed registration (mistakes). Archiving a registered
  asset, or restoring any archived asset, is limited to System Administrators (Phase 2).
- Users without `assets.read_financial` for a department (e.g. holders of a read-only grant) see that
  department's assets without cost, currency, supplier or PO details, also in the asset history.
- Asset endpoints check permissions **before** opening a database transaction, so a denial is always
  audited even though the request fails; inside the transaction the row is re-read with a lock and
  the request is refused if the asset changed in between.
- Asset Managers oversee but do not perform departmental fieldwork by default. If they must, an admin
  issues a scope grant (audited) or the brief is revised.
- System Administrators hold all permissions. Production should have very few admin accounts.
- Department staff see financial details for their own department's assets (needed for registration).

## Cross-department exceptions (scope grants)

`user_scope_grants` lets an admin give a user `read` or `operate` access to another department, with a
mandatory reason and optional expiry. Grants are audited on creation and revocation and are checked
by the same scope function as the home department.

## Lifecycle rules

| Event | Behaviour |
|---|---|
| Access request submitted | Stored as `pending`; no account; sign-in returns "awaiting approval". |
| Approved | Admin assigns final role and department (may differ from requested). Account becomes active. Audited. |
| Rejected | Reason recorded; sign-in returns "not approved". Audited. |
| Department change | Takes effect on the next request (permissions read from DB each request). Existing sessions revoked to force a clean reload of cached client data. Audited with before/after. |
| Role change | Same as department change. |
| Deactivation (leaving) | All sessions revoked immediately; sign-in refused; history retained. Audited. |
| Password change / reset | All other sessions revoked. Audited (no secrets logged). |

## Anti-escalation rules

- Only `SYSTEM_ADMIN` can change roles, departments, status, or grants.
- An admin cannot deactivate or demote themselves (prevents lock-out); the last active admin cannot be removed.
- Request bodies cannot set fields the actor is not allowed to set (Zod schemas reject unknown keys).
- `DEPARTMENT_STAFF` records always carry a department; the server ignores client-supplied department
  for scoped operations unless the user is authorised for that department.
