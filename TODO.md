# TODO

Follow-ups from the 2026-09-09 settings-read incident review. None of these are
regressions from that fix; they are adjacent weaknesses the review surfaced.

## Deploy pipeline (production host, not in this repo)
- [ ] `/opt/hiregnome-ops/autodeploy.sh` should run `npx prisma migrate deploy`
	  **unconditionally** and abort on a non-zero exit before the build/swap, rather
	  than trying to detect whether a migration is pending. `migrate deploy` is
	  idempotent, and the detection is what let a pending migration ship without
	  applying. The script lives outside version control, so its logic is unreviewed.
- [ ] Never hand-apply a migration without recording it in `_prisma_migrations`:
	  every later `migrate deploy` fails on it, silently, until something depends on
	  a newer migration. Check `npx prisma migrate status` on production.

## Read-then-write hazards elsewhere
- [ ] `app/api/onboarding/setup/route.js` still decides whether to create the
	  SystemSetting row from a swallowed read (`lib/onboarding.js`), so a failed read
	  can create a duplicate row. `findFirst(orderBy: id asc)` would then keep
	  returning the original and silently discard every later save.
- [ ] `app/api/system-settings/route.js` uploads a new logo to object storage
	  *before* the database write. A failed write leaves an orphaned object with
	  nothing referencing it, and nothing cleans it up.

## Error reporting
- [ ] `assertObjectStorageConfigured()` reports "not configured" on download/delete
	  when the real cause is an unreadable settings row, steering an admin toward
	  re-entering settings that are intact.
- [ ] `app/api/candidates/route.js` and `app/api/candidates/[id]/files/route.js`
	  collapse upload errors into a generic 500, so a degraded system looks like a
	  random failure to the user.

## Cost
- [ ] `/sitemap.xml` is now request-time rendered (it had to be - see
	  `docs/OPERATIONS.md`), which means uncached DB queries per crawler hit with no
	  rate limit. Consider a short in-process cache if it shows up in load.
