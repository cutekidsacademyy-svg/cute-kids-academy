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

## Design notes

- **Privacy is enforced in the database.** Even a broken page cannot show a parent another family's data.
- **Ratings are not stored with submissions.** Admin and teachers can read submissions, so ratings live in their own table that only manager and owner can read.
- **Investigations are split in two.** Parents and admin see steps and `findings_for_parent`; `investigation_internal` (internal findings, staff statements, actions taken) is manager and owner only.
- **Accidents are logged by staff.** A parent can still raise a safety worry, which becomes a critical case at level 3 and opens an investigation.
- **Deadlines:** critical = acknowledge in 1 hour, investigation opened by closing time the same working day; urgent = acknowledge in 2 working hours, resolve in 1 business day; can wait = acknowledge in 1 business day, resolve in 3 business days. Our reading of "24 hours" for urgent is one business day, so a Thursday afternoon request is due Sunday afternoon.
- **Changing urgency** needs a reason (`change_urgency()`), which the parent sees on their timeline.
- **Timeline rows and investigation steps can never be edited or deleted**, so there is a permanent record if a case is disputed.
- **Roles and active flags** can only be changed by the server with the service key (built in Prompt 4), never from the browser.
