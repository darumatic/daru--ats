# HireGnome ATS — End-to-End Test Plan

**Environment:** https://careers.darumatic.com (production VPS)  
**ATS admin base URL:** https://careers.darumatic.com (same host, authenticated routes)  
**Last updated:** 2026-06-24

---

## Table of Contents

1. [Test Environment & Prerequisites](#1-test-environment--prerequisites)
2. [Authentication](#2-authentication)
3. [Public Career Site](#3-public-career-site)
   - 3.1 Careers Listing Page
   - 3.2 Job Detail Page
   - 3.3 Application Form — Standard Fields
   - 3.4 Application Form — Custom Questions
   - 3.5 Bot & Spam Protection
4. [Job Orders](#4-job-orders)
   - 4.1 Create & Edit
   - 4.2 Career Site Toggle & Custom Questions
   - 4.3 Status Lifecycle
   - 4.4 Pipeline Board
5. [Candidates](#5-candidates)
   - 5.1 Create & Edit
   - 5.2 Notes & Activities
   - 5.3 Resume Attachments
   - 5.4 Education & Work History
6. [Submissions](#6-submissions)
   - 6.1 Create Manually
   - 6.2 Status Lifecycle
   - 6.3 Web Response Submissions (from Career Site)
   - 6.4 Custom Fields / Application Answers
   - 6.5 Client Review Portal
7. [Interviews](#7-interviews)
8. [Offers & Placements](#8-offers--placements)
9. [Clients & Contacts](#9-clients--contacts)
10. [Users & Divisions](#10-users--divisions)
11. [Admin Settings](#11-admin-settings)
    - 11.1 System Settings & Branding
    - 11.2 Custom Field Definitions
    - 11.3 Skills
    - 11.4 Import & Export
    - 11.5 Audit Logs
12. [Security & Edge Cases](#12-security--edge-cases)
13. [curl Test Scripts](#13-curl-test-scripts)

---

## 1. Test Environment & Prerequisites

| Item | Value |
|------|-------|
| Production URL | https://careers.darumatic.com |
| Admin login | Create via `/setup` on first run or use seeded admin user |
| Test email domain | Use a disposable mailbox or `+tag` aliasing |
| Database access | SSH to `139.180.182.102`, then `mysql hiregnome` as root |
| Process manager | `pm2 status` / `pm2 logs hiregnome` |
| HTTPS | Let's Encrypt via Certbot; Cloudflare SSL set to **Full (Strict)** |

**Before each test session:**
- Confirm `pm2 status` shows `hiregnome` as **online**
- Confirm `https://careers.darumatic.com/api/health` returns `{"ok":true}`
- Note the highest existing `Submission.id` so you can query new rows after tests

---

## 2. Authentication

### TC-AUTH-01 — Login with valid credentials
**Steps:**
1. Navigate to `/login`
2. Enter correct email and password
3. Click **Sign In**

**Expected:** Redirected to `/` (dashboard). Session cookie `ats-session` set.

---

### TC-AUTH-02 — Login with invalid credentials
**Steps:**
1. Navigate to `/login`
2. Enter wrong password for a valid user

**Expected:** Error message shown. No redirect. No session cookie.

---

### TC-AUTH-03 — Account lockout after repeated failures
**Steps:**
1. Enter wrong password 5 times in a row for the same account

**Expected:** Account locked. Error message references lockout. Correct password also rejected until lockout expires (default 15 min).

---

### TC-AUTH-04 — Session expiry
**Steps:**
1. Log in
2. Manipulate cookie expiry (or wait for `AUTH_SESSION_MAX_AGE_SECONDS` — default 12 h)

**Expected:** On next navigation to a protected route, redirected to `/login`.

---

### TC-AUTH-05 — Forgot password flow
**Steps:**
1. Navigate to `/forgot-password`
2. Enter a registered email address
3. Check inbox for reset link
4. Click the link, enter a new password
5. Log in with the new password

**Expected:** Password changed. Old password rejected. New password accepted.

---

### TC-AUTH-06 — Logout
**Steps:**
1. Log in
2. Click account menu → **Sign Out**

**Expected:** Session cookie cleared. Redirected to `/login`. Navigating to a protected route sends back to `/login`.

---

### TC-AUTH-07 — Role access control
**Steps:**
1. Log in as a **Recruiter** user
2. Attempt to navigate to `/admin/settings`

**Expected:** 403 or redirect to dashboard. Recruiters cannot access admin sections.

---

## 3. Public Career Site

### 3.1 Careers Listing Page

#### TC-PUB-01 — Listing page loads
**Steps:**
1. `curl -s https://careers.darumatic.com/careers | grep -c "careers-job-card"`

**Expected:** Count ≥ 1 (at least one job card in HTML).

---

#### TC-PUB-02 — No salary range shown on listing cards
**Steps:**
1. `curl -s https://careers.darumatic.com/careers | grep -i "careers-job-pay"`

**Expected:** No output — `careers-job-pay` element is not rendered.

---

#### TC-PUB-03 — Search and filter controls present
**Steps:**
1. Load `/careers` in a browser
2. Verify text search input, location dropdown, and employment type dropdown are visible

**Expected:** All three filter controls rendered. Typing in search filters visible cards in real time.

---

#### TC-PUB-04 — Pagination
**Steps:**
1. Seed > 10 open jobs
2. Load `/careers`

**Expected:** Pagination controls appear. "Next page" navigates to subsequent cards. Page size selector works (10/25/50/100).

---

### 3.2 Job Detail Page

#### TC-PUB-05 — Detail page loads without 404
**Steps:**
1. `curl -s -o /dev/null -w "%{http_code}" https://careers.darumatic.com/careers/jobs/1`

**Expected:** `200`

---

#### TC-PUB-06 — Compensation and Posted fields absent from UI
**Steps:**
1. `curl -s https://careers.darumatic.com/careers/jobs/1 | grep -i "career-detail-highlights"`

**Expected:** No output — `career-detail-highlights` div is not rendered.

2. Confirm "Compensation" and "Posted" text do not appear in the visible page body (they may appear in JSON-LD `<script>` blocks, which is acceptable).

---

#### TC-PUB-07 — Custom questions rendered when configured
**Steps:**
1. Ensure job order 1 has at least one question in `applicationQuestions`
2. Load `/careers/jobs/1` in a browser
3. Scroll to the Quick Apply form

**Expected:** Each configured question appears as a labelled `<textarea>`. Required questions are marked with `*`.

---

#### TC-PUB-08 — No custom questions rendered when none configured
**Steps:**
1. Create a job order with no `applicationQuestions` (empty array)
2. Load its career detail page

**Expected:** No question textareas. `career-apply-questions` section absent.

---

### 3.3 Application Form — Standard Fields

#### TC-PUB-09 — Submit button disabled until required fields complete
**Steps:**
1. Load `/careers/jobs/1`
2. Leave all fields blank

**Expected:** Submit button disabled.

3. Fill First Name, Last Name, Email, Mobile, Zip Code, upload a PDF resume

**Expected:** Submit button becomes enabled (assuming no required unanswered questions).

---

#### TC-PUB-10 — Successful application submission
**Steps:**
1. Fill all required fields with valid data
2. Upload a valid PDF resume
3. Click **Submit Application**

**Expected:**
- Toast: "Application submitted successfully."
- `GET /api/careers/jobs/1/apply` not possible; confirm via DB:
  ```sql
  SELECT id, candidateId, status FROM Submission ORDER BY id DESC LIMIT 1;
  ```
  Shows new row with `status = 'submitted'`

---

#### TC-PUB-11 — Duplicate email → 409
**Steps:**
1. Submit an application with email `a@example.com`
2. Submit again for the same job with the same email

**Expected:** Second submission returns HTTP 409 "You already applied to this role with this email address."

---

#### TC-PUB-12 — Current Title and Current Employer fields absent
**Steps:**
1. Load `/careers/jobs/1`
2. Inspect the Quick Apply form

**Expected:** No input for "Current Title" or "Current Employer". These fields were removed.

---

#### TC-PUB-13 — Invalid email rejected
**Steps:**
1. Enter `notanemail` in the Email field

**Expected:** Browser-native or server-side validation prevents submission. Error message shown.

---

#### TC-PUB-14 — Unsupported resume file type rejected
**Steps:**
1. Attempt to upload a `.txt` or `.exe` file as resume

**Expected:** File rejected immediately (client-side) with "Unsupported resume file type" error. Submit remains disabled.

---

#### TC-PUB-15 — Resume > size limit rejected
**Steps:**
1. Upload a file exceeding the configured max (default 10 MB)

**Expected:** "Resume exceeds X MB limit" error shown. Form stays open.

---

### 3.4 Application Form — Custom Questions

#### TC-PUB-16 — Required question blocks submit
**Steps:**
1. Ensure job has at least one required question
2. Fill all standard fields and upload resume
3. Leave the required question blank

**Expected:** Submit button disabled. If somehow clicked, error toast "Please answer all required application questions."

---

#### TC-PUB-17 — Answers stored on Submission.customFields
**Steps:**
1. Submit application for a job with 3 questions, providing answers for all
2. Check DB:
   ```sql
   SELECT id, customFields FROM Submission ORDER BY id DESC LIMIT 1;
   ```

**Expected:** `customFields` JSON contains `applicationAnswers` array with one entry per question, each with `question` (label) and `answer` fields. No null values.

---

#### TC-PUB-18 — Answers appear in candidate note
**Steps:**
1. After a web-response submission, open the corresponding Candidate in the ATS
2. Navigate to the **Notes** tab

**Expected:** A note exists titled "Applied via career site" containing a section "Application Questions:" with each question label and the submitted answer.

---

#### TC-PUB-19 — Optional questions do not block submit
**Steps:**
1. Configure a question with `required: false`
2. Submit application leaving that question blank

**Expected:** Submission succeeds. `customFields.applicationAnswers` does not include an entry for the unanswered optional question (it is filtered out).

---

### 3.5 Bot & Spam Protection

#### TC-PUB-20 — Honeypot field (faxNumber) triggers silent pass
**Steps:**
1. POST to `/api/careers/jobs/1/apply` with `faxNumber=something`
2. Provide otherwise valid multipart data

**Expected:** HTTP 200 with `{"ok":true,"message":"Application submitted successfully."}` but **no** Submission or Candidate row created in DB.

---

#### TC-PUB-21 — Missing startedAtMs triggers silent pass
**Steps:**
1. POST with `startedAtMs` omitted or empty

**Expected:** Same as TC-PUB-20 — silent pass, no DB row.

---

#### TC-PUB-22 — Too-fast submission triggers silent pass
**Steps:**
1. POST with `startedAtMs` set to `Date.now()` (no elapsed time)

**Expected:** Silent pass if `CAREERS_APPLY_MIN_FORM_FILL_SECONDS` > 0 (default: 2).

---

#### TC-PUB-23 — Rate limit on apply endpoint
**Steps:**
1. POST valid applications > 6 times within 15 minutes from the same IP

**Expected:** 7th request returns HTTP 429 "Too many applications from this network."

---

## 4. Job Orders

### 4.1 Create & Edit

#### TC-JO-01 — Create a new job order
**Steps:**
1. Navigate to `/job-orders/new`
2. Fill Title and Zip Code, set Status to **Open**, select Employment Type (no Client, Hiring Manager, Owner or Division fields are shown)
3. Click **Save**

**Expected:** Redirected to the new job order's detail page. Record appears in `/job-orders` list.

---

#### TC-JO-02 — Required fields validation
**Steps:**
1. Navigate to `/job-orders/new`
2. Click **Save** without filling Title

**Expected:** Validation error shown. No record created.

---

#### TC-JO-03 — Edit existing job order
**Steps:**
1. Open an existing job order
2. Change the title
3. Click **Save**

**Expected:** Title updates. Audit trail entry created (visible in timeline or `/admin/logs`).

---

#### TC-JO-03b — Bulk close from the list
**Steps:**
1. Navigate to `/job-orders` in list view with at least two open job orders
2. Tick two rows (or the header checkbox) and click **Close Selected (n)**
3. Confirm the dialog

**Expected:** Both rows show status **Closed** with an updated last-activity time, a success toast reports the count, the selection clears, and each job's audit trail has a status entry. Selecting an already-closed row disables the button (or the confirm says it will be skipped).

---

#### TC-JO-04 — Employment type options
**Steps:**
1. Open new job order form
2. Inspect the Employment Type dropdown

**Expected:** Four options present: "Temporary - W2", "Temporary - 1099", "Permanent", "Contract".

---

#### TC-JO-05 — Archive a job order
**Steps:**
1. Open a job order
2. Click **Archive**

**Expected:** Job order no longer appears in the main list. Accessible under archived filter.

---

### 4.2 Career Site Toggle & Custom Questions

#### TC-JO-06 — Enable publish to career site
**Steps:**
1. Open a job order with status **Open**
2. Toggle **Publish to Career Site** on
3. Save
4. Check `/api/careers/jobs` (public API)

**Expected:** Job appears in the public careers API response.

---

#### TC-JO-07 — Disable publish removes job from public API
**Steps:**
1. Toggle **Publish to Career Site** off
2. Save
3. Check `/api/careers/jobs`

**Expected:** Job no longer in the API response. `/careers/jobs/{id}` returns 404.

---

#### TC-JO-08 — Add custom question
**Steps:**
1. Open a job order with career site enabled
2. In the Career Site section, click **Add Question**
3. Enter a label, mark it required
4. Save

**Expected:**
- Question appears in the form with a UUID-based `id`
- DB: `SELECT applicationQuestions FROM JobOrder WHERE id = X` shows the question
- Public career site for that job renders the question textarea

---

#### TC-JO-09 — Remove custom question
**Steps:**
1. Open a job order with existing questions
2. Click the trash icon next to a question
3. Save

**Expected:** Question removed from `applicationQuestions`. Public site no longer shows it.

---

#### TC-JO-10 — Question label required to save
**Steps:**
1. Click **Add Question**, leave the label blank
2. Attempt to save

**Expected:** Validation error. Question with empty label not persisted.

---

### 4.3 Status Lifecycle

#### TC-JO-11 — Status transitions
**Steps:**
1. Set a job order to **On Hold**
2. Confirm it no longer appears on the public careers site (only **Open** jobs are published)
3. Set back to **Open**

**Expected:** Job disappears from careers site while on hold; reappears when re-opened.

---

### 4.4 Pipeline Board

#### TC-JO-12 — Open the board and move a submission
**Steps:**
1. Open a job order that has at least two submissions in different stages
2. Choose **Actions → Pipeline Board** (or the **Open the pipeline board** link above the submissions list)
3. Drag a **Submitted** card onto **Qualified**
4. Go back to the job order → Submissions tab

**Expected:** `/job-orders/{id}/pipeline` shows seven columns (Submitted, Under Review, Qualified, Offered, Hired, Placed, Rejected) with the correct counts. After the drop the card sits under **Qualified** with a success toast, the submission's status chip in the job-order list reads **Qualified**, and the submission's audit trail has an UPDATE entry with `status` before/after. Clicking the candidate name opens the candidate; the arrow icon opens the submission.

---

#### TC-JO-13 — Placed is reserved and placed submissions are locked
**Steps:**
1. On the board, drag a **Hired** card onto **Placed**
2. Convert that submission to a placement from its detail page, then reopen the board
3. Try to drag the now-placed card anywhere

**Expected:** Step 1 shows an error toast pointing at Convert to Placement and the card stays put (`PATCH /api/submissions/{id}/status` answers 400). After conversion the card appears under **Placed** marked *Placement created* and cannot be dragged; a direct `PATCH … { "status": "qualified" }` answers 409.

---

#### TC-JO-14 — Rejecting asks for confirmation and a failed move rolls back
**Steps:**
1. Drag a card onto **Rejected** and cancel the confirmation
2. Drag it again and confirm
3. (Optional) With another user, move the same submission out of the user's division scope, then drag it on the stale board

**Expected:** Cancelling leaves the card in place with no request sent. Confirming moves it to **Rejected**. A refused move (404/409 from the server) snaps the card back to its previous column with an error toast.

---

## 5. Candidates

### 5.1 Create & Edit

#### TC-CAN-01 — Create a candidate manually
**Steps:**
1. Navigate to `/candidates/new`
2. Fill First Name, Last Name, Email, Mobile
3. Save

**Expected:** Candidate record created. Appears in `/candidates` list. Audit log entry created.

---

#### TC-CAN-02 — Duplicate email rejected
**Steps:**
1. Try to create a second candidate with the same email as an existing one

**Expected:** Validation error "Email already in use" (or equivalent). No duplicate created.

---

#### TC-CAN-03 — Edit candidate profile
**Steps:**
1. Open candidate record
2. Change mobile number
3. Save

**Expected:** Mobile updated. Timeline shows UPDATE audit event.

---

### 5.2 Notes & Activities

#### TC-CAN-04 — Add candidate note
**Steps:**
1. Open a candidate, go to **Notes** tab
2. Type a note, click **Add Note**

**Expected:** Note appears at the top of the list with current timestamp.

---

#### TC-CAN-05 — Web response note present after career site apply
**Steps:**
1. Submit an application via the public career site
2. Open the resulting candidate in the ATS → Notes tab

**Expected:** Note contains job title, email, mobile, zip, and if questions were configured, the "Application Questions:" section with answers.

---

### 5.3 Resume Attachments

#### TC-CAN-06 — Resume uploaded via career site is attached
**Steps:**
1. Submit an application with a PDF resume
2. Open the resulting candidate → **Files** tab

**Expected:** Resume file listed with correct filename, size, and `isResume: true`.

---

#### TC-CAN-07 — Manual resume upload
**Steps:**
1. Open a candidate → Files tab
2. Upload a PDF directly

**Expected:** File appears in the list. Can be downloaded.

---

### 5.4 Education & Work History

#### TC-CAN-08 — Add education record
**Steps:**
1. Candidate → Education tab
2. Add a degree with institution name, year

**Expected:** Record saved and displayed.

---

#### TC-CAN-09 — Add work history
**Steps:**
1. Candidate → Work tab
2. Add a job title, employer, start/end dates

**Expected:** Record saved and displayed chronologically.

---

## 6. Submissions

### 6.1 Create Manually

#### TC-SUB-01 — Create submission from job order
**Steps:**
1. Open a job order → Submissions tab
2. Click **Add Submission**, select an existing candidate

**Expected:** Submission created with status **Submitted**. Appears in the job order's submissions list and candidate's submissions tab.

---

#### TC-SUB-02 — Create submission from candidate
**Steps:**
1. Open a candidate → Submissions tab
2. Click **Add Submission**, select a job order

**Expected:** Same outcome as TC-SUB-01.

---

### 6.2 Status Lifecycle

#### TC-SUB-03 — Advance submission status
**Steps:**
1. Open a submission
2. Change status from **Submitted** → **Reviewed** → **Offered** → **Hired** → **Placed**
3. Save at each step

**Expected:** Status updates reflected in submission detail and list views. Timeline entry created at each save.

---

#### TC-SUB-04 — Reject submission
**Steps:**
1. Open a submission
2. Set status to **Rejected**, add a reason
3. Save

**Expected:** Submission shows "Rejected" status. Candidate's submission tab shows the rejected status.

---

### 6.3 Web Response Submissions (from Career Site)

#### TC-SUB-05 — Career site submission creates candidate + submission
**Steps:**
1. Submit via public apply form (TC-PUB-10 or re-run)
2. DB:
   ```sql
   SELECT c.email, s.id, s.status, s.notes
   FROM Submission s JOIN Candidate c ON s.candidateId = c.id
   ORDER BY s.id DESC LIMIT 1;
   ```

**Expected:**
- `status = 'submitted'`
- `notes` starts with `[WEB_RESPONSE] Career Site | Job: ...`

---

#### TC-SUB-06 — Repeat applicant updates existing candidate, creates new submission
**Steps:**
1. Submit application for job 1 with `jane@example.com`
2. Submit again for a **different** job with the same email

**Expected:** Only one Candidate row for `jane@example.com`. Two Submission rows, one per job order.

---

### 6.4 Custom Fields / Application Answers

#### TC-SUB-07 — Application answers in customFields
(Covered by TC-PUB-17 — repeated here for traceability)

**Steps:**
1. Submit with answers for all questions
2. DB:
   ```sql
   SELECT customFields FROM Submission ORDER BY id DESC LIMIT 1;
   ```

**Expected:** `customFields.applicationAnswers` is a non-null array of `{question, answer}` objects.

---

#### TC-SUB-08 — No customFields when no questions answered
**Steps:**
1. Submit to a job with no `applicationQuestions`

**Expected:** `customFields` is NULL (no update performed).

---

#### TC-SUB-09 — Custom fields defined in admin appear on submission form
**Steps:**
1. Create a custom field definition for the Submission entity
2. Open a submission
3. Scroll to the Custom Fields section

**Expected:** The field is rendered. Saving a value persists it.

---

### 6.5 Client Review Portal

#### TC-SUB-10 — Client portal access token
**Steps:**
1. Open a job order
2. Generate a client review link (if feature enabled)
3. Open the link in an incognito window

**Expected:** Client sees only the submissions shared for that job. Cannot access other data.

---

#### TC-SUB-11 — Client feedback recorded
**Steps:**
1. In client portal, click Approve or Reject on a submission
2. Back in ATS, open submission → **Client Feedback** tab

**Expected:** Feedback entry visible with timestamp and verdict.

---

## 7. Interviews

### TC-INT-01 — Schedule an interview
**Steps:**
1. Open a submission with status ≥ Reviewed
2. Navigate to Interviews or use `/interviews/new`
3. Select candidate, job order, interview type, scheduled date/time
4. Save

**Expected:** Interview record created with status **Scheduled**. Appears on candidate and submission timelines.

---

### TC-INT-02 — Interview types available
**Steps:**
1. Open new interview form
2. Inspect the Interview Type (Mode) dropdown

**Expected:** Options include Phone, Video, On-site (or configured equivalents from `interview-type-options.js`).

---

### TC-INT-03 — Mark interview completed
**Steps:**
1. Open a scheduled interview
2. Change status to **Completed**
3. Save

**Expected:** Status updated. Timeline entry updated.

---

### TC-INT-04 — Cancel interview
**Steps:**
1. Open a scheduled interview
2. Click **Cancel Interview** (or set status to Cancelled)

**Expected:** Status = Cancelled. Interview invite email / ICS suppressed on next send.

---

## 8. Offers & Placements

### TC-OFF-01 — Create an offer
**Steps:**
1. Navigate to `/offers/new` or from a submission
2. Fill required fields (candidate, job order, start date, salary)
3. Save

**Expected:** Offer created. Visible on candidate and job order timelines.

---

### TC-OFF-02 — Accept an offer → Placement
**Steps:**
1. Open an offer
2. Mark as accepted
3. Confirm placement created

**Expected:** Placement record created. Candidate status may update to "Placed".

---

### TC-PLA-01 — View placement details
**Steps:**
1. Navigate to `/placements`
2. Open a placement

**Expected:** Placement details visible including start date, candidate, job order, client.

---

## 9. Clients & Contacts

### TC-CLI-01 — Create a client
**Steps:**
1. Navigate to `/clients/new`
2. Fill Company Name, select Industry
3. Save

**Expected:** Client created. Visible in `/clients` list.

---

### TC-CLI-02 — Add a contact to a client
**Steps:**
1. Open a client record
2. Navigate to Contacts section
3. Create a new contact: First Name = "Daru", Last Name, Email

**Expected:** Contact created and linked to the client. Contact visible in `/contacts` list filtered by client.

---

### TC-CLI-03 — Job order created from a contact keeps the hiring manager
**Steps:**
1. Open contact "Daru" and choose **Add Job Order**
2. Fill Title and Zip Code, click **Save**

**Expected:** The job order detail Snapshot shows the client and "Daru" as Hiring Manager, even though neither field is shown on the form.

---

### TC-CLI-04 — Add note to client
**Steps:**
1. Open a client → Notes tab
2. Add a note

**Expected:** Note saved and displayed.

---

## 10. Users & Divisions

### TC-USR-01 — Create a user (admin only)
**Steps:**
1. Navigate to `/admin/users/new` or `/users/new`
2. Fill email, name, set role (Recruiter / Director / Administrator)
3. Save

**Expected:** User created. User can log in with a password reset flow.

---

### TC-USR-02 — Deactivate a user
**Steps:**
1. Open a user record
2. Toggle **Active** to off
3. Save

**Expected:** User cannot log in. Their existing submissions/job orders retain the ownership reference.

---

### TC-DIV-01 — Create a division
**Steps:**
1. Navigate to `/divisions/new`
2. Fill name, set access mode (Collaborative / Owner Only)
3. Save

**Expected:** Division created. Can be assigned to job orders and candidates.

---

### TC-DIV-02 — Owner Only access mode
**Steps:**
1. Set a division to **Owner Only**
2. Assign a job order to that division owned by User A
3. Log in as User B (different division or no division)

**Expected:** User B cannot see User A's job order (or sees limited information depending on role).

---

## 11. Admin Settings

### 11.1 System Settings & Branding

#### TC-ADM-01 — Update site name
**Steps:**
1. Navigate to `/admin/settings`
2. Change Site Name to "Darumatic Careers"
3. Save

**Expected:** Public careers page header and page title reflect the new name.

---

#### TC-ADM-02 — Toggle Career Site off
**Steps:**
1. Set **Public Career Site** toggle to off
2. Save
3. Access `/careers`

**Expected:** `/careers` returns 404 or "Career site is not enabled." All `/api/careers/*` endpoints return 404.

---

#### TC-ADM-03 — Toggle Career Site on
**Steps:**
1. Re-enable career site
2. Access `/careers`

**Expected:** Careers page loads normally.

---

#### TC-ADM-04 — Logo upload
**Steps:**
1. Upload a PNG logo in Admin Settings
2. View `/careers`

**Expected:** Custom logo rendered in place of default.

---

#### TC-ADM-05 — SMTP configuration (if applicable)
**Steps:**
1. Configure SMTP host, port, user, password in Admin Settings
2. Submit a test application
3. Check inbox for owner notification email

**Expected:** Email received with applicant name, job title, and links to ATS records.

---

### 11.2 Custom Field Definitions

#### TC-CDF-01 — Create a custom field
**Steps:**
1. Navigate to `/admin/custom-fields/new`
2. Select entity type (Candidate / Submission / Job Order), enter label and type (text / select / checkbox)
3. Save

**Expected:** Field appears on the relevant entity's detail page.

---

#### TC-CDF-02 — Required custom field blocks save
**Steps:**
1. Mark a custom field as required
2. Open an entity that has the field, leave it blank
3. Attempt to save

**Expected:** Validation error. Record not saved.

---

### 11.3 Skills

#### TC-SKL-01 — Add a skill
**Steps:**
1. Navigate to `/admin/skills/new`
2. Enter skill name
3. Save

**Expected:** Skill available in candidate skill lookup.

---

### 11.4 Import & Export

#### TC-IMP-01 — Import candidates via CSV
**Steps:**
1. Navigate to `/admin/imports`
2. Upload a valid candidate CSV
3. Confirm import

**Expected:** Candidate rows created. Summary shows count of imported records.

---

#### TC-EXP-01 — Export candidates
**Steps:**
1. Navigate to `/admin/exports`
2. Select Candidates, choose fields
3. Download CSV

**Expected:** CSV file downloaded. Contains expected columns and at least the manually created test candidates.

---

### 11.5 Audit Logs

#### TC-LOG-01 — Audit log entries created
**Steps:**
1. Perform any CREATE or UPDATE action (e.g., edit a candidate)
2. Navigate to `/admin/logs`

**Expected:** Log entry visible with entity type, action, actor (or "Web Response" for career site), and timestamp.

---

## 12. Security & Edge Cases

### TC-SEC-01 — Unauthenticated access to protected API routes
**Steps:**
1. Without a session cookie, call `GET /api/candidates`

**Expected:** HTTP 401 or 403.

---

### TC-SEC-02 — XSS in candidate note
**Steps:**
1. Create a candidate note with content `<script>alert(1)</script>`

**Expected:** Content rendered as escaped text, not executed.

---

### TC-SEC-03 — SQL injection in search
**Steps:**
1. Use global search with input `'; DROP TABLE Candidate;--`

**Expected:** No DB error. Prisma parameterised queries prevent injection.

---

### TC-SEC-04 — Resume file with executable extension rejected
**Steps:**
1. Rename a file to `malware.pdf.exe` and attempt upload

**Expected:** Server-side validation rejects it (415 or 400). No file stored.

---

### TC-SEC-05 — HTTPS redirect
**Steps:**
1. `curl -s -o /dev/null -w "%{http_code}" http://careers.darumatic.com/careers`

**Expected:** `301` redirect to `https://`.

---

### TC-SEC-06 — Cookie secure flag
**Steps:**
1. Inspect `ats-session` cookie in browser DevTools after login

**Expected:** `Secure` and `HttpOnly` flags set. `SameSite=Lax` or `Strict`.

---

## 13. curl Test Scripts

These commands can be run from any machine with `curl` installed. Replace `$STARTED_AT` with a timestamp ≥ 2 seconds in the past.

### Health check
```bash
curl -s https://careers.darumatic.com/api/health
# Expected: {"ok":true}
```

### Careers listing API
```bash
curl -s https://careers.darumatic.com/api/careers/jobs | python3 -m json.tool | head -40
# Expected: {"jobs":[...]} with at least one entry
```

### Job detail API (check applicationQuestions present)
```bash
curl -s https://careers.darumatic.com/api/careers/jobs/1 | python3 -m json.tool | grep -A 20 "applicationQuestions"
# Expected: array of question objects with id, label, required
```

### Submit application with answers
```bash
# Create a minimal PDF
echo '%PDF-1.4 1 0 obj<</Type/Catalog>>endobj' > /tmp/test.pdf

STARTED_AT=$(( ($(date +%s) - 300) * 1000 ))
ANSWERS='[
  {"questionId":"<question-id-from-api>","answer":"Australian citizen, full working rights"},
  {"questionId":"<question-id-2>","answer":"Available in 2 weeks"},
  {"questionId":"<question-id-3>","answer":"$110,000 base + super"}
]'

curl -s -X POST https://careers.darumatic.com/api/careers/jobs/1/apply \
  -F "firstName=Jane" \
  -F "lastName=Smith" \
  -F "email=jane.smith.$(date +%s)@example.com" \
  -F "mobile=0412345678" \
  -F "zipCode=2000" \
  -F "linkedinUrl=" \
  -F "faxNumber=" \
  -F "startedAtMs=$STARTED_AT" \
  -F "applicationAnswers=$ANSWERS" \
  -F "resumeFile=@/tmp/test.pdf;type=application/pdf"
# Expected: {"ok":true,"message":"Application submitted successfully.","submissionId":N,...}
```

### Verify answers stored in DB
```bash
# SSH to server then run:
ssh root@139.180.182.102 \
  'mysql hiregnome -e "SELECT id, customFields FROM Submission ORDER BY id DESC LIMIT 1;"'
# Expected: customFields contains {"applicationAnswers":[{"question":"...","answer":"..."},...]}'
```

### Honeypot test (should return 200 but create no DB row)
```bash
MAX_SUB=$(ssh root@139.180.182.102 'mysql hiregnome -N -e "SELECT MAX(id) FROM Submission;"')

curl -s -X POST https://careers.darumatic.com/api/careers/jobs/1/apply \
  -F "firstName=Bot" -F "lastName=Test" \
  -F "email=bot@example.com" \
  -F "mobile=0400000000" -F "zipCode=2000" \
  -F "startedAtMs=$(( ($(date +%s) - 300) * 1000 ))" \
  -F "faxNumber=1234567890" \
  -F "resumeFile=@/tmp/test.pdf;type=application/pdf"
# Response: {"ok":true,"message":"Application submitted successfully."}

NEW_MAX=$(ssh root@139.180.182.102 'mysql hiregnome -N -e "SELECT MAX(id) FROM Submission;"')
[ "$MAX_SUB" = "$NEW_MAX" ] && echo "PASS: no new submission" || echo "FAIL: submission created"
```

---

*This test plan covers the full user journey from public careers site through ATS internal workflows. Run TC-PUB and TC-SUB groups after every deployment that touches the career site or submission handling. Run TC-AUTH and TC-SEC groups after any authentication or security-related changes.*
