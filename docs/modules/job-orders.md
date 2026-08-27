# Job Orders

## What This Module Is For
Job Orders defines open hiring demand and serves as the center for submissions and interview progression.

## Core Fields
- Title
- Status (required)
- Employment type (required on edit)
- Zip code (required)
- Internal description (team-only)

## Client, Hiring Manager, Owner And Division
These are not asked for on the job-order forms; the team does not track them per role.
- A job created without a client is filed under a per-division placeholder client named `Unassigned` (created on demand, one per division). The placeholder is hidden in the job-order list, in the job snapshot and on the public careers site (which falls back to its own no-client label).
- Owner defaults to the user who creates the job when that user belongs to the job's division; otherwise it stays blank.
- Hiring manager stays blank. Job orders started from a client or contact record (`Add Job Order` on those pages) still inherit that client and contact.
- Division is derived from the client: an administrator's job lands in their own division (or `Unassigned` when they have none); other roles always use their own division.
- Existing job orders keep their stored client, hiring manager, owner and division; saving a job order never re-validates or rewrites those unless an API caller changes them.
- The list view keeps `Client` and `Owner` as optional columns (hidden by default).

## Compensation + Location
Job orders include structured compensation and location details for operations and career-site publishing.

Location support:
- Address typeahead (Google Places when configured)
- Zip-required flow for city/state inference

## Career Site Publishing
If career site is enabled in system settings:
- Publish toggle becomes available
- Publish stays off by default on new job orders
- Publish cannot be enabled until public description is filled in
- Public description is required before publish can be enabled
- Internal description remains internal-only

## Public Description Editor
Rich text formatting is available for readability and candidate conversion quality.

When OpenAI is configured, the editor also supports a sparkles AI enhance action in the public-description toolbar.
If OpenAI is not configured, that control remains visible but disabled with a hint.

## Job Workspace
Use workspace tabs for:
- Submissions
- Interviews
- Placements
- Notes
- Activities

Job order detail also includes a unified `Timeline` workspace tab that rolls up submissions, interviews, placements, client feedback, and client-portal lifecycle activity into one chronological feed.

## Submission Rules
- New submission from job detail is supported.
- Job-order submissions can be ranked in recruiter preference order from the workspace using persisted drag-and-drop ordering.
- Drag-and-drop reorder is available when the submissions workspace is sorted by `Priority Order`.
- If a client passes on a submission through the portal, that submission is automatically moved to the bottom of the priority order.
- Each submission row links directly to the candidate record and also includes a separate submission-detail link.
- Candidate names in job-order candidate-linked lists are displayed as `Last, First` so recruiter sorting and scanning align better with alphabetic order.
- The submissions workspace surfaces the latest client portal action/comment so recruiters can scan client response without opening each submission.
- Career-site `Web` responses remain hidden from the client portal until a recruiter promotes them from submission detail.
- Duplicate candidate+job submissions are blocked.
- Candidate typeahead is optimized for larger datasets and qualification filtering.
- Candidate match rows support `Explain Match`, which opens a saved AI explanation of fit, gaps, and recruiter validation points for that candidate/job pair.
- If OpenAI is not configured, `Explain Match` remains visible but disabled with a tooltip/hint.

## Bulk Close From The List
- In the job-order list (table view) each row has a checkbox; the header checkbox selects or clears the current page.
- With rows selected, the toolbar shows `Close Selected (n)` and a clear-selection button. Closing asks for confirmation, lists the first titles, and skips job orders that are already closed.
- Only rows currently listed count: rows hidden by search, advanced filters or archiving are never closed by a stale selection.
- The list sends one request (`PATCH /api/job-orders/bulk-status`, at most 100 ids) and the server applies the same rules as closing a single job order: records outside the user's division/owner scope are reported back as not available, each real change is audit-logged, and closing stamps `closedAt` (which also removes the job from the career site).

## Actions Menu
Typical actions include:
- Client Review Portal
- Close job order (with confirmation)
- View career posting
- View audit trail (administrators only)
- Archive

## Client Review Portal
Job order detail includes `Actions > Client Review Portal` for client-facing candidate review without a separate login.

Behavior:
- If the client portal is disabled in `Admin Area > System Settings`, job-order portal analytics stay hidden and the actions-menu entry explains that an administrator must enable the feature
- Creates or reuses a persistent magic link for the assigned hiring-contact record on the job order
- Portal access is scoped to that job order only
- Link remains valid for the life of the job unless revoked
- Internal users can copy, email, open, revoke, or restore the portal link from the modal
- Sending the link from the modal uses a branded email template that follows the selected theme, with a direct CTA and job-specific context
- Job order detail also shows portal analytics for sent, opened, last viewed, acted on, and total client actions logged
- The modal shows the same lifecycle analytics so recruiters can quickly confirm whether the link is being used
- The external portal shows submitted candidates, recruiter write-ups, the candidate's labeled primary resume when available, structured scorecards, and response actions

## Best Practice
1. Keep internal and public descriptions distinct.
2. Confirm hiring manager contact before first submission.
3. Close job orders promptly when no longer active.

## List Search
The job-order list keeps the basic search for fast lookups and adds a separate `Advanced Search` builder for structured criteria.

Advanced search supports combining criteria such as:
- Closed date in the past `30` days
- `Submissions` greater than or equal to `4`
- Specific owner, client, status, employment type, or career-site visibility

Advanced search stays additive to the basic list search and can be saved as part of a saved view.
