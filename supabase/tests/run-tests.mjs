// Database tests: applies every migration plus the seed to an in-memory Postgres,
// then logs in as each seed role and checks the privacy and deadline rules.
// Run:  cd supabase/tests && npm install && npm test
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = new PGlite();

async function load(label, file) {
  try { await db.exec(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`SETUP FAILED in ${label}: ${e.message}`); process.exit(2); }
}
await load('shim.sql', join(here, 'shim.sql'));
for (const f of readdirSync(join(root, 'migrations')).sort()) await load(f, join(root, 'migrations', f));
await load('seed.sql', join(root, 'seed.sql'));

const U = {
  hana: '00000000-0000-4000-8000-000000000001', mariam: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003', manager: '00000000-0000-4000-8000-000000000004',
  owner: '00000000-0000-4000-8000-000000000005',
  parentA: '00000000-0000-4000-8000-000000000101', parentB: '00000000-0000-4000-8000-000000000102',
  parentC: '00000000-0000-4000-8000-000000000103',
};
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sub1 = ID(401), sub2 = ID(402), sub3 = ID(403), inc1 = ID(501), inv1 = ID(601);
const alpha = ID(301), beta = ID(302), gamma = ID(303), delta = ID(304);

// Run one statement as a logged-in user (or anonymous when who = null); always rolled back.
async function as(who, sql, params = []) {
  await db.exec('begin');
  try {
    await db.exec('set local role ' + (who ? 'authenticated' : 'anon'));
    if (who) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who]);
    return { rows: (await db.query(sql, params)).rows };
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.exec('rollback');
  }
}
// Same, but keeps the changes (to build up a scenario) - still as that user.
async function asKeep(who, sql, params = []) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who]);
    await db.query(sql, params);
    await db.exec('commit');
    return {};
  } catch (e) {
    await db.exec('rollback');
    return { error: e.message };
  }
}

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) pass++; else { fail++; failures.push(`${name} ${detail}`); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
}
const ids = (r) => (r.rows || []).map((x) => x.id);
const count = (r) => (r.rows || []).length;

// ---------------------------------------------------------------------------
console.log('\n== Working-hours deadlines (Cairo time, Sun-Thu 08:00-18:00) ==');
async function dl(urgency, cairoLocal) {
  const r = await db.query(
    `select to_char(acknowledge_by at time zone 'Africa/Cairo','Dy YYYY-MM-DD HH24:MI') as a,
            to_char(resolve_by at time zone 'Africa/Cairo','Dy YYYY-MM-DD HH24:MI') as r
       from public.cka_deadlines($1, ($2::timestamp) at time zone 'Africa/Cairo')`, [urgency, cairoLocal]);
  return r.rows[0];
}
const eq = async (label, urgency, from, a, r) => {
  const got = await dl(urgency, from);
  check(label, got.a === a && got.r === r, `got ack=${got.a} resolve=${got.r}, want ack=${a} resolve=${r}`);
};
await eq('urgent, Sunday 09:00', 'urgent', '2026-10-11 09:00', 'Sun 2026-10-11 11:00', 'Mon 2026-10-12 09:00');
await eq('urgent, Thursday 17:00 rolls over the weekend', 'urgent', '2026-10-15 17:00', 'Sun 2026-10-18 09:00', 'Sun 2026-10-18 17:00');
await eq('urgent, Sunday 20:00 starts next morning', 'urgent', '2026-10-11 20:00', 'Mon 2026-10-12 10:00', 'Tue 2026-10-13 08:00');
await eq('can_wait, Thursday 14:00', 'can_wait', '2026-10-15 14:00', 'Sun 2026-10-18 14:00', 'Tue 2026-10-20 14:00');
await eq('can_wait, Friday 10:00 (weekend)', 'can_wait', '2026-10-16 10:00', 'Mon 2026-10-19 08:00', 'Wed 2026-10-21 08:00');
await eq('critical, Friday 10:00', 'critical', '2026-10-16 10:00', 'Fri 2026-10-16 11:00', 'Sun 2026-10-18 18:00');
await eq('critical, Sunday 10:00', 'critical', '2026-10-11 10:00', 'Sun 2026-10-11 11:00', 'Sun 2026-10-11 18:00');

// ---------------------------------------------------------------------------
console.log('\n== Submissions: rules the database enforces ==');
{
  const s = (await db.query(`select urgency, escalation_level, status, acknowledge_by is not null as has_ack from public.submissions where id=$1`, [sub3])).rows[0];
  check('safety concern is critical and starts at level 3', s.urgency === 'critical' && s.escalation_level === 3);
  const c = (await db.query(`select escalation_level from public.submissions where id=$1`, [sub2])).rows[0];
  check('complaint about a named staff member starts at level 3', c.escalation_level === 3);
  const n = (await db.query(`select escalation_level, has from (select escalation_level, true as has from public.submissions where id=$1) x`, [sub1])).rows[0];
  check('ordinary complaint starts at level 1', n.escalation_level === 1);

  let r = await as(U.parentA, `insert into public.submissions (parent_id, child_id, type, title, description, urgency)
                               values ($1, $2, 'safety_concern', 't', 'd', 'can_wait') returning urgency, escalation_level, status`, [U.parentA, alpha]);
  check('parent safety submission is forced to critical / level 3 even if parent sent can_wait',
        !r.error && r.rows[0].urgency === 'critical' && r.rows[0].escalation_level === 3 && r.rows[0].status === 'received', r.error);

  r = await as(U.parentA, `insert into public.submissions (parent_id, child_id, type, title, description, urgency)
                           values ($1, $2, 'complaint', 't2', 'd', 'critical')`, [U.parentA, alpha]);
  check('parent cannot choose Critical for a complaint', !!r.error, r.error);

  r = await as(U.parentA, `insert into public.submissions (parent_id, child_id, type, title, description, urgency)
                           values ($1, $2, 'complaint', 't3', 'd', 'urgent')`, [U.parentA, beta]);
  check("parent cannot submit about another family's child", !!r.error, r.error);

  r = await as(U.parentA, `insert into public.submissions (parent_id, child_id, type, title, description, urgency)
                           values ($1, $2, 'complaint', 't4', 'd', 'urgent') returning parent_id`, [U.parentB, alpha]);
  check("a parent cannot submit in another parent's name (stored as the logged-in parent)", !r.error && r.rows[0].parent_id === U.parentA, r.error);

  r = await as(U.admin, `update public.submissions set urgency='can_wait' where id=$1`, [sub1]);
  check('changing urgency without a reason is refused', !!r.error, r.error);
  r = await asKeep(U.admin, `select public.change_urgency($1, 'can_wait', 'Not time-critical after review')`, [sub1]);
  check('change_urgency with a reason works', !r.error, r.error);
  const ev = (await db.query(`select visible_to_parent, message, old_value, new_value from public.submission_events
                               where submission_id=$1 and event_type='urgency_changed'`, [sub1])).rows[0];
  check('...writes a parent-visible timeline row with the reason', ev && ev.visible_to_parent && ev.message.includes('Not time-critical') && ev.old_value === 'urgent' && ev.new_value === 'can_wait');
  r = await as(U.admin, `select public.change_urgency($1, 'urgent', 'trying to downgrade')`, [sub3]);
  check('a safety concern cannot be downgraded', !!r.error && /always critical/.test(r.error), r.error);

  r = await asKeep(U.admin, `update public.submissions set assigned_to = $2 where id=$1`, [sub1, U.manager]);
  check('assigning writes a timeline row', !r.error && (await db.query(`select 1 from public.submission_events where submission_id=$1 and event_type='assigned'`, [sub1])).rows.length === 1);
  r = await as(U.manager, `update public.submissions set assigned_to = $2 where id=$1`, [sub2, U.hana]);
  check('a complaint is never assigned to the staff member it is about', !!r.error, r.error);
  r = await as(U.owner, `update public.submissions set title='edited' where id=$1`, [sub1]);
  check('original submission text cannot be edited', !!r.error, r.error);
  r = await as(U.owner, `update public.submission_events set message='x' where submission_id=$1`, [sub1]);
  check('timeline rows cannot be edited', !!r.error, r.error);
  r = await as(U.owner, `delete from public.submission_events where submission_id=$1`, [sub1]);
  check('timeline rows cannot be deleted', !!r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Parents see only their own family ==');
{
  let r = await as(U.parentA, 'select id from public.submissions');
  check('Parent A sees only their own submission', JSON.stringify(ids(r)) === JSON.stringify([sub1]), JSON.stringify(ids(r)));
  r = await as(U.parentB, 'select id from public.submissions');
  check('Parent B sees only their own submission', JSON.stringify(ids(r)) === JSON.stringify([sub2]));
  r = await as(U.parentA, 'select id from public.children');
  check('Parent A sees only their own child', JSON.stringify(ids(r)) === JSON.stringify([alpha]));
  r = await as(U.parentC, 'select id from public.children order by id');
  check('Parent C sees only Delta and Alpha (two-parent link)', JSON.stringify(ids(r)) === JSON.stringify([alpha, delta]), JSON.stringify(ids(r)));
  r = await as(U.parentA, 'select id from public.profiles');
  check('Parent A can read only their own profile', JSON.stringify(ids(r)) === JSON.stringify([U.parentA]));
  r = await as(U.parentA, `select count(*)::int as n from public.submission_events where submission_id=$1`, [sub2]);
  check("Parent A cannot read Parent B's events", r.rows[0].n === 0);
  r = await as(U.parentA, `select count(*)::int as n from public.attachments where submission_id=$1`, [sub1]);
  check('Parent A can read the attachment on their own submission', r.rows[0].n === 1);
  r = await as(U.parentB, `select count(*)::int as n from public.attachments`);
  check("Parent B cannot read Parent A's attachments", r.rows[0].n === 0);
  r = await as(U.parentA, 'select id from public.incidents');
  check("Parent A sees no accident reports for other families' children", count(r) === 0);
  r = await as(U.parentB, 'select id from public.incidents');
  check("Parent B sees the accident report about their child Gamma", JSON.stringify(ids(r)) === JSON.stringify([inc1]));
  r = await as(U.parentA, 'select id from public.classes');
  check("Parent A sees only their child's class", count(r) === 1);

  r = await as(U.parentA, `select message from public.submission_events where submission_id=$1`, [sub1]);
  const msgs = (r.rows || []).map((x) => x.message).join('|');
  check('Parent A never receives internal staff notes', !msgs.includes('INTERNAL'), msgs);
  check('Parent A does see the update meant for them', msgs.includes('Seed update'));

  r = await as(U.parentA, 'select internal_findings from public.investigation_internal');
  check('Parents cannot read internal investigation findings', count(r) === 0);
  r = await as(U.parentC, 'select findings_for_parent from public.investigations');
  check('Parent C reads the findings written for them', count(r) === 1 && r.rows[0].findings_for_parent.startsWith('Seed findings'));
  r = await as(U.parentA, 'select id from public.investigations');
  check("Parent A cannot see Parent C's investigation", count(r) === 0);
  r = await as(U.parentC, 'select step from public.investigation_steps');
  check('Parent C sees investigation step names', count(r) === 1);

  r = await as(U.parentA, 'select * from public.ratings');
  check("Parent A cannot read other parents' ratings", count(r) === 0);
  r = await as(U.parentB, 'select * from public.ratings');
  check('Parent B can re-read their own rating', count(r) === 1);

  r = await as(U.parentA, `select public.submission_handler_name($1) as n`, [sub2]);
  check("handler-name lookup refuses another parent's case", r.rows[0].n === null);

  r = await as(U.parentA, `update public.profiles set role='owner' where id=$1`, [U.parentA]);
  check('a parent cannot make themselves owner', !!r.error, r.error);
  r = await as(U.parentA, `update public.profiles set full_name='New Name' where id=$1 returning id`, [U.parentA]);
  check('a parent can edit their own name', !r.error && count(r) === 1, r.error);
  r = await as(U.parentA, `update public.submissions set status='closed' where id=$1`, [sub1]);
  check('a parent cannot change a case status directly', !r.error && count(r) === 0, r.error);
  r = await as(U.parentA, `insert into public.children (full_name, date_of_birth) values ('x','2024-01-01')`);
  check('a parent cannot create children', !!r.error, r.error);
  r = await as(U.parentA, `insert into public.parent_children values ($1, $2)`, [U.parentA, beta]);
  check("a parent cannot link themselves to someone else's child", !!r.error, r.error);
  r = await as(null, 'select id from public.submissions');
  check('a logged-out visitor can read nothing', !!r.error || count(r) === 0, r.error);
  r = await as(U.parentA, `insert into public.submission_events (submission_id, event_type, message, visible_to_parent)
                           values ($1, 'parent_reply', 'Thanks', true)`, [sub1]);
  check('a parent can reply on their own case', !r.error, r.error);
  r = await as(U.parentA, `insert into public.submission_events (submission_id, event_type, message, visible_to_parent)
                           values ($1, 'parent_reply', 'Hi', true)`, [sub2]);
  check("a parent cannot reply on someone else's case", !!r.error, r.error);
  r = await as(U.parentA, `insert into public.submission_events (submission_id, event_type, message, visible_to_parent)
                           values ($1, 'internal_note', 'sneaky', false)`, [sub1]);
  check('a parent cannot write an internal note', !!r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Resolution and investigation actions ==');
{
  await asKeep(U.admin, `update public.submissions set status='resolved' where id=$1`, [sub1]);
  let r = await asKeep(U.parentA, `select public.respond_to_resolution($1, false)`, [sub1]);
  const s = (await db.query(`select status, escalation_level, parent_satisfied from public.submissions where id=$1`, [sub1])).rows[0];
  check('"not satisfied" reopens the case and moves it up one level', !r.error && s.status === 'in_progress' && s.escalation_level === 2 && s.parent_satisfied === false, JSON.stringify(s) + (r.error || ''));
  r = await as(U.parentB, `select public.respond_to_resolution($1, true)`, [sub1]);
  check("another parent cannot answer for someone else's case", !!r.error, r.error);

  r = await as(U.parentB, `select public.mark_incident_read($1)`, [inc1]);
  check('parent can mark an accident report as read', !r.error, r.error);
  r = await as(U.parentA, `select public.mark_incident_read($1)`, [inc1]);
  check("parent cannot mark another family's accident report", !!r.error, r.error);

  r = await asKeep(U.parentC, `select public.respond_to_investigation($1, 'disagreed')`, [inv1]);
  const e = (await db.query(`select escalation_level from public.submissions where id=$1`, [sub3])).rows[0];
  check('parent disagreeing escalates the case to the owner (level 4)', !r.error && e.escalation_level === 4, r.error);
  r = await as(U.parentA, `select public.respond_to_investigation($1, 'acknowledged')`, [inv1]);
  check("another parent cannot respond to someone else's investigation", !!r.error, r.error);

  // steps cannot be skipped; closing needs findings + actions
  r = await as(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'findings')`, [inv1]);
  check('investigation steps cannot be skipped', !!r.error, r.error);
  for (const step of ['parent_called', 'facts_gathered', 'findings']) {
    r = await asKeep(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, $2)`, [inv1, step]);
    if (r.error) check('step ' + step, false, r.error);
  }
  r = await as(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'actions_taken')`, [inv1]);
  check('steps in order are accepted', !r.error, r.error);
  await asKeep(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'actions_taken')`, [inv1]);
  await asKeep(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'parent_informed')`, [inv1]);
  r = await as(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'closed')`, [inv1]);
  check('closing without "actions taken" is refused', !!r.error, r.error);
  await asKeep(U.manager, `update public.investigation_internal set actions_taken='Seed actions' where investigation_id=$1`, [inv1]);
  r = await asKeep(U.manager, `insert into public.investigation_steps (investigation_id, step) values ($1, 'closed')`, [inv1]);
  const i = (await db.query(`select status, closed_at is not null as closed from public.investigations where id=$1`, [inv1])).rows[0];
  check('closing with findings and actions marks the investigation closed', !r.error && i.status === 'closed' && i.closed, r.error);
  r = await as(U.parentC, `select event_type, new_value from public.submission_events where submission_id=$1 and event_type='investigation_step'`, [sub3]);
  check('parent sees investigation step names in their timeline', count(r) >= 5, String(count(r)));
}

// ---------------------------------------------------------------------------
console.log('\n== Teachers ==');
{
  let r = await as(U.hana, 'select id from public.children order by id');
  check('Hana sees only her own class children (Alpha, Beta)', JSON.stringify(ids(r)) === JSON.stringify([alpha, beta]), JSON.stringify(ids(r)));
  r = await as(U.hana, 'select id from public.submissions order by id');
  check('Hana sees submissions for her class but NOT the complaint about herself', JSON.stringify(ids(r)) === JSON.stringify([sub1]), JSON.stringify(ids(r)));
  r = await as(U.mariam, 'select id from public.submissions order by id');
  check('Mariam sees only her own class submissions (Delta safety concern)', JSON.stringify(ids(r)) === JSON.stringify([sub3]), JSON.stringify(ids(r)));
  r = await as(U.hana, `select count(*)::int as n from public.submission_events where submission_id=$1`, [sub2]);
  check('Hana cannot read the timeline of the complaint about herself', r.rows[0].n === 0);
  r = await as(U.hana, 'select id from public.incidents');
  check("Hana does not see incidents in Mariam's class", count(r) === 0);
  r = await as(U.mariam, 'select id from public.incidents');
  check('Mariam sees the incident in her class', count(r) === 1);
  r = await as(U.hana, 'select * from public.ratings');
  check('Teachers cannot read ratings', count(r) === 0);
  r = await as(U.hana, 'select * from public.investigations');
  check('Teachers cannot read investigations', count(r) === 0);
  r = await as(U.hana, 'select * from public.investigation_internal');
  check('Teachers cannot read internal findings', count(r) === 0);
  r = await as(U.hana, 'select id from public.profiles order by id');
  check('Hana sees herself and the parents of her children only', JSON.stringify(ids(r)) === JSON.stringify([U.hana, U.parentA, U.parentB, U.parentC].sort()), JSON.stringify(ids(r)));
  r = await as(U.hana, `insert into public.incidents (child_id, occurred_at, location, what_happened, severity, reported_by)
                        values ($1, now(), 'Garden', 'Fell', 'serious', $2)`, [alpha, U.hana]);
  check('a serious accident cannot be saved without "parent called at"', !!r.error, r.error);
  r = await as(U.hana, `insert into public.incidents (child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
                        values ($1, now(), 'Garden', 'Fell', 'serious', now(), $2)`, [alpha, U.hana]);
  check('a serious accident with "parent called at" is saved', !r.error, r.error);
  r = await as(U.hana, `insert into public.incidents (child_id, occurred_at, location, what_happened, severity, reported_by)
                        values ($1, now(), 'Garden', 'Scrape', 'minor', $2)`, [gamma, U.hana]);
  check("Hana cannot log an accident for a child outside her class", !!r.error, r.error);
  r = await as(U.hana, `update public.submissions set assigned_to = $2 where id=$1`, [sub1, U.hana]);
  check('Hana can take a case from her own class', !r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Admin, manager, owner ==');
{
  let r = await as(U.admin, 'select id from public.submissions');
  check('Admin sees all submissions', count(r) === 3);
  r = await as(U.admin, 'select id from public.investigations');
  check('Admin can see that investigations exist', count(r) === 1);
  r = await as(U.admin, 'select * from public.investigation_internal');
  check('Admin cannot read internal findings', count(r) === 0);
  r = await as(U.admin, 'select * from public.ratings');
  check('Admin cannot read ratings', count(r) === 0);
  r = await as(U.manager, 'select * from public.investigation_internal');
  check('Manager reads internal findings', count(r) === 1);
  r = await as(U.owner, 'select * from public.ratings');
  check('Owner reads ratings', count(r) === 1);
  r = await as(U.manager, 'select * from public.ratings');
  check('Manager reads ratings', count(r) === 1);
  r = await as(U.owner, 'select id from public.submissions');
  check('Owner sees all submissions, including the complaint about a teacher', count(r) === 3);
  r = await as(U.admin, `update public.profiles set role='owner' where id=$1`, [U.admin]);
  check('even an admin cannot change roles from the browser', !!r.error, r.error);
  r = await as(U.admin, `insert into public.investigations (submission_id) values ($1)`, [sub1]);
  check('only manager/owner can open an investigation', !!r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Ratings, attachments, deactivation, storage ==');
{
  let r = await as(U.parentA, `insert into public.ratings (parent_id, child_id, class_id, care_score, communication_score, daily_reports_score)
                               values ($1, $2, null, 4, 4, 4) returning class_id`, [U.parentA, alpha]);
  check("rating's class is filled in from the child", !r.error && r.rows[0].class_id === ID(201), r.error);
  r = await as(U.parentA, `insert into public.ratings (parent_id, child_id, care_score, communication_score, daily_reports_score)
                           values ($1, $2, 6, 4, 4)`, [U.parentA, alpha]);
  check('scores outside 1-5 are refused', !!r.error, r.error);
  await asKeep(U.parentA, `insert into public.ratings (parent_id, child_id, care_score, communication_score, daily_reports_score) values ($1,$2,4,4,4)`, [U.parentA, alpha]);
  r = await as(U.parentA, `insert into public.ratings (parent_id, child_id, care_score, communication_score, daily_reports_score) values ($1,$2,3,3,3)`, [U.parentA, alpha]);
  check('only one rating per child per month', !!r.error, r.error);
  r = await as(U.parentA, `insert into public.ratings (parent_id, child_id, care_score, communication_score, daily_reports_score) values ($1,$2,3,3,3)`, [U.parentA, beta]);
  check("parent cannot rate another family's child", !!r.error, r.error);

  const att = (sub, file, mime, size) => `insert into public.attachments (submission_id, uploaded_by, storage_path, file_name, mime_type, size_bytes)
                           values ('${sub}', '${U.parentA}', '${sub}/${file}', '${file}', '${mime}', ${size})`;
  r = await as(U.parentA, att(sub1, 'a.jpg', 'image/jpeg', 6000000));
  check('files over 5 MB are refused', !!r.error && /size_bytes/.test(r.error), r.error);
  r = await as(U.parentA, att(sub1, 'a.exe', 'application/x-msdownload', 1000));
  check('non-image files are refused', !!r.error && /mime_type/.test(r.error), r.error);
  r = await as(U.parentA, att(sub1, 'a.jpg', 'image/jpeg', 1000));
  check('a normal photo on your own case is accepted', !r.error, r.error);
  r = await as(U.parentA, att(sub2, 'a.jpg', 'image/jpeg', 1000));
  check("a parent cannot attach files to someone else's case", !!r.error && /row-level security/.test(r.error), r.error);

  const bucket = (await db.query(`select public, file_size_limit from storage.buckets where id='attachments'`)).rows[0];
  check('storage bucket is private with a 5 MB limit', bucket.public === false && Number(bucket.file_size_limit) === 5242880);
  await db.exec(`insert into storage.objects (bucket_id, name) values ('attachments', '${sub1}/seed-photo.jpg'), ('attachments', '${sub2}/other.jpg')`);
  r = await as(U.parentA, 'select name from storage.objects');
  check('parent can read only files on their own case', count(r) === 1 && r.rows[0].name.startsWith(sub1), JSON.stringify(r.rows));
  r = await as(U.parentA, `insert into storage.objects (bucket_id, name) values ('attachments', '${sub2}/hack.jpg')`);
  check("parent cannot upload into someone else's case folder", !!r.error, r.error);
  r = await as(U.admin, 'select name from storage.objects');
  check('admin can read case files', count(r) === 2);

  await db.exec(`update public.profiles set active=false where id='${U.parentA}'`);
  r = await as(U.parentA, 'select id from public.submissions');
  check('a deactivated parent loses all access immediately', count(r) === 0);
  await db.exec(`update public.profiles set active=true where id='${U.parentA}'`);

  r = await as(U.parentA, `insert into public.parent_children values ('${U.parentB}', '${alpha}')`);
  check('a child cannot have more than two parents (and parents cannot add links)', !!r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Removing the seed data before launch ==');
{
  // Add a real (non-seed) family first: the clean-up must leave it alone.
  await db.exec(`
    insert into auth.users (id, email) values ('00000000-0000-4000-9000-000000000001', 'real.parent@example.com');
    insert into public.profiles (id, full_name, role) values ('00000000-0000-4000-9000-000000000001', 'Real Parent', 'parent');
    insert into public.children (id, full_name, date_of_birth) values ('00000000-0000-4000-9000-000000000002', 'Real Child', '2024-01-01');
    insert into public.parent_children values ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000002');`);
  await db.exec(readFileSync(join(root, 'remove-seed-data.sql'), 'utf8'));
  const left = async (t) => Number((await db.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  const gone = ['submissions', 'submission_events', 'incidents', 'investigations', 'investigation_steps', 'investigation_internal',
                'ratings', 'attachments', 'classes', 'staff_classes'];
  let allGone = true;
  for (const t of gone) if ((await left('public.' + t)) !== 0) allGone = false;
  check('all seed submissions, events, incidents, investigations and ratings are removed', allGone);
  check('seed logins are removed', (await left(`auth.users where email like '%seed.cka.test'`)) === 0 && (await left('auth.identities')) === 0);
  check('real families are untouched', (await left('public.profiles')) === 1 && (await left('public.children')) === 1 && (await left('public.parent_children')) === 1);
  const t = (await db.query(`select tgname, tgenabled from pg_trigger where tgname in ('submission_events_no_update', 'investigation_steps_no_change')`)).rows;
  check('timeline and investigation-step protections are switched back on after the clean-up', t.length === 2 && t.every((x) => x.tgenabled === 'O'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
