# Cute Kids Academy portal: what is built, and what is still to do

Pages: parents `/portal/`, staff and owner `/staff/`, public registration `/register/`, public birthday wall `/birthdays/`, sign in `/login/`.
The step-by-step setup and test list is `LAUNCH-CHECKLIST.md`; the database files are in `supabase/`.

## What each person can do

| Who | Can do |
|---|---|
| **Parent** | Home dashboard for each child (arrived, today's report, schedule, photos, what is coming up) · daily reports · accident reports (with "I've read this") · attendance, report an absence or late arrival · calendar, menu and events (yes/no answers) · news · photos and videos · ask a question, report a missing item, raise a concern or complaint (with a safety box) · rate the academy · **Payments** (what is due, InstaPay details with copy buttons, "I've paid" with reference, history, receipts) · messages from the academy · school bus · notification settings · English and Arabic |
| **Teacher** | Door check-in and check-out with who collected · daily reports · log an accident · photos · "my class" · raise a staff concern · school bus run (only if they ride a bus) |
| **Admin / Manager** | Everything above plus: cases queue with deadlines and escalation · applications (approve and invite parents) · admin area (children, classes, parents' access, settings) · announcements, menu, events · absences tracker and follow-up tasks · attendance reports · birthdays · transport routes · invite and switch off people. **They do not see payment amounts.** |
| **Finance** | Attendance and overtime reports and **Payments**: confirm or reject InstaPay references, record cash, charges, fee plans, search, CSV. Nothing else. |
| **Owner** | Everything, plus the owner dashboard, daily checklist and task tracker, payment settings and summary, waiving late fees |
| **Anyone** | Online registration form · the birthday wall (first name, initial and age, only with parents' consent) |

## Protections built in
Row-level security on every table (a parent can only ever see their own family) · private photo and document storage with short-lived links · switched-off accounts are refused everywhere · 30-minute inactivity sign-out · emails and notifications never contain a child's private details · money visible only to the family, finance and the owner · 599 database checks and 131 code checks pass.

## Still to do (in this order)
1. **Supabase:** run `catch-up-2-attendance.sql` (done), then create your owner login (see `supabase/make-test-logins.sql`).
2. **Vercel environment variables:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SITE_URL`, `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, and the VAPID keys (`node tools/make-vapid-keys.js`). Put only the PUBLIC VAPID key in `js/portal-config.js`.
3. **Domain and Resend:** the owner pays for the domain, verifies it in Resend, and sets custom SMTP in Supabase (Authentication > Emails).
4. **Scheduler:** run `supabase/schedule-emails.sql` after replacing `<SITE_URL>` and `<CRON_SECRET>` (never commit the filled-in file).
5. **Settings in the app:** Admin > Settings (phone, WhatsApp, closing time) · Owner > Payments settings (InstaPay address, bank details; confirm the account type with the bank) · fee plans for each child.
6. **Reviews:** native Arabic speaker for all wording; legal review of the privacy notice and consent text.
7. **Clean up test data** and run `node tests/live-check.mjs` against the live site; all lines must say PASS.

## Decisions for the owner
Admin and manager cannot see payment amounts · late fees stay off until the fee policy says how much · overtime rate is 0 until set · working hours, answer deadlines, consent and email wording are fixed in the system · a child can be on one bus route only · the birthday wall is a separate public page that search engines are asked to ignore (not linked from the website yet).
