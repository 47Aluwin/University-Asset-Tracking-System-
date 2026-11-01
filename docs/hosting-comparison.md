# Hosting comparison: managed cloud vs. university-hosted

Status: Phase 0 evaluation, 2026-10-28. **All prices are estimates from public/third-party listings
gathered on that date, not quotations.** Confirm with providers before budgeting.

## Assumptions (to be confirmed by the university)

- Users: ~20 departments, 50–300 staff accounts, low concurrency (tens of simultaneous users).
- Assets: 10,000–100,000 records; verification/movement events grow by tens of thousands per year.
- Photos: ~2 per damage report, resized to ≤ 1 MB → low tens of GB over several years.
- University location / data-residency rules: **unknown**. Region choice depends on them.
- Internet reliability on campus: **unknown**. The mobile app's offline mode reduces, but does not remove,
  dependence on connectivity.

## Option A — Managed cloud

Example price points found (USD, per month, single small instance):

| Component | Example | Estimate | Source / status |
|---|---|---|---|
| Managed PostgreSQL | DigitalOcean Basic 1 GB node | ~$15 | Third-party listings agree on ~$15; HA standby roughly doubles+ cost. Unverified on official page. |
| Managed PostgreSQL | AWS RDS db.t4g.micro, Africa (Cape Town) | ~$15 + storage + backups | Third-party (Sparecores/Bytebase) ~$0.021/h single-AZ. Unverified on AWS page. |
| Managed PostgreSQL | Render paid Postgres | price not obtained | Render docs: PITR on all paid DBs, 3-day window (Hobby) / 7-day (Pro+). |
| API container | small app instance (any of the above providers) | ~$5–25 | Typical small-instance range; confirm. |
| Object storage | S3-compatible bucket | ~$5 + usage | Typical entry pricing; confirm. |
| **Indicative total** | small production deployment | **~$40–100/month** before HA; **~$100–200** with DB standby | Estimate. |

Strengths: automated backups and PITR, security patching of the DB host, monitoring, quick provisioning,
predictable small recurring cost, no hardware to maintain.
Weaknesses: recurring cost in foreign currency; vendor dependency; data leaves campus (policy check
needed); depends on campus internet uplink.

## Option B — University-hosted

Cost items the university must price itself (cannot be estimated here): server hardware or VM capacity,
UPS/generator, storage for backups, off-site backup copies, public IP/firewall/reverse proxy and TLS
certificates, staff time for OS/DB patching, monitoring, backup testing and on-call.

Strengths: data stays on campus; no per-month vendor bill; usable on the campus LAN during internet outages.
Weaknesses: needs reliable power, cooling, and a skilled DBA/sysadmin; PITR, off-site backups and restore
testing must be built and maintained in-house; remote/off-campus access requires exposing services
securely; single-site disaster risk.

## Decision matrix (1 = poor, 5 = strong; weighted)

| Criterion | Weight | A: Managed cloud | B: University-hosted |
|---|---|---|---|
| 1. Initial and recurring cost | 3 | 3 (low setup, ongoing fee) | 3 (hardware/staff cost unknown; no fee) |
| 2. Security and access control | 3 | 4 (patched, TLS, IAM) | 3 (depends on local expertise) |
| 3. Reliability and availability | 3 | 4 | 2–3 (power/network dependent) |
| 4. Backup and recovery | 3 | 5 (automated + PITR) | 2 (must be built and tested) |
| 5. Connectivity / offline needs | 2 | 3 (needs internet) | 4 (works on campus LAN) |
| 6. Data residency / policy | 2 | ? (depends on policy and region) | 5 |
| 7. Support and maintenance workload | 3 | 4 | 2 |
| 8. Expected volumes | 1 | 5 | 5 (volumes are small) |
| 9. Vendor dependency / portability | 1 | 3 (plain PostgreSQL keeps it portable) | 5 |
| 10. Long-term sustainability | 2 | 4 | 3 |
| **Weighted total** out of 115 (policy scored 3 for A; reliability 2.5 for B) | | **88** | **71.5** |

## Recommendation

**Option A, managed cloud, with plain PostgreSQL and S3-compatible storage**, in the closest region
that satisfies the university's data-residency policy. Reason: backups, PITR, patching and monitoring
are the hardest parts to do well in-house and are included. Because the stack uses only standard
PostgreSQL, a container, and S3-compatible storage, it can move to university infrastructure later
without code changes.

Choose Option B instead if: policy forbids hosting outside the university, **or** the campus internet
uplink is unreliable enough that on-campus users would routinely lose access.

## The university must confirm before committing

1. Data-residency and privacy rules for staff personal data and asset financial data.
2. Budget owner and payment method for recurring cloud fees (and currency).
3. Campus internet reliability and whether off-campus access is required.
4. Whether existing servers, backup storage, and DBA staff are available (if Option B is considered).
5. Required recovery objectives (see `backup-recovery.md` for proposed RPO/RTO).
6. A written provider quotation in the chosen region.

## Sources (accessed 2026-10-28)

- DigitalOcean PostgreSQL pricing (official page, not fetched): https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
- InfraTally DigitalOcean Managed PostgreSQL review: https://infratally.com/articles/digitalocean-managed-postgres-deep-dive/
- Render Postgres PITR and backups docs: https://render.com/docs/postgresql-backups and https://render.com/docs/postgresql-refresh
- Sparecores db.t4g.micro listing: https://sparecores.com/database/aws/db.t4g.micro
- Bytebase RDS db.t4g.micro pricing: https://www.bytebase.com/dbcost/rds/instance/db.t4g.micro/
- AWS T4g availability in Cape Town (2023): https://aws.amazon.com/about-aws/whats-new/2023/08/amazon-rds-t4g-instances-6-regions
