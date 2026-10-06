# Parent portal database

SQL for the private parent portal (Supabase / Postgres). Nothing here is applied
automatically; it takes effect only when you run it in a Supabase project.

## What is in here

| File | Purpose |
|---|---|
| `migrations/..._core_tables.sql` | People, classes, children, submissions, timeline, accidents, investigations, ratings, attachments |
| `migrations/..._working_hours.sql` | Deadline clock: Sunday-Thursday 08:00-18:00 Cairo time, Fri/Sat skipped |
| `migrations/..._access_helpers.sql` | "Who can see what" helper functions |
| `migrations/..._rules_and_triggers.sql` | Automatic rules: urgency, deadlines, timeline logging, investigation step order, parent actions |
| `migrations/..._row_level_security.sql` | The privacy rules (row-level security on every table) |
| `migrations/..._storage.sql` | Private photo bucket (images only, 5 MB) |
| `migrations/..._staff_tools.sql` | Staff queue, case details, case actions (acknowledge, assign, escalate, resolve), auto-assign to the manager at level 3, serious accident opens an investigation |
| `migrations/..._investigations.sql` | Investigation workflow: auto-open for safety concerns, findings drafts hidden until the "findings" step, other-child name warning, manager/owner list and detail |
| `migrations/..._parent_views.sql` | Parent-safe lookups: own cases with handler name, own accident reports, staff names for "about a staff member" |
| `seed.sql` | FAKE test data: 2 classes, 4 children, 3 parents, 5 staff logins |
| `remove-seed-data.sql` | Deletes all seed data before launch |
| `tests/` | Automated tests (run locally, no Supabase needed) |

## Run the tests (any time)

```bash
cd supabase/tests
npm install
npm test
```

The tests load every migration and the seed into an in-memory Postgres, log in as each
role, and check that parents see only their own family, teachers only their classes, and so on.

## Apply to a Supabase project (when you are ready)

1. Create a Supabase project (free to start).
2. In the dashboard, open **SQL Editor**, then paste and run each file in `migrations/`
   in filename order (oldest first).
3. For a **test** project only, also run `seed.sql`. Never run it on the live project.
4. The seed logins have no password. In **Authentication > Users**, set one for the login you
   want to try (for example `parent.a@seed.cka.test`). Never commit a password here: this repo is public.
5. Keys: the browser uses only the project's public **anon** key. The **service_role** key
   goes only in Vercel's environment variables, never in the code or in Git.

## Switching the portal on (when you are ready)

The login, `/portal` and `/staff` pages are already in the site. They stay dormant ("not switched
on yet") until these are filled in. Nothing here is needed for the public website.

1. **Supabase keys into the site (public values, fine in Git):** edit `js/portal-config.js` and paste
   the Project URL and the **anon public** key (Project Settings > API).
2. **Vercel environment variables (secret, never in Git):** `SUPABASE_URL` (same URL) and
   `SUPABASE_SERVICE_ROLE_KEY` (the **service_role** key). Optional: `SITE_URL`
   (`https://cutekidsacademy-eg.vercel.app`). Redeploy after adding them.
3. **Supabase > Authentication settings:**
   - Turn **off** "Allow new users to sign up" (invitation only).
   - URL Configuration: Site URL = your site address; add `https://cutekidsacademy-eg.vercel.app/login/` and
     `https://cutekidsacademy-eg.vercel.app/login/?mode=set-password` to the Redirect URLs.
   - Email Templates (Invite user, Reset password): write them in Arabic and English.
   - Emails to real parents need **custom SMTP** (for example Resend with your own domain);
     Supabase's built-in sender is for testing only and is heavily rate-limited.
   - Sessions: the pages sign out after 30 minutes of inactivity. For a server-side limit too, set
     "Inactivity timeout" and "Time-box user sessions" there (paid plans).
4. **Create the first owner login** (once, by hand, because the invite screens need an owner to exist):
   in Authentication > Users add the owner's email, then in the SQL editor run
   `insert into public.profiles (id, full_name, role) values ('<that user id>', 'Owner name', 'owner');`
   After that, everyone else is invited from `/staff`.

How it fits together: `/login` signs people in; `/portal` (parents) and `/staff` (staff) check the
account's role and send visitors to the right area. These pages are only a shell. All real data comes
from Supabase, which applies the privacy rules, so skipping the page script reveals nothing.
Server functions in `api/portal-*.js` (invite parent, invite staff, switch access on/off) check the
caller's role again on the server before using the service key.

Tests for these functions: from the project root, `node --test tests/portal.test.mjs`.

## Design notes

- **Privacy is enforced in the database.** Even a broken page cannot show a parent another family's data.
- **Ratings are not stored with submissions.** Admin and teachers can read submissions, so ratings live in their own table that only manager and owner can read.
- **Investigations are split in two.** Parents and admin see steps and `findings_for_parent`; `investigation_internal` (internal findings, staff statements, actions taken) is manager and owner only.
- **Accidents are logged by staff.** A parent can still raise a safety worry, which becomes a critical case at level 3 and opens an investigation.
- **Deadlines:** critical = acknowledge in 1 hour, investigation opened by closing time the same working day; urgent = acknowledge in 2 working hours, resolve in 1 business day; can wait = acknowledge in 1 business day, resolve in 3 business days. Our reading of "24 hours" for urgent is one business day, so a Thursday afternoon request is due Sunday afternoon.
- **Changing urgency** needs a reason (`change_urgency()`), which the parent sees on their timeline.
- **Timeline rows and investigation steps can never be edited or deleted**, so there is a permanent record if a case is disputed.
- **Roles and active flags** can only be changed by the server with the service key (built in Prompt 4), never from the browser.
