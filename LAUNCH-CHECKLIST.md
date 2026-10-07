# Parent portal: launch checklist

Work through this in order. Tick each box when it is done. **Nothing on this list changes the live
website until step 9 ("Go live"), and that step is only done after the owner says yes.**

The portal code lives on the `portal` branch and has a private-ish preview link. The live site
(`main`) has no portal and no "Parent Login" link yet.

---

## 1. Get the database up to date  (about 10 minutes)

- [ ] In Supabase, open **SQL Editor > New query**, paste the whole of `supabase/catch-up-migrations.sql`, and run it.
      (The first nine migrations were already applied. This adds the email queue, reports, owner dashboard,
      owner checklist, online registration, attendance and the **security hardening**, which is last on purpose.)
      If you already ran an older version of that file, run `supabase/catch-up-2-attendance.sql` instead (attendance plus hardening only).
- [ ] From the project folder run `node tests/live-check.mjs`. Every line must say PASS.
      It looks at your live project from the outside, as a stranger would, using only the public key.
- [ ] **Important:** if you ever add or change a function in a future migration, run
      `supabase/migrations/29991231000000_hardening.sql` again afterwards (it is safe to repeat).

## 2. Lock down who can log in

- [ ] Supabase > **Authentication > Sign In / Providers**: "Allow new users to sign up" is **off**. (`live-check` verifies this.)
- [ ] Supabase > **Authentication > URL Configuration**: Site URL is `https://cutekidsacademy-eg.vercel.app`, and the Redirect URLs
      include `https://cutekidsacademy-eg.vercel.app/login/` and `https://cutekidsacademy-eg.vercel.app/login/?mode=set-password`.
- [ ] Supabase > **Authentication > Emails**: edit the **Invite user** and **Reset password** templates in Arabic and English.
- [ ] If your Supabase plan allows it, also set an inactivity timeout and a session time limit (the portal already signs people out after 30 minutes).

## 3. Email (so parents actually receive messages)

- [ ] Create a **Resend** account and **verify a domain you own** (add the DNS records Resend shows you). Without a verified domain Resend only emails yourself.
- [ ] Vercel > project `cute-kids-academy` > Settings > Environment Variables (tick **Production and Preview**):
      `RESEND_API_KEY`, `RESEND_FROM` (for example `Cute Kids Academy <notifications@yourdomain.com>`),
      `CRON_SECRET` (a long random string you make up), `SITE_URL` (`https://cutekidsacademy-eg.vercel.app`). Redeploy.
- [ ] Supabase > **Authentication > Emails > SMTP Settings**: enter your Resend SMTP details so the **invitation and password-reset emails** go out from your domain.
- [ ] Supabase > **Database > Extensions**: switch on `pg_cron` and `pg_net`.
- [ ] Run `supabase/schedule-emails.sql` in the SQL editor **after** replacing `<SITE_URL>` and `<CRON_SECRET>`. Never commit the filled-in version.
- [ ] Test: log in as a test parent, send a concern, and check the email arrives and links to the portal. Then check the queue:
      `select template, status, last_error from public.email_outbox order by created_at desc limit 20;`

## 4. Real people, real data  (and remove the pretend ones)

- [ ] Create your own owner login (once, by hand): Supabase > Authentication > Users > Add user, then run
      `insert into public.profiles (id, full_name, role) values ('<that user id>', '<your name>', 'owner');`
- [ ] Log in at `/staff/` and add the real **classes**, **children** and **staff** (staff screens: People). Invite the manager, admins and teachers by email.
- [ ] Open **Checklist & tasks** and replace the 10 placeholder checks with the real morning-walk and afternoon checks from the follow-up plan.
- [ ] Open the **Owner** tab > Settings and set the Good / Watch / Action-needed limits you want.
- [ ] **Delete the seed (pretend) data:** run `supabase/remove-seed-data.sql` in the SQL editor. Then check
      `select count(*) from auth.users where email like '%@seed.cka.test';` returns 0.

## 5. Review the wording (a native speaker, and ideally someone who knows the law)

- [ ] **Arabic:** have a native Arabic speaker read every screen and email in Arabic. The wording uses the neutral-masculine form common in apps.
- [ ] **Privacy notice** (`/privacy/`): read it in both languages. It describes exactly what the portal stores and who can see it. Egyptian data-protection law
      treats children's data as sensitive, so please have it checked against the academy's registration forms and consent wording, and confirm the retention
      sentence ("while your child is enrolled; safety and accident records may be kept longer") matches what the academy really does.
- [ ] Decide whether the academy wants parents to accept the notice on first login (not built; easy to add).

## 6. Test on a real phone, in both languages

- [ ] On a real phone: sign in as a test parent, raise a concern **with a photo**, tap the call button on the safety box, read an accident report, send a rating. Do it once in English and once in Arabic (right-to-left).
- [ ] As staff: acknowledge a case, assign it, escalate it, resolve it, log an accident (including a serious one, which opens a safety review), run a review through all seven steps.
- [ ] As the owner: open the dashboard, the reports (download the CSV), the checklist.
- [ ] Check that a parent **cannot** open `/staff/` and that a logged-out visitor is sent to the login page.

### Online registration (Prompt 11)

- [ ] Open `/register/` on a real phone (English, then Arabic) and send a pretend application with a photo, a pickup person with an ID photo, and a PDF. You should get the confirmation email (needs the email setup in step 3).
- [ ] As admin: open **Applications**, open the pretend one, look at the files, ask for a missing paper, then **Approve** it into a class. Both parents get an invitation email (use two email addresses you control). Then delete the pretend child and parents with the clean-up script.
- [ ] As a parent: **My child** page: change the allergies and add a pickup person. The class teacher and the admins get a plain "something changed" email with no details in it.
- [ ] The registration form keeps answers on the device for 7 days; the privacy notice says so (check the wording with whoever reviews it).

### Attendance and pickup (Prompt 12)

- [ ] On a tablet or phone, open **Door** as a teacher: check a pretend child in, then out, choosing a person from the pickup list (the ID photo shows). Then try **Someone else**: you should see the red STOP warning and the parents' phone numbers, and the hand-over button stays off until you write who approved it.
- [ ] After 6:00 pm, check a child out and see the overtime minutes appear; open **Attendance reports** as admin, check the overtime table and the CSV download.
- [ ] As a parent: **Attendance** page: report an absence for tomorrow, then for today after 8:00 am (it must tell you to call). Check the teacher sees the notice on the Door list.
- [ ] Leave a pretend child unchecked at 9:30 on a school day: the admin gets one email with a count (no names) and the Door screen shows the child under "Not arrived and nobody told us".
- [ ] The scheduler (step 3) must be running every 15 minutes with `check: true`: that is what flags the 9:30 children.

### Daily reports (Prompt 13)

- [ ] As a teacher on a phone: check two pretend children in at the **Door**, then open **Daily reports**: tick both, tap lunch and mood for everyone, open one child and add water, milk, sleep, diapers, stools and one personal sentence. A child with an allergy shows a red allergy warning above the meal buttons.
- [ ] Enter a temperature of 38.4 on a pretend child: the class staff and the admins get an alert email (no name or number in it). The parent's report shows the high temperature with a gentle note.
- [ ] Tap **Save and send**: the parent sees the report in **Daily report**, gets an email, and "Kindly send for tomorrow" appears on their home screen. The teacher can no longer change it; admin can, with a reason (it is recorded).
- [ ] After 4 pm the teacher sees who still needs a personal sentence; at the automatic-send time (default 16:30, changeable by admin on the same page) every report with entries goes out by itself. This needs the scheduler (step 3).

### Announcements, menu, events and notifications (Prompt 14)

- [ ] **Announcements**: post one to everyone (important), one to a class, one to a single family; on a parent phone check each parent sees only theirs, open it, and see "1 of 3 read" in the admin list. After 24 hours the unread families get a reminder email.
- [ ] **Menu & schedule**: enter a week's menu with allergens. A parent whose child's allergy matches sees a warning on that dish (the allergies are matched by common words in English and Arabic: check a few real examples, because parents write them in their own way).
- [ ] **Events**: create one needing approval with a deadline; answer it as a parent; admin sees answers and missing answers. Families who have not answered get one reminder 24 hours before the deadline.
- [ ] **Parents' choices**: in **Settings** a parent can switch off reports, announcements, events or case emails. Safety emails (accident reports, safety reviews) always go out.
- [ ] **Push notifications and the installable app** (optional, needs the domain and HTTPS): run `node tools/make-vapid-keys.js`, put the PUBLIC key into `js/portal-config.js` (vapidPublicKey), and put VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Vercel. Then on a phone: open the portal, **Settings > Turn on notifications**, and add it to the home screen. The phone only ever shows "You have a new update".

### Photos and videos (Prompt 15)

- [ ] As a teacher on a phone: **Photos**: choose two photos and a short video, tag children, upload. Try tagging a child whose parents did NOT agree to class photos: the child shows a warning and cannot be ticked. (To test the block, record a "no" for class photos on a pretend child.)
- [ ] As the parent of a tagged child: **Photos** shows only their child's items, grouped by day, with a download button. A different family sees nothing of it. Open a link, wait 5 minutes, and see that it has expired.
- [ ] As admin: remove an item (families stop seeing it at once; the file is deleted for good after 30 days). Mark one "OK to post" as admin or owner: it is refused if any child in it has no social media consent.
- [ ] Set how long photos are kept (default 12 months, then delete). The clean-up runs with the scheduler (step 3).
- [ ] **Videos are checked in the browser (60 seconds, 50 MB)**: the phone does not shrink videos. If storage use grows, tell me and we can lower the limit.

### The admin area (Prompt 16)

- [ ] **Admin > Today**: the counts match what you see at the door, in daily reports, announcements, events and cases; tap a tile to go to that screen.
- [ ] **Admin > Children**: search by a child's or a parent's name; open a profile (class, parents and whether each has signed in, pickup people, health, consents, documents, change history). Move a pretend child to another class: the old teacher stops seeing them, the new one sees them, and the move is in the history.
- [ ] **Withdraw** a pretend child: parents with no other child lose access; everything is kept; **Re-enrol** brings them back.
- [ ] **Admin > Classes**: capacity and enrolled; assign a head teacher, teachers, a co-teacher and an assistant; each sees only their classes.
- [ ] **Staff accounts** (owner or manager): create a **Finance** account. Sign in as them: they see only **Attendance reports** (with overtime), no children, health, cases or HR. Try a few URLs by hand to be sure.
- [ ] **Admin > Settings**: set the real phone, WhatsApp number (digits with country code), email and address, and the closing time after which pickups count as overtime. Working hours and urgency deadlines are fixed in the system, as is the wording of consents and emails.

### Parent home, questions and the WhatsApp button (Prompt 17)

- [ ] On a phone: the home screen shows, for each child, whether they have arrived, today's report, this month at a glance, today's schedule, the latest photos, what is coming up, news, events waiting for an answer, open cases. The bottom menu has Home, Report, Calendar, Photos, More.
- [ ] **Ask a question** (and **Report a missing item** with a photo): it becomes a case ("can wait" unless the parent ticks urgent), shows in the staff queue, and an email arrives at the academy inbox and to every admin. Reply as staff: the parent sees it in the portal and gets an email.
- [ ] **WhatsApp**: set the academy's WhatsApp Business number in **Admin > Settings** (digits with country code). The "Ask on WhatsApp" button then opens a chat with the parent's name, child and case reference already typed in. If the number is empty, the button is simply not shown.
- [ ] The bottom menu is Home, Report, Calendar, Photos, Payments; **More** sits at the top next to the language switch. The home screen has four quick buttons (Ask a question, Report an absence, Report a missing item, Payments).

### Absence follow-up and approval reminders (Prompts 18 and 19)

- [ ] **Staff > Absences**: pick a period. You see total absence days, reported (with reason), not reported, days in a row now, last attended and last reason for each child, plus summary tiles. **Add an absence** (child, date, did the parent tell us, reason) works for any past school day.
- [ ] A child absent 3 or more school days in a row appears in **Follow-up tasks** at 10:00 on the third day. Send the friendly message from the task (it goes to the Messages page and by email to both parents). If nobody answers within 2 school days a reminder task appears, then a "call the family" task; at 18:00 an unresolved task is escalated to the manager. Mark the outcome (child back, long-term absence, left) and the task closes by itself when the child returns.
- [ ] **Events that need a yes or no**: parents who have not answered are reminded 24 hours after posting and the day before the deadline (one reminder a day). On the deadline day the **Events** page lists the families to phone, with an "I called" button and a note. No answer counts as "not approved".
- [ ] Parents see the follow-up notes under **More > Messages from the academy**; the home screen shows an unread card.

### Payments (Prompt 20)  — money is visible only to the family, finance and the owner

- [ ] **Owner > Payments > Payment settings**: fill in the academy's InstaPay address, the bank details (and the bank's InstaPay link if there is one), due day, reminder days. **Confirm with the bank what type of account receives InstaPay** before families start paying. Late fees are OFF; switch them on only after the fee policy every family signed says how much and when.
- [ ] Give each child a **fee plan** (Payments > Open > Fee plan). Monthly tuition is added automatically (from the 25th, for the coming month, once the plan exists); event costs and transport fees appear as charges. Overtime is charged at the overtime rate in settings (0 until you set it).
- [ ] Parent: **Payments** shows what is due, the itemised charges, the late-fee rule in plain words, the amount, the InstaPay address and a unique payment note with Copy buttons. After paying they enter the **transaction reference** (and an optional screenshot) and press Send.
- [ ] Finance: the payment appears under **Payments waiting for confirmation**. Match the reference on the bank statement, then **Confirm** (the parents get a receipt by email and a numbered printable receipt) or **Reject** with a reason (the family sees it). The same reference cannot be used twice.
- [ ] Finance: **Record cash or a bank transfer** received at the office; it is confirmed straight away with a receipt. Filters and the search bar find a child or a parent instantly. **Download as CSV** gives the accountant the month.
- [ ] Teachers, the admin and the manager do **not** see any payment page or amount (try it: log in as a teacher; the Payments item is missing).
- [ ] Owner only: **waive a late fee** (a reason is required and is recorded).

### Birthdays, the birthday wall and transport (Prompt 21)

- [ ] **Staff > Birthdays**: the list by month; edit the message in English and Arabic (use {child}); the switch turns the automatic 8:00 message on or off; **Send now** sends one immediately. Both parents get it under Messages and by email.
- [ ] **Birthday wall** (public page `/birthdays/`, not listed in search engines): shows only a first name, an initial and the age, only for children whose parents ticked the birthday-wall consent at registration. Untick the consent in the child's record (or ask the parent) and the child disappears at once. Decide where to link it from (it is not linked from the website yet).
- [ ] **Staff > Transport** (manager, admin, owner, and the staff member who rides a bus): create a route (driver, who rides, monthly fee), add stops with morning and afternoon times, add children (one route per child). On the day, open the run: mark each child On board, Absent or Dropped off; **Bus is 10 minutes away** emails the families at that stop; **Dropped off** emails the family. The monthly fee becomes a Payments charge at the start of each month.
- [ ] Parents: **More > School bus** shows the route, driver, stop, times and today's status; the home screen shows it when the child rides.
- [ ] **Admin > a child > Parents and access**: both parents' access is shown; **Resend the invitation**, **Switch off / on** access, and **Invite the other parent** (a child can have two parents at most).
- [ ] Parent Report tab: the daily report and, below it, **Accident reports** with the "I have read this" button.

## 7. Staff first (one week)

- [ ] Staff use the portal with a few pretend cases for a week, so they learn the screens before any family sees them.
- [ ] Fix anything confusing. Use the plan's suggestion: announce it in the Thursday update with a one-minute video showing how to log in.

## 8. Pilot families (first 5)

- [ ] Invite 5 friendly families from **People > Invite a parent** (choose their child).
- [ ] Ask them: was anything confusing? Could they find the call button? Did the emails arrive? Collect the answers before inviting everyone.

## 9. Go live  (only when the owner says yes)

- [ ] Ask Claude Code to merge the `portal` branch into `main`. Vercel deploys it automatically and the "Parent Login" link appears on the website.
- [ ] Run `node tests/live-check.mjs` once more against the live site. All PASS.
- [ ] Invite the remaining families in batches.

## 10. After launch

- [ ] Each week: look at **Owner > Staff overview** and the **Reports** page; review late tasks on Thursday.
- [ ] Each month: download the report CSV for the monthly review.
- [ ] Rotate keys if anyone who knew them leaves: Supabase keys, `RESEND_API_KEY`, `CRON_SECRET`.
- [ ] Optional: ask for the portal fonts to be hosted on the academy's own site, so parents' devices never contact Google.

---

### How the safety checks work (for the curious)

| Check | Command | What it proves |
|---|---|---|
| Database privacy audit | `cd supabase/tests && npm install && npm test` | Every table has row-level security; each role sees exactly what it should; a parent or teacher cannot read another family's data or any internal note; only the intended functions can be run by each role |
| Secrets and code safety | `node --test tests/*.test.mjs` | No secret keys in any file or in the whole git history; the browser code never builds HTML from data; photo links expire; every server function checks who is calling |
| Live project check | `node tests/live-check.mjs` | A stranger on the internet can read nothing, write nothing, run no internal function, and cannot sign up |

### What is not built yet

Nothing from the plan is left to build. What remains is configuration (domain, Resend, scheduler, keys), a native Arabic review, a legal review of the privacy notice and the consents, and the owner's decisions below.

**Decisions for the owner to confirm:** (1) the admin and the manager cannot see payment amounts, only finance and the owner can; (2) late fees stay off until the fee policy says how much; (3) the overtime rate is 0 until set; (4) working hours, answer deadlines, consent wording and email texts are fixed in the system (change them by asking Claude Code); (5) a child can be on one bus route only; (6) the birthday wall is a separate public page that search engines are asked to ignore; (7) the receiving account for InstaPay must be confirmed with the bank.
