# Requirements

Source: the project master brief (University Asset Tracking System). IDs are referenced by tests and
the acceptance report.

## Functional requirements

### Accounts and access (FR-A)
- FR-A1 Admins create staff accounts with role and department.
- FR-A2 Staff submit access requests (name, institutional email, department, requested role, justification, chosen password); states pending/approved/rejected.
- FR-A3 Pending or rejected requesters cannot access protected data or perform operations.
- FR-A4 Admins approve (assigning final role + department) or reject (with reason).
- FR-A5 Admins activate/deactivate accounts and change roles/departments/scope grants.
- FR-A6 No public self-registration grants access automatically.
- FR-A7 Email/password sign-in; password reset via expiring single-use token; lockout after repeated failures.
- FR-A8 Sessions revoked on deactivation and password change; permission changes effective next request.
- FR-A9 All account actions audited.

### Assets (FR-R) — Phase 2
- FR-R1 Scan or type manufacturer barcode; optional product lookup with source labelling; manual fallback.
- FR-R2 Mandatory: name, serial number, department, location, acquisition date, cost + currency (or audited unknown-cost exception), category, condition.
- FR-R3 Duplicate warnings (serial, institutional ID, barcode+serial); shared barcode alone never blocks.
- FR-R4 Unique institutional ID + QR, safe for concurrent and offline registration.
- FR-R5 Configurable label templates; preview; print; reprint reuses identity; printing never creates assets.
- FR-R6 Registration completes only after label attachment and a confirming scan.
- FR-R7 Post-registration review: approve or return for correction; history of changes with before/after.

### Verification and movement (FR-V) — Phase 3
- FR-V1 QR scan records verification event (event time, received time, user, department, location, outcome).
- FR-V2 Recurring schedules by department/category; due/overdue states; overdue ≠ missing.
- FR-V3 Location discrepancy flags.
- FR-V4 Relocation with full movement history, separate from verification.

### Condition and maintenance (FR-M) — Phase 4
- FR-M1 Condition history and damage reports with photos.
- FR-M2 Department-managed maintenance requests with configurable statuses, costs (with currency), provider, outcome, and authorised condition confirmation.

### Dashboard and reports (FR-D) — Phase 5
- FR-D1 Five dashboard sections from live data, totals per currency, linked to filtered lists.
- FR-D2 Four reports with filters; valid PDF and XLSX exports; permission-scoped.

### Offline (FR-O) — Phase 6
- FR-O1 Offline queue for fieldwork operations, persistent across restarts, with visible sync states.
- FR-O2 Idempotent sync, conflicts preserved for review, event time preserved.

### Audit and notifications (FR-L)
- FR-L1 Append-only audit log with actor, action, target, time, before/after, outcome.
- FR-L2 In-app notifications for due/overdue verification, discrepancies, review returns, maintenance changes, sync failures, pending access requests.

## Non-functional requirements

- NFR-1 Security: server-side authorisation on every protected operation; Argon2id; HTTPS in deployment; rate limits; no secrets in source or logs.
- NFR-2 Integrity: constraints, transactions, no physical deletion of historical records.
- NFR-3 Usability: responsive phone/tablet/desktop; accessible labels; status never shown by colour alone.
- NFR-4 Performance: paginated lists (default 50/page); indexed searches. Target (to be validated in Phase 7): list and dashboard requests < 1 s at 100k assets on a small managed DB.
- NFR-5 Maintainability: documented architecture, migrations, automated tests runnable with one command.
- NFR-6 Recoverability: automated backups, PITR, tested restore procedure.
