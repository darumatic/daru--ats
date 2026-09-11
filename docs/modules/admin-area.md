# Admin Area

## What This Module Is For
Admin Area controls platform-level configuration, access, diagnostics, and operational safety.

## Main Areas
- System Settings
- Data Import
- Data Export
- Users
- Divisions
- Skills
- Custom Fields
- Billing (when enabled)
- API Errors

## System Settings
Configuration includes:
- Site name and logo
- Theme preset
- Public careers hero headline/body copy
- Career site enabled/disabled
- Client review portal enabled/disabled
- API keys (Google, AI provider)
- Bullhorn API credentials for background export jobs
- SMTP/email configuration
- Storage configuration (S3/local fallback)
- Demo mode visibility/lock behavior
- System diagnostics and test email tools
- Recent inbound email event visibility inside diagnostics

### AI Provider
The AI features (resume parsing, candidate summaries, match explanations, email
drafts, interview questions, submission write-ups, job posting enhancement) all
run through one provider, selected in `Platform Settings`:

- `AI Provider` — `OpenAI` or `Google Gemini`. Gemini is reached through Google's
  OpenAI-compatible endpoint, so both use the same request format and the same
  API key field; only the base URL and model differ.
- `AI API Key` — a key belonging to the selected provider. An OpenAI key will not
  work against Gemini or vice versa, so change both together.
- `AI Model` — optional. Blank uses the provider default (`gpt-4o-mini` for
  OpenAI, `gemini-2.5-flash` for Gemini). The legacy `OPENAI_RESUME_MODEL`
  environment variable still overrides that default, but only while the provider
  is OpenAI: it names an OpenAI model, so on any other provider it would be sent
  verbatim and rejected.
- `Reasoning Model` — optional, and used **only** by candidate scoring; every
  other AI feature keeps using `AI Model`. Blank means "use the same model":
  unlike `AI Model` it does not fall back to a provider default, so no install
  starts paying for a reasoning model by accident. Models that reject a chosen
  temperature (the o-series, GPT-5, `*-thinking`) are recognised by name and
  sent none; the client also retries once without temperature when a provider
  rejects it, so a model newer than this build still works.

A record saved before this setting existed has no provider stored, which reads
as OpenAI — existing keys keep working untouched.

Structured replies are requested with a strict JSON schema. Google's
OpenAI-compatible endpoint accepts that block including `strict` (verified
against `gemini-flash-latest`), but it is documented as beta and drops or
rejects fields it does not support, so a schema rejection is retried once in
plain JSON mode with the schema restated in the prompt. Every response is
validated against the feature's own schema regardless, so a provider that
ignores the requested format produces a clean error rather than corrupt data.

Failed provider calls are logged server-side with the provider's own reason:
`ai.request.failed` (with `provider`, `model` and HTTP status), plus
`ai.response.empty`, `ai.response.invalid_json`, `ai.request.unavailable`, and
`ai.request.schema_rejected` as a warning when the retry recovers. The API key
is stripped from the logged detail. This matters most for resume parsing, where
an AI failure is deliberately non-fatal — the built-in parser answers instead,
so without the log a dead key looks like ordinary output. The parse response
names the parser that actually ran (`openai`, `gemini` or `fallback`).

When demo mode is enabled:
- the branding card remains editable and saveable
- integrations, SMTP/email delivery, and object storage stay read-only

Layout:
- `Branding`, `Platform Settings`, and `Diagnostics` are split into separate tabs to reduce crowding
- `Branding` uses its own save action
- `Platform Settings` groups integrations, email delivery, and object storage under a separate save action
- `Diagnostics` now also includes a destructive operational-data purge flow with typed-word confirmation

Inbound email diagnostics includes:
- Postmark webhook activity for `/api/inbound/postmark`
- Processing status (`Processed`, `No Match`, `Failed`)
- Candidate/contact match counts
- Notes created
- Candidate files saved
- Attachment skip reasons for troubleshooting metadata-only or filtered attachments

Operational purge:
- Available in `System Settings > Diagnostics`
- Deletes operational ATS records and migration artifacts while preserving users, divisions, system settings, skills, custom field definitions, and zip codes
- Requires administrator access
- Requires a generated confirmation word to be typed exactly before the purge will run

## Data Import
Supports:
- Hire Gnome exports
- Generic CSV migration batches with per-column field mapping
- Bullhorn CSV migration batches
- Zoho Recruit CSV migration batches

Import workflow:
- Upload source file
- For generic CSV, add one or more files to the migration batch or upload one ZIP containing the CSV set
- For Bullhorn, add one or more CSV files to the batch or upload one ZIP containing the Bullhorn CSV set
- For Zoho Recruit, add one or more CSV files to the batch or upload one ZIP containing the Zoho Recruit CSV set
- Choose entity profile per CSV file when needed
- Map CSV columns into ATS fields when using the generic CSV source
- Preview creates, updates, skips, relationship warnings, row-level actions, and match reasons by entity
- Apply import

Generic CSV batches run in dependency order:
1. Clients
2. Contacts
3. Candidates
4. Job Orders
5. Submissions
6. Interviews
7. Placements

Bullhorn CSV batches run in dependency order:
1. Custom Fields
2. Clients
3. Contacts
4. Candidates
5. Job Orders
6. Submissions
7. Interviews
8. Placements

Zoho Recruit CSV batches run in dependency order:
1. Clients
2. Contacts
3. Candidates
4. Job Orders
5. Submissions
6. Interviews
7. Placements

Sample files:
- `docs/import-samples/generic-migration-batch/`
- Includes a clean demo-ready seven-file batch that shows cross-file relationship linking.
- `docs/import-samples/generic-migration-batch-messy/`
- Includes a second seven-file batch with messier legacy column names for mapping and migration demos.
- `docs/import-samples/bullhorn-batch/`
- Includes a clean Bullhorn-style batch for ZIP/manual batch testing across custom fields, clients, contacts, candidates, job orders, submissions, interviews, placements, and candidate resume/file payloads.
- `docs/import-samples/zoho-recruit-batch/`
- Includes a clean seven-file Zoho Recruit-style batch for ZIP/manual batch testing across clients, contacts, candidates, job orders, submissions, interviews, and placements.
- `docs/import-samples/hire-gnome-export/`
- Includes a sample Hire Gnome export ZIP payload for testing the native import path.

UI support:
- Each import source type includes a direct sample download link in the upload area.
- ZIP-based modes download a ZIP-ready sample batch that includes the README and sample files.

## Data Export
Use Data Export for:
- Full snapshot export
- Incremental date-range export
- Optional audit trail export
- Optional API error log export
- Bullhorn API batch ZIP export for date-bounded migration samples

Formats:
- JSON
- NDJSON
- ZIP (per-entity files)

Bullhorn export:
- Save Bullhorn API credentials in `System Settings > Platform Settings`
- Choose `Updated From` / `Updated To`
- Estimate changed Bullhorn core-row counts for the selected date window before starting the export job
- Choose a per-entity changed-row sample limit
- Choose whether candidate files/resumes should be included
- Queue a background export job and review it from the Bullhorn export jobs list
- Download the finished ZIP or open it in the import preview flow once the job completes
- Cancel queued or running Bullhorn export jobs from the list after confirmation
- Delete completed, cancelled, or failed Bullhorn export jobs from the list after confirmation
- Generate an import-ready ZIP containing:
  - `custom field definitions`
  - `clients`
  - `contacts`
  - `contact notes`
  - `candidates` (including structured candidate skills)
  - `candidate notes`
  - `candidate education`
  - `candidate work history`
  - `candidate files/resumes`
  - `job orders`
  - `submissions`
  - `interviews`
  - `placements`
- Upstream dependency records are expanded automatically so related records still link when the ZIP is imported
- Bullhorn export/import preserves custom field definitions and record-level custom field values when Bullhorn exposes them
- Bullhorn export/import also preserves candidate notes, candidate education, candidate work history, contact notes, and structured candidate skills when Bullhorn exposes them
- Bullhorn ZIP batches can also carry candidate attachment files, including resumes, and import them after the related candidates are created or updated
- Bullhorn and Zoho import/export operations can be disabled entirely with environment variables when needed

## Users
Admins can:
- Create/deactivate users
- Assign roles
- Assign divisions
- Trigger password resets and account access changes

## Divisions
Defines organizational boundaries and collaboration mode:
- Collaborative
- Owner Only

## Skills
Maintains standardized selectable skill options used by candidate records and matching.

## Match Criteria
- `Admin Area > Match Criteria` defines the weighted criteria every candidate match is scored against. It is seeded with JD Criteria Match, Location, Local Experience, Big Company and University.
- Each criterion carries a label, a **weight** (relative, not a percentage), an **evaluator** naming how it is scored, a **guidance** line, and options for evaluators that need them.
- `What should this judge?` is the guidance sent to the AI as the instruction for that criterion. It has no effect on the deterministic score - the evaluator decides that - so it is worth writing for any criterion you intend to score with AI.
- Evaluators: `jd_criteria_match` (skills, title and keyword alignment - this is the heuristic that used to be the entire match score), `location` (distance against a radius, falling back to city/state text), `local_experience`, `big_company`, `university`, `experience_years` and `skills_coverage`.
- `big_company` and `university` need a reference list before they can be scored deterministically - the employers or schools that matter to your market. Left empty they report `not assessed`, which lowers the coverage figure on every match rather than inventing a score.
- Removing a criterion is a **soft delete**. Stored score breakdowns name the criteria they were computed against, so the row is deactivated rather than deleted. Deactivating every criterion does not trigger a re-seed of the defaults.
- Any change here takes effect within 30 seconds (the template is cached) and is reflected in match lists immediately, since the cache key includes the criteria.

## Custom Fields
Admins can define additional fields for:
- Candidates
- Clients
- Contacts
- Job Orders
- Submissions
- Interviews
- Placements

## Billing
Visible only when billing is enabled. Includes seat summary, sync action, and sync history.

## API Errors
Operational error visibility for diagnostics and support.

## Best Practice
1. Lock down admin access to trusted operators only.
2. Keep integration credentials current.
3. Review errors regularly.
4. Use test email mode in non-production environments.
