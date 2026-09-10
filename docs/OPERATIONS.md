# Operations Runbook

## 1) Release Gate (CI)

CI workflow file:
- `.github/workflows/ci.yml`

Jobs:
- `build`: dependency install + production build.
- `api-smoke`: MySQL-backed smoke run:
	- apply migrations
	- start app
	- wait for `/api/health`
	- run permissions smoke tests

Local equivalent:
```bash
npm run ci:preflight
npm ci
npm run ci:build
```

Server deploy equivalent:
```bash
npm ci
npm run build:deploy
```

## 2) Backups

### One-off backup
```bash
npm run db:backup
```

### Scheduled backup with retention pruning
```bash
npm run db:backup:scheduled
```

Config:
- `DB_BACKUP_DIR` (default: `.backups`)
- `DB_BACKUP_RETENTION_DAYS` (default: `14`)

### Production install for `careers.darumatic.com`
Install the checked-in systemd timer on the VPS:
```bash
sudo bash scripts/install-nightly-backup-systemd.sh
```

Defaults:
- unit name: `hire-gnome-db-backup`
- schedule: daily at `2:15 AM` server local time (`*-*-* 02:15:00`)
- rotation: prune backups older than `DB_BACKUP_RETENTION_DAYS`

Useful overrides:
```bash
sudo BACKUP_RUN_USER=deploy \
  BACKUP_ON_CALENDAR='*-*-* 03:30:00' \
  BACKUP_SYSTEMD_NAME=hire-gnome-db-backup \
  bash scripts/install-nightly-backup-systemd.sh
```

Verify:
```bash
systemctl list-timers hire-gnome-db-backup.timer
systemctl status hire-gnome-db-backup.timer
journalctl -u hire-gnome-db-backup.service -n 100 --no-pager
```

Manual run:
```bash
systemctl start hire-gnome-db-backup.service
```

### Cron alternative (daily at 2:15 AM)
```cron
15 2 * * * cd /opt/hire-gnome-ats && /usr/bin/env npm run db:backup:scheduled >> /var/log/hire-gnome-backup.log 2>&1
```

## 3) Restore

Restore from a SQL dump:
```bash
npm run db:restore -- --input .backups/ats-backup-YYYYMMDD-HHMMSS.sql --drop-first
```

Flags:
- `--input <file>` required.
- `--drop-first` optional; drops/recreates target DB before restore.

## 3.1) Dependency Security

- Dependabot alerts on this repo have so far all been transitive (`package-lock.json`). Fix them by bumping the direct dependency that pulls them in (for `postcss`/`sharp` that is `next` + `eslint-config-next`, kept on the same version) and running `npm update <pkg>` for the rest, which moves transitive instances to the newest version inside their existing ranges; check with `npm ls <pkg> --all` and `npm audit`. Only reach for `overrides` when the range itself is too old.
- `npm audit` also flags `deepmerge-ts` (< 8) through `@prisma/config`, which is only used by the Prisma CLI. It is pinned to `^8` via `overrides` in `package.json`; `prisma generate`, `prisma validate` and `prisma migrate status` were verified with it. Drop that override once the Prisma version in use depends on `deepmerge-ts` 8+ itself.
- After pushing a dependency change, confirm on GitHub that the alerts closed: `gh api "repos/<owner>/<repo>/dependabot/alerts?state=open" --jq length` should print `0`.

## 4) Health Monitoring

Run health check:
```bash
npm run health
```

Use a custom URL + one-off alert webhook:
```bash
npm run health -- http://localhost:3000/api/health --alert-webhook "https://example.com/webhook"
```

Env:
- `HEALTH_ALERT_WEBHOOK_URL`
- `HEALTH_ALERT_SOURCE` (default: `hire-gnome-ats`)

### `/api/health` is the deploy's rollback contract

The production autodeploy rolls back when `/api/health` does not return 200, so
anything the app cannot function without has to be represented there. A reachable
database is not sufficient evidence of a working app: the database can answer
`SELECT 1` while the `SystemSetting` row is unreadable, which reverts branding to
built-in defaults and switches the public careers site off.

`/api/health` therefore reports `systemSettings: { ok, error, since }` and returns
**503** when that read fails, so a deploy that breaks it is rolled back instead of
going live. When adding a dependency the app cannot run without, add it to this
endpoint's status too, or the deploy gate cannot see it.

## 4.1) API Trace Headers

All API responses include:
- `x-request-id` (correlates request across proxy/API logs)
- `x-response-time-ms` (route execution timing)
- `server-timing: app;dur=<ms>`

Use these in reverse-proxy logs and incident debugging.

## 5) Error Alert Hooks

API errors are logged and can send webhook alerts from server runtime.

Env:
- `ERROR_ALERT_WEBHOOK_URL`
- `ERROR_ALERT_MIN_LEVEL` (default: `error`)
- `ERROR_ALERT_COOLDOWN_SECONDS` (default: `300`)
- `ERROR_ALERT_SOURCE` (default: `hire-gnome-ats`)

Recommended:
- Use an incident channel webhook (PagerDuty/Opsgenie/Slack middleware).
- Keep cooldown at 2-5 minutes to avoid noise bursts.

## 5.1) Papertrail Shipping

Application logs are always written to process stdout/stderr in structured JSON.
Papertrail forwarding is optional and uses UDP syslog when configured.

Enable by setting:
- `PAPERTRAIL_HOST`
- `PAPERTRAIL_PORT`

Optional:
- `PAPERTRAIL_MIN_LEVEL` (`debug|info|warn|error`, default `info`)
- `PAPERTRAIL_APP_NAME` (default `hire-gnome-ats`)
- `PAPERTRAIL_FACILITY` (`0-23`, default `16` / `local0`)

If `PAPERTRAIL_HOST` or `PAPERTRAIL_PORT` is missing, shipping is disabled and logs remain local to stdout/stderr only.

## 6) Build-Time DB Behavior

By default the app skips System Settings DB reads during `next build` to keep SSG stable without DB access.

Env:
- `SKIP_SYSTEM_SETTINGS_DB_DURING_BUILD`:
	- `true` (default): uses safe defaults during build.
	- `false`: allows DB reads during build if DB is reachable.

Because of this skip, **any statically generated route that reads system settings
bakes in the defaults at build time and never reflects the database.** That is why
`app/robots.js` and `app/sitemap.js` declare `export const dynamic = 'force-dynamic'`:
without it they render the "career site disabled" variant permanently, publishing a
`Disallow: /careers` robots.txt and an empty sitemap even while the careers site is
live. Any new route reading settings must be request-time rendered for the same reason.

### A settings read must never fail open

`readSystemSettingRecord()` distinguishes "there is no settings row yet" from "the
read failed", and the difference is load-bearing:

- Read paths (`getSystemSettingRecord()`) still degrade to defaults so the app stays
	up, but the failure is logged and recorded, never swallowed.
- Write paths must refuse. `PATCH /api/system-settings` returns 503 when the read
	failed, because the settings form posts every field on save - saving against a
	failed read writes the blank form over stored credentials and branding, permanently.
- `uploadObjectBuffer()` refuses to use the local-disk fallback when the settings
	could not be read. The fallback is for deployments with no object storage
	configured; taking it because the config was *unreadable* silently writes uploads
	to a server filesystem that no backup covers, while the row records `local`.

The failing read is normally schema drift: the code expects a column the database
does not have. `prisma migrate deploy` is idempotent - run it unconditionally on
deploy and abort on a non-zero exit rather than trying to detect whether a migration
is pending, and never hand-apply a migration without recording it in
`_prisma_migrations`, or every later `migrate deploy` fails on it.

## 7) Career Site Anti-Abuse Guard

Career-site quick-apply submissions use layered controls:
- IP/network mutation throttle (`CAREERS_APPLY_* rate-limit envs`)
- honeypot field check
- minimum form fill timing guard (`CAREERS_APPLY_MIN_FORM_FILL_SECONDS`, default `2`)

Set `CAREERS_APPLY_MIN_FORM_FILL_SECONDS=0` to disable timing checks.

## 8) Custom Field Export/Import Sanity Check

Use this after upgrades, environment migrations, or backup/restore tests.

1. In `Admin > Custom Fields`, confirm at least one custom field exists for each target module (`Candidates`, `Clients`, `Contacts`, `Job Orders`, `Submissions`, `Interviews`, `Placements`).
2. In `Admin > Data Export`, run a `ZIP` export and download the file.
3. Verify the export contains `data/customFieldDefinitions.json`.
4. In a test environment, go to `Admin > Data Import`, upload the export file, and run `Preview Import`.
5. Confirm preview counts include `Custom Fields` and expected entity totals.
6. Run `Apply Import`.
7. Re-open `Admin > Custom Fields` and confirm definitions are present and ordered correctly.
8. Open one record form per module and verify:
	- custom fields render,
	- required custom fields block save when empty,
	- saved values persist after refresh.

Import behavior notes:
- Custom field definitions are applied before entity upserts.
- Definitions are upserted by `recordId` first, then by `(moduleKey, fieldKey)`.
- Entity `customFields` payloads for clients, contacts, candidates, job orders, submissions, interviews, and placements are imported when present.

## 9) Postmark Inbound Email Webhook

Endpoint:
- `POST /api/inbound/postmark`

Authentication:
- Public route by default.
- If `POSTMARK_INBOUND_WEBHOOK_SECRET` is set, pass it either:
	- as query string: `/api/inbound/postmark?secret=...`
	- or header: `x-webhook-secret: ...`

Processing behavior:
- Extracts email addresses from inbound JSON payload fields.
- Matches against:
	- `Candidate.email`
	- `Contact.email`
- Creates an `Email` note on each matched candidate/contact.
- Saves supported attachments to matched candidates only.
- Does not save attachments to contacts.
- Dedupes by Postmark `MessageID`.

Attachment notes:
- Candidate attachments are only saved when the inbound payload includes actual attachment bytes, not metadata-only attachment objects.
- Common inline/signature image noise is skipped.
- Generic email MIME types like `application/octet-stream` are accepted when the file extension is allowed.

Validation and diagnostics:
- Recent inbound events are visible in `Admin Area > System Settings > System Diagnostics`.
- Diagnostics includes:
	- subject
	- sender
	- processing status
	- candidate/contact match counts
	- notes created
	- candidate files saved
	- attachment skip reasons when applicable

Recommended Postmark webhook URL:
```text
https://your-domain.example/api/inbound/postmark
```

Recommended secured URL when using a shared secret:
```text
https://your-domain.example/api/inbound/postmark?secret=YOUR_SECRET
```
