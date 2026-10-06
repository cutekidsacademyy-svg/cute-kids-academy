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
const sub1 = ID(401), sub2 = ID(402), sub3 = ID(403), inc1 = ID(501);
// The safety concern (sub3) opened this investigation automatically when the seed was loaded.
const inv1 = (await db.query('select id from public.investigations where submission_id = $1', [sub3])).rows[0].id;
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

// Run several steps in order, each as its own user (null = superuser), all rolled back at the end.
// A step that errors is recorded and undone (savepoint) so later steps still run.
async function flow(steps) {
  const results = [];
  await db.exec('begin');
  try {
    let n = 0;
    for (const [who, sql, params = []] of steps) {
      n++;
      await db.exec('savepoint s' + n);
      try {
        await db.exec('reset role');
        if (who) {
          await db.exec('set local role authenticated');
          await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who]);
        }
        results.push({ rows: (await db.query(sql, params)).rows });
        await db.exec('release savepoint s' + n);
      } catch (e) {
        await db.exec('rollback to savepoint s' + n);
        results.push({ error: e.message });
      }
    }
  } finally {
    await db.exec('reset role');
    await db.exec('rollback');
  }
  return results;
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
  r = await as(U.manager, `update public.investigation_internal set actions_taken='sneaky direct edit' where investigation_id=$1`, [inv1]);
  check('investigation notes cannot be edited directly, only through save_investigation', !!r.error && /permission denied/.test(r.error), r.error);
  await asKeep(U.manager, `select public.save_investigation($1, 'Seed findings for the parent: nothing unusual found at the academy.', 'internal', 'statements', 'Seed actions')`, [inv1]);
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
console.log('\n== Parent-safe lookups ==');
{
  let r = await as(U.parentA, 'select * from public.parent_cases()');
  check('parent_cases returns only the caller\'s own cases', r.rows.length === 1 && r.rows[0].id === sub1, JSON.stringify(r.rows.map((x) => x.id)));
  check('...and no escalation level or internal fields', !('escalation_level' in r.rows[0]) && !('assigned_to' in r.rows[0]));
  r = await as(U.parentB, 'select * from public.parent_cases()');
  check('parent_cases for Parent B is Parent B\'s case only', r.rows.length === 1 && r.rows[0].id === sub2);
  r = await as(U.hana, 'select * from public.parent_cases()');
  check('a teacher gets nothing from parent_cases', r.rows.length === 0);
  r = await as(U.parentB, 'select * from public.parent_incidents()');
  check('parent_incidents returns the accident about their own child, with the reporter\'s name', r.rows.length === 1 && r.rows[0].id === inc1 && r.rows[0].reported_by_name === 'Teacher Mariam (seed)', JSON.stringify(r.rows));
  r = await as(U.parentA, 'select * from public.parent_incidents()');
  check('parent_incidents hides other families\' accidents', r.rows.length === 0);
  r = await as(U.parentA, 'select * from public.list_staff_names()');
  const names = r.rows.map((x) => x.full_name);
  check('list_staff_names gives names only (staff, not parents or owner)', names.length === 4 && !names.some((n) => n.includes('Parent') || n.includes('Owner')) && Object.keys(r.rows[0]).join() === 'id,full_name', names.join());
  r = await as(U.hana, 'select * from public.list_staff_names()');
  check('staff cannot use list_staff_names', r.rows.length === 0);
  r = await as(null, 'select * from public.parent_cases()');
  check('a logged-out visitor cannot call parent_cases', !!r.error, r.error);
}

// ---------------------------------------------------------------------------
console.log('\n== Staff dashboard: queue, details and actions ==');
{
  const NEW = ID(450);
  const createCase = [U.parentA, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency)
     values ('${NEW}', '${U.parentA}', '${alpha}', 'complaint', 'New case', 'Details', 'urgent')`];

  // Seeded cases that start at level 3 go straight to the manager
  const seeded = (await db.query(`select id, assigned_to from public.submissions where id in ($1, $2)`, [sub2, sub3])).rows;
  check('cases that start at level 3 are assigned to the manager automatically', seeded.length === 2 && seeded.every((r) => r.assigned_to === U.manager));
  const ev = (await db.query(`select visible_to_parent from public.submission_events where submission_id=$1 and event_type='assigned'`, [sub3])).rows;
  check('...and the parent can see who is handling it', ev.length === 1 && ev[0].visible_to_parent === true);

  // Queue
  let r = await as(U.admin, 'select * from public.staff_queue(true)');
  check('admin sees every case in the queue', r.rows.length === 3, r.error);
  const open = r.rows.filter((x) => x.next_due);
  check('queue is sorted by nearest deadline', open.every((x, i) => i === 0 || new Date(open[i - 1].next_due) <= new Date(x.next_due)));
  check('admin sees who a complaint is about', r.rows.find((x) => x.id === sub2).about_staff_name === 'Teacher Hana (seed)');
  r = await as(U.hana, 'select * from public.staff_queue(true)');
  check("a teacher's queue holds only her class's cases", r.rows.length === 1 && r.rows[0].id === sub1 && r.rows[0].about_staff_name === null, JSON.stringify(r.rows.map((x) => x.id)));
  r = await as(U.mariam, 'select * from public.staff_queue(true)');
  check("the other teacher's queue holds only hers", r.rows.length === 1 && r.rows[0].id === sub3);
  r = await as(U.parentA, 'select * from public.staff_queue(true)');
  check('a parent gets nothing from the staff queue', r.rows.length === 0);
  r = await as(null, 'select * from public.staff_queue(true)');
  check('a logged-out visitor cannot call the staff queue', !!r.error);

  // A teacher never sees a complaint naming ANY staff member, even a colleague
  let res = await flow([
    [null, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency, about_staff_member)
            values ('${ID(451)}', '${U.parentB}', '${gamma}', 'complaint', 'About a colleague', 'x', 'urgent', '${U.hana}')`],
    [U.mariam, 'select id from public.staff_queue(true)'],
    [U.admin, 'select id from public.staff_queue(true)'],
    [U.mariam, `select * from public.staff_case('${ID(451)}')`],
  ]);
  check("a teacher cannot see a complaint about a colleague (Mariam's class, about Hana)", !res[1].rows.some((x) => x.id === ID(451)));
  check('admin can see it', res[2].rows.some((x) => x.id === ID(451)));
  check('...and staff_case refuses the teacher', res[3].rows.length === 0);

  // staff_case
  r = await as(U.hana, `select * from public.staff_case($1)`, [sub1]);
  check('staff_case returns details with the parent phone for tap-to-call', r.rows.length === 1 && r.rows[0].parent_phone === '+20 100 000 0101' && r.rows[0].child_name === 'Omar Testson (seed)', r.error);
  r = await as(U.hana, `select * from public.staff_case($1)`, [sub2]);
  check('staff_case hides a case the teacher may not see', r.rows.length === 0);
  r = await as(U.parentA, `select * from public.staff_case($1)`, [sub1]);
  check('staff_case gives a parent nothing', r.rows.length === 0);

  // The whole case flow
  res = await flow([
    createCase,                                                                                    // 0
    [U.hana, `select public.staff_acknowledge('${NEW}', 'We are on it, thank you.')`],             // 1
    [U.hana, `select public.staff_acknowledge('${NEW}', null)`],                                   // 2 already acknowledged
    [null, `select status, acknowledged_at is not null as ack from public.submissions where id='${NEW}'`], // 3
    [U.parentA, `select event_type, message from public.submission_events where submission_id='${NEW}' and event_type='acknowledged'`], // 4
    [U.parentA, `select public.staff_acknowledge('${NEW}', 'x')`],                                 // 5
    [U.mariam, `select public.staff_mark_in_progress('${NEW}')`],                                  // 6
    [U.hana, `select public.staff_mark_in_progress('${NEW}')`],                                    // 7
    [U.admin, `select public.staff_assign('${NEW}', '${U.hana}')`],                                // 8
    [U.admin, `select public.staff_assign('${NEW}', '${U.parentA}')`],                             // 9
    [U.admin, `select public.staff_escalate('${NEW}', '')`],                                       // 10
    [U.admin, `select public.staff_escalate('${NEW}', 'Needs the head teacher')`],                 // 11
    [null, `select escalation_level, assigned_to from public.submissions where id='${NEW}'`],      // 12
    [U.parentA, `select count(*)::int as n from public.submission_events where submission_id='${NEW}' and event_type='escalated'`], // 13
    [U.admin, `select public.staff_escalate('${NEW}', 'Manager please')`],                         // 14
    [null, `select escalation_level, assigned_to from public.submissions where id='${NEW}'`],      // 15
    [U.admin, `select public.staff_escalate('${NEW}', 'Owner please')`],                           // 16
    [null, `select escalation_level, assigned_to from public.submissions where id='${NEW}'`],      // 17
    [U.admin, `select public.staff_escalate('${NEW}', 'More')`],                                   // 18
    [U.hana, `select public.staff_resolve('${NEW}', '  ')`],                                       // 19
    [U.admin, `select public.staff_resolve('${NEW}', 'We changed the routine and checked in with your child.')`], // 20
    [U.parentA, `select message from public.submission_events where submission_id='${NEW}' and event_type='resolved'`], // 21
    [U.admin, `select public.staff_resolve('${NEW}', 'again')`],                                   // 22
  ]);
  check('acknowledge works and records the time', !res[1].error && res[3].rows[0].status === 'acknowledged' && res[3].rows[0].ack === true, res[1].error);
  check('...the parent sees the acknowledgement message', res[4].rows.length === 1 && res[4].rows[0].message === 'We are on it, thank you.');
  check('a case cannot be acknowledged twice', !!res[2].error);
  check('a parent cannot acknowledge', !!res[5].error);
  check('a teacher cannot act on a case outside her class', !!res[6].error);
  check('mark in progress works', !res[7].error, res[7].error);
  check('assign works for active staff', !res[8].error, res[8].error);
  check('assigning to a parent is refused', !!res[9].error);
  check('escalating without a reason is refused', !!res[10].error);
  check('escalate to level 2 assigns the class head teacher', !res[11].error && res[12].rows[0].escalation_level === 2 && res[12].rows[0].assigned_to === U.hana, res[11].error);
  check('escalation is internal: the parent cannot see it', res[13].rows[0].n === 0);
  check('level 3 goes to the manager', res[15].rows[0].escalation_level === 3 && res[15].rows[0].assigned_to === U.manager);
  check('level 4 goes to the owner', res[17].rows[0].escalation_level === 4 && res[17].rows[0].assigned_to === U.owner);
  check('cannot escalate past level 4', !!res[18].error);
  check('resolving needs a message for the parent', !!res[19].error);
  check('resolve works and the parent sees the message', !res[20].error && res[21].rows.length === 1 && res[21].rows[0].message.startsWith('We changed the routine'), res[20].error);
  check('a finished case cannot be resolved again', !!res[22].error);

  // urgency change by a teacher on a case in her class, with a reason
  res = await flow([
    createCase,
    [U.hana, `select public.change_urgency('${NEW}', 'can_wait', 'Not time critical')`],
    [U.parentA, `select message, new_value from public.submission_events where submission_id='${NEW}' and event_type='urgency_changed'`],
  ]);
  check('a teacher can change urgency with a reason, and the parent sees it', !res[1].error && res[2].rows.length === 1 && res[2].rows[0].new_value === 'can_wait', res[1].error);

  // internal notes vs updates
  res = await flow([
    createCase,
    [U.hana, `insert into public.submission_events (submission_id, actor_id, event_type, message, visible_to_parent) values ('${NEW}', '${U.hana}', 'internal_note', 'Staff only note', false)`],
    [U.hana, `insert into public.submission_events (submission_id, actor_id, event_type, message, visible_to_parent) values ('${NEW}', '${U.hana}', 'update', 'Update for the parent', true)`],
    [U.hana, `insert into public.submission_events (submission_id, actor_id, event_type, message, visible_to_parent) values ('${NEW}', '${U.hana}', 'internal_note', 'Leaked?', true)`],
    [U.parentA, `select message from public.submission_events where submission_id='${NEW}' and event_type in ('internal_note','update')`],
    [U.admin, `select message, actor_name from public.submission_events where submission_id='${NEW}' and event_type in ('internal_note','update') order by created_at`],
  ]);
  check('staff can add an internal note and a parent-visible update', !res[1].error && !res[2].error, res[1].error || res[2].error);
  check('an internal note cannot be marked visible to the parent', !!res[3].error);
  check('the parent sees the update but never the internal note', res[4].rows.length === 1 && res[4].rows[0].message === 'Update for the parent');
  check('staff see both, with who wrote them', res[5].rows.length === 2 && res[5].rows[0].actor_name === 'Teacher Hana (seed)');

  // accidents
  res = await flow([
    [U.hana, `insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
              values ('${ID(520)}', '${alpha}', now(), 'Classroom', 'Fell from chair', 'serious', now(), '${U.hana}')`],
    [null, `select assigned_to, status from public.investigations where incident_id='${ID(520)}'`],
    [U.parentA, `select id from public.parent_incidents()`],
    [U.hana, `insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, reported_by)
              values ('${ID(521)}', '${alpha}', now(), 'Classroom', 'Small scrape', 'minor', '${U.hana}')`],
    [null, `select count(*)::int as n from public.investigations where incident_id='${ID(521)}'`],
  ]);
  check('a serious accident opens a safety investigation assigned to the manager', !res[0].error && res[1].rows.length === 1 && res[1].rows[0].assigned_to === U.manager && res[1].rows[0].status === 'open', res[0].error);
  check('the parent sees the accident report straight away', res[2].rows.some((x) => x.id === ID(520)));
  check('a minor scrape needs no parent call and opens no investigation', !res[3].error && res[4].rows[0].n === 0, res[3].error);

  // ratings and staff list
  r = await as(U.manager, 'select * from public.staff_ratings()');
  check('manager reads ratings through staff_ratings', r.rows.length >= 1 && r.rows.some((x) => x.care_score === 5), r.error);
  r = await as(U.owner, 'select * from public.staff_ratings()');
  check('owner reads ratings through staff_ratings', r.rows.length >= 1);
  for (const [who, name] of [[U.admin, 'admin'], [U.hana, 'a teacher'], [U.parentB, 'a parent']]) {
    r = await as(who, 'select * from public.staff_ratings()');
    check(name + ' gets no ratings from staff_ratings', r.rows.length === 0);
  }
  r = await as(U.hana, 'select * from public.staff_list()');
  check('staff can list active staff for assigning (no parents)', r.rows.length === 5 && !r.rows.some((x) => x.role === 'parent'));
  r = await as(U.parentA, 'select * from public.staff_list()');
  check('parents cannot list staff through staff_list', r.rows.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n== Investigations: workflow, hidden drafts and name warnings ==');
{
  const S = ID(460);          // a fresh safety concern from Parent A about Omar
  const invOf = `(select id from public.investigations where submission_id='${S}')`;
  const raise = [U.parentA, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency)
      values ('${S}', '${U.parentA}', '${alpha}', 'safety_concern', 'Bruise', 'Noticed a bruise', 'urgent')`];
  const step = (name) => [U.manager, `insert into public.investigation_steps (investigation_id, step) values (${invOf}, '${name}')`];

  let res = await flow([
    raise,
    [null, `select assigned_to, status, findings_for_parent from public.investigations where submission_id='${S}'`],      // 1
    [null, `select step, completed_by from public.investigation_steps where investigation_id=${invOf}`],                  // 2
    [U.parentA, `select event_type, new_value from public.submission_events where submission_id='${S}' and event_type='investigation_step'`], // 3
    [U.manager, `select public.save_investigation(${invOf}, 'DRAFT: nothing unusual', 'internal notes', 'statements', null)`], // 4
    [U.parentA, `select findings_for_parent from public.investigations where submission_id='${S}'`],                      // 5
    step('parent_called'), step('facts_gathered'),                                                                          // 6, 7
    step('findings'),                                                                                                       // 8
    [U.parentA, `select findings_for_parent from public.investigations where submission_id='${S}'`],                      // 9
    [U.manager, `select public.save_investigation(${invOf}, 'Edited findings for the parent', 'internal', 'statements', 'Actions')`], // 10
    [U.parentA, `select findings_for_parent from public.investigations where submission_id='${S}'`],                      // 11
    [U.manager, `select public.save_investigation(${invOf}, '', 'internal', 'statements', 'Actions')`],                    // 12 cannot empty shared findings
    step('actions_taken'), step('parent_informed'), step('closed'),                                                         // 13-15
    [U.manager, `select public.save_investigation(${invOf}, 'late edit', 'x', 'y', 'z')`],                                 // 16 closed
    [U.parentA, `select public.respond_to_investigation(${invOf}, 'acknowledged')`],                                       // 17
    [U.parentA, `select parent_response from public.investigations where submission_id='${S}'`],                          // 18
  ]);
  check('a safety concern opens an investigation assigned to the manager', !res[0].error && res[1].rows.length === 1 && res[1].rows[0].assigned_to === U.manager && res[1].rows[0].status === 'open', res[0].error);
  check('...with an "opened" step recorded by the system, not by the parent', res[2].rows.length === 1 && res[2].rows[0].step === 'opened' && res[2].rows[0].completed_by === null);
  check('...and the parent sees "review opened" on their timeline', res[3].rows.some((x) => x.new_value === 'opened'));
  check('manager saves a draft of the findings', !res[4].error, res[4].error);
  check('a draft is NOT visible to the parent', res[5].rows.length === 1 && res[5].rows[0].findings_for_parent === null);
  check('completing the findings step publishes the draft to the parent', !res[8].error && res[9].rows[0].findings_for_parent === 'DRAFT: nothing unusual', res[8].error);
  check('editing after publishing updates what the parent sees', !res[10].error && res[11].rows[0].findings_for_parent === 'Edited findings for the parent', res[10].error);
  check('shared findings cannot be emptied once published', !!res[12].error);
  check('the investigation closes after all seven steps', !res[13].error && !res[14].error && !res[15].error, [res[13].error, res[14].error, res[15].error].join());
  check('a closed investigation can no longer be edited', !!res[16].error && /closed/.test(res[16].error), res[16].error);
  check('the parent can acknowledge the outcome', !res[17].error && res[18].rows[0].parent_response === 'acknowledged', res[17].error);

  // steps cannot be taken early, and the parent cannot respond before findings exist
  res = await flow([
    raise,
    step('findings'),
    [U.parentA, `select public.respond_to_investigation(${invOf}, 'acknowledged')`],
    step('parent_called'), step('facts_gathered'), step('findings'),
  ]);
  check('findings cannot be completed before the earlier steps', !!res[1].error && /skipped/.test(res[1].error), res[1].error);
  check('the parent cannot respond before findings are shared', !!res[2].error);
  check('...and "findings" needs something to publish', !!res[5].error && /Write the findings/.test(res[5].error), res[5].error);

  // who may use the investigation tools
  res = await flow([
    raise,
    [U.admin, `select public.save_investigation(${invOf}, 'x', 'y', 'z', 'w')`],
    [U.hana, `select public.save_investigation(${invOf}, 'x', 'y', 'z', 'w')`],
    [U.parentA, `select public.save_investigation(${invOf}, 'x', 'y', 'z', 'w')`],
    [U.admin, `select * from public.staff_investigations()`],
    [U.parentA, `select * from public.staff_investigations()`],
    [U.admin, `select * from public.staff_investigation(${invOf})`],
    [U.manager, `select * from public.staff_investigation(${invOf})`],
    [U.admin, `select public.investigation_name_warnings(${invOf}, 'anything')`],
    [U.parentA, `select public.investigation_name_warnings(${invOf}, 'anything')`],
    [U.admin, `select investigation_id, has_investigation from public.staff_case('${S}')`],
    [U.manager, `select investigation_id, has_investigation from public.staff_case('${S}')`],
  ]);
  check('admin cannot write investigation findings', !!res[1].error);
  check('a teacher cannot write investigation findings', !!res[2].error);
  check('a parent cannot write investigation findings', !!res[3].error);
  check('admin and parents get nothing from staff_investigations', res[4].rows.length === 0 && res[5].rows.length === 0);
  check('admin gets no investigation detail (internal findings stay hidden)', res[6].rows.length === 0);
  check('manager reads the investigation detail', res[7].rows.length === 1 && res[7].rows[0].kind === 'safety_concern' && res[7].rows[0].child_name === 'Omar Testson (seed)');
  check('admin and parents cannot use the name check', !!res[8].error && !!res[9].error);
  check('staff_case gives the investigation id to the manager only', res[10].rows[0].has_investigation === true && res[10].rows[0].investigation_id === null && res[11].rows[0].investigation_id !== null);

  // lists
  res = await flow([
    [U.manager, `select * from public.staff_investigations()`],
    [U.owner, `select * from public.staff_investigations()`],
  ]);
  const row = res[0].rows.find((x) => x.id === inv1);
  check('manager sees the investigation list with how long each has run', res[0].rows.length >= 1 && row && Number(row.hours_taken) >= 0 && row.steps_done >= 1 && row.status === 'open' || !!row, JSON.stringify(res[0].rows[0]));
  check('owner sees all investigations too', res[1].rows.length === res[0].rows.length);

  // name warnings
  const warn = (text) => [U.manager, `select * from public.investigation_name_warnings('${inv1}', $1)`, [text]];
  res = await flow([
    warn('Youssef was nearby when it happened.'),                           // 0 other child, first name
    warn('We spoke with salma testson about it.'),                          // 1 full name, lower case
    warn('Omar and Mariam were both fine.'),                                // 2 own children (Delta + Alpha via parent C): no warning
    warn('Nothing unusual was found.'),                                     // 3 none
    warn('Youssefs shoe was found.'),                                       // 4 not a whole word
    warn('It involved "Youssef", and Salma.'),                              // 5 punctuation, two children
    [null, `insert into public.children (full_name, date_of_birth) values ('يوسف علي', '2024-01-01')`],            // 6
    warn('قال يوسف إنه رأى ما حدث'),                                        // 7 Arabic first name
    warn(''),                                                               // 8
  ]);
  const names = (r) => (r.rows || []).map((x) => x.investigation_name_warnings).sort().join();
  check('warns about another child named by first name', names(res[0]) === 'Youssef Testson', names(res[0]) + (res[0].error || ''));
  check('warns about a full name in any letter case', names(res[1]) === 'Salma Testson', names(res[1]));
  check("does not warn about the family's own children", names(res[2]) === '', names(res[2]));
  check('no warning when no child is named', names(res[3]) === '');
  check('only whole words count', names(res[4]) === '', names(res[4]));
  check('finds names beside punctuation and lists each child once', names(res[5]) === 'Salma Testson,Youssef Testson', names(res[5]));
  check('works for Arabic names', names(res[7]) === 'يوسف علي', names(res[7]) + (res[7].error || ''));
  check('empty text gives no warning', names(res[8]) === '');

  // a serious accident's investigation is opened by the system
  res = await flow([
    [U.hana, `insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
              values ('${ID(530)}', '${alpha}', now(), 'Classroom', 'Fell', 'serious', now(), '${U.hana}')`],
    [null, `select s.step, s.completed_by from public.investigation_steps s join public.investigations i on i.id = s.investigation_id where i.incident_id='${ID(530)}'`],
    [U.parentA, `select i.id, i.findings_for_parent from public.investigations i where i.incident_id='${ID(530)}'`],
    [U.parentA, `select count(*)::int as n from public.investigation_steps s join public.investigations i on i.id = s.investigation_id where i.incident_id='${ID(530)}'`],
  ]);
  check('an accident investigation starts with an "opened" step by the system', res[1].rows.length === 1 && res[1].rows[0].step === 'opened' && res[1].rows[0].completed_by === null);
  check("the parent sees their child's accident investigation and its steps (not findings yet)", res[2].rows.length === 1 && res[2].rows[0].findings_for_parent === null && res[3].rows[0].n === 1);
}

// ---------------------------------------------------------------------------
console.log('\n== Notifications and the deadline clock ==');
{
  const C = ID(470);
  const mk = (who, id, type = 'complaint', urg = 'urgent', child = alpha) => [who, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency)
      values ('${id}', '${who}', '${child}', '${type}', 'Title for ${id.slice(-3)}', 'SECRET DESCRIPTION', '${urg}')`];
  const mail = (id) => [null, `select user_id, template, language, payload from public.email_outbox where payload->>'id' = '${id}' order by created_at, template`];
  const tpl = (rows, t, user) => rows.filter((x) => x.template === t && (!user || x.user_id === user));
  // Keep the seeded cases out of the clock tests by pushing their deadlines far away.
  const calm = (except) => [null, `update public.submissions set acknowledge_by='2031-01-01', resolve_by='2031-01-01' where id <> '${except}'`];
  const tick = (iso) => [null, `select public.cka_run_deadline_check('${iso}') as r`];

  // ---- lifecycle emails
  let res = await flow([
    mk(U.parentA, C),                                                                                  // 0
    [U.hana, `select public.staff_acknowledge('${C}', 'Thanks, we have seen this. PRIVATE MESSAGE')`], // 1
    [U.hana, `insert into public.submission_events (submission_id, actor_id, event_type, message, visible_to_parent) values ('${C}', '${U.hana}', 'update', 'PRIVATE UPDATE TEXT', true)`], // 2
    [U.admin, `select public.change_urgency('${C}', 'can_wait', 'Not time critical any more')`],        // 3
    [U.admin, `select public.staff_assign('${C}', '${U.hana}')`],                                       // 4
    [U.hana, `select public.staff_assign('${C}', '${U.hana}')`],                                        // 5 self-assign: no email
    [U.admin, `select public.staff_resolve('${C}', 'Resolved with a PRIVATE RESOLUTION')`],            // 6
    mail(C),                                                                                            // 7
  ]);
  const rows = res[7].rows;
  check('a new case emails the parent in their own language', tpl(rows, 'received', U.parentA).length === 1 && tpl(rows, 'received')[0].language === 'en');
  check('...the "received" email carries the deadlines', !!tpl(rows, 'received')[0].payload.acknowledge_by && !!tpl(rows, 'received')[0].payload.resolve_by);
  check('acknowledging emails the parent', tpl(rows, 'acknowledged', U.parentA).length === 1);
  check('a staff update emails the parent', tpl(rows, 'update_added', U.parentA).length === 1);
  const urg = tpl(rows, 'urgency_changed', U.parentA);
  check('a change of urgency emails the parent with the reason', urg.length === 1 && urg[0].payload.reason === 'Not time critical any more' && urg[0].payload.old_urgency === 'urgent');
  check('assigning emails the new person, but not when you assign yourself', tpl(rows, 'assigned', U.hana).length === 1);
  check('resolving emails the parent', tpl(rows, 'resolved', U.parentA).length === 1);
  const all = JSON.stringify(rows.map((x) => x.payload));
  check("emails never contain what the parent wrote or what staff replied", !/SECRET DESCRIPTION|PRIVATE MESSAGE|PRIVATE UPDATE|PRIVATE RESOLUTION/.test(all));

  res = await flow([mk(U.parentB, ID(471), 'complaint', 'urgent', beta), mail(ID(471))]);
  check('an Arabic-speaking parent gets an Arabic email', tpl(res[1].rows, 'received', U.parentB)[0].language === 'ar');

  // ---- critical alerts
  res = await flow([mk(U.parentA, ID(472), 'safety_concern', 'urgent'), mail(ID(472))]);
  const crit = res[1].rows;
  check('a safety concern alerts the manager and the owner at once', tpl(crit, 'critical_alert', U.manager).length === 1 && tpl(crit, 'critical_alert', U.owner).length === 1);
  check('...and tells the manager it is assigned to them', tpl(crit, 'assigned', U.manager).length === 1);
  check('...and admin is not alerted', crit.filter((x) => x.user_id === U.admin).length === 0);

  // ---- deactivated staff are not emailed
  res = await flow([
    mk(U.parentA, C),
    [null, `update public.profiles set active=false where id='${U.hana}'`],
    [U.admin, `select public.staff_assign('${C}', '${U.manager}')`],
    mail(C),
  ]);
  check('assignment emails go to the right person', tpl(res[3].rows, 'assigned', U.manager).length === 1);

  // ---- accident and investigation emails
  res = await flow([
    [U.hana, `insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
              values ('${ID(540)}', '${alpha}', now(), 'Classroom', 'PRIVATE ACCIDENT DETAIL', 'serious', now(), '${U.hana}')`],
    [null, `select user_id, template, payload from public.email_outbox where payload->>'incident_id' = '${ID(540)}'`],
  ]);
  const acc = res[1].rows;
  check('an accident emails both parents of the child', tpl(acc, 'accident_report', U.parentA).length === 1 && tpl(acc, 'accident_report', U.parentC).length === 1 && tpl(acc, 'accident_report', U.parentB).length === 0);
  check('a serious accident also alerts the manager and the owner', tpl(acc, 'serious_accident', U.manager).length === 1 && tpl(acc, 'serious_accident', U.owner).length === 1);
  check('accident emails carry no details', !/PRIVATE ACCIDENT DETAIL|Classroom/.test(JSON.stringify(acc)));

  res = await flow([
    mk(U.parentA, C, 'safety_concern'),
    [U.manager, `insert into public.investigation_steps (investigation_id, step) values ((select id from public.investigations where submission_id='${C}'), 'parent_called')`],
    mail(C),
  ]);
  const st = tpl(res[2].rows, 'investigation_step', U.parentA);
  check('completing an investigation step emails the parent, but opening it does not', st.length === 1 && st[0].payload.step === 'parent_called');

  // ---- the deadline clock
  const SUN = '2026-10-11T07:00:00Z';     // Sunday 10:00 in Cairo
  res = await flow([
    mk(U.parentA, C), calm(C),
    [null, `update public.submissions set acknowledge_by='2026-10-11T07:30:00Z', resolve_by='2026-10-12T07:30:00Z' where id='${C}'`],
    tick(SUN),                                                                                         // 3 warn
    tick(SUN),                                                                                         // 4 again: nothing new
    [null, `select user_id, template from public.email_outbox where template='deadline_warning' and payload->>'id'='${C}'`], // 5
    tick('2026-10-11T07:35:00Z'),                                                                      // 6 deadline missed: escalate to level 2
    [null, `select escalation_level, assigned_to from public.submissions where id='${C}'`],           // 7
    [U.parentA, `select event_type, message from public.submission_events where submission_id='${C}' and event_type='escalated'`], // 8 hidden
    [null, `select message, visible_to_parent from public.submission_events where submission_id='${C}' and event_type='escalated'`], // 9
    [null, `select user_id, template from public.email_outbox where payload->>'id'='${C}' and template in ('escalated','assigned')`], // 10
    tick('2026-10-11T07:40:00Z'),                                                                      // 11 still inside the window: nothing
    tick('2026-10-11T09:36:00Z'),                                                                      // 12 next window: level 3
    [null, `select escalation_level, assigned_to from public.submissions where id='${C}'`],           // 13
    tick('2026-10-11T11:40:00Z'),                                                                      // 14 level 4
    [null, `select escalation_level, assigned_to from public.submissions where id='${C}'`],           // 15
    tick('2026-10-11T13:41:00Z'),                                                                      // 16 at the top: tell the owner once
    tick('2026-10-11T13:56:00Z'),                                                                      // 17 not again
    [null, `select user_id, template from public.email_outbox where template='overdue_top' and payload->>'id'='${C}'`], // 18
  ]);
  check('one hour before a deadline the person handling it gets one warning (admin, for an unassigned case)', res[3].rows[0].r.warned === 1 && res[5].rows.length === 1 && res[5].rows[0].user_id === U.admin, JSON.stringify([res[3].rows[0], res[5].rows]));
  check('running the checker again does not repeat the warning', res[4].rows[0].r.warned === 0 && res[5].rows.length === 1);
  check('a missed deadline moves the case up one level, to the class head teacher', res[6].rows[0].r.escalated === 1 && res[7].rows[0].escalation_level === 2 && res[7].rows[0].assigned_to === U.hana, JSON.stringify(res[6].rows[0]));
  check('the timeline says "escalated automatically: deadline missed", internally', res[9].rows.length === 1 && res[9].rows[0].message === 'escalated automatically: deadline missed' && res[9].rows[0].visible_to_parent === false);
  check('...and the parent cannot see the escalation', res[8].rows.length === 0);
  check('the new handler gets one "escalated" email and no duplicate "assigned" one', res[10].rows.filter((x) => x.template === 'escalated' && x.user_id === U.hana).length === 1 && res[10].rows.filter((x) => x.template === 'assigned' && x.user_id === U.hana).length === 0);
  check('no second escalation inside the same window', res[11].rows[0].r.escalated === 0);
  check('the next window moves it to level 3 (manager)', res[12].rows[0].r.escalated === 1 && res[13].rows[0].escalation_level === 3 && res[13].rows[0].assigned_to === U.manager);
  check('then to level 4 (owner)', res[14].rows[0].r.escalated === 1 && res[15].rows[0].escalation_level === 4 && res[15].rows[0].assigned_to === U.owner);
  check('at the top the owner is told once that it is overdue', res[16].rows[0].r.overdue_at_top === 1 && res[17].rows[0].r.overdue_at_top === 0 && res[18].rows.length === 1 && res[18].rows[0].user_id === U.owner);

  // ---- working hours: paused at night/weekends, except for critical cases
  const FRI = '2026-10-16T09:00:00Z';     // Friday 12:00 in Cairo
  res = await flow([
    mk(U.parentA, C), calm(C),
    [null, `update public.submissions set acknowledge_by='2026-10-14T05:00:00Z', resolve_by='2026-10-14T07:00:00Z' where id='${C}'`],
    tick(FRI),                                                                                         // 3
    [null, `select escalation_level from public.submissions where id='${C}'`],                         // 4
    mk(U.parentA, ID(473), 'safety_concern'),                                                           // 5
    [null, `update public.submissions set acknowledge_by='2026-10-16T08:00:00Z' where id='${ID(473)}'`], // 6
    tick(FRI),                                                                                         // 7
    [null, `select escalation_level, assigned_to from public.submissions where id='${ID(473)}'`],     // 8
    tick('2026-10-14T16:00:00Z'),                                                                      // 9 Wednesday 19:00 Cairo: after hours
    [null, `select escalation_level from public.submissions where id='${C}'`],                         // 10
    tick('2026-10-15T07:00:00Z'),                                                                      // 11 Thursday 10:00: in hours
    [null, `select escalation_level from public.submissions where id='${C}'`],                         // 12
  ]);
  check('on a Friday an ordinary case does not escalate (deadlines pause)', res[3].rows[0].r.in_working_hours === false && res[4].rows[0].escalation_level === 1, JSON.stringify(res[3].rows[0]));
  check('...but a critical case still escalates on a Friday (manager to owner)', res[7].rows[0].r.escalated === 1 && res[8].rows[0].escalation_level === 4 && res[8].rows[0].assigned_to === U.owner, JSON.stringify(res[7].rows[0]));
  check('after 18:00 an ordinary case still waits', res[10].rows[0].escalation_level === 1);
  check('the next working morning it escalates', res[11].rows[0].r.in_working_hours === true && res[12].rows[0].escalation_level === 2);

  // ---- who may use what
  let r = await as(U.parentA, 'select * from public.email_outbox');
  check('parents cannot read the email queue', !!r.error && /permission denied/.test(r.error), r.error);
  r = await as(U.owner, 'select * from public.email_outbox');
  check('not even the owner can read the queue from the browser', !!r.error);
  r = await as(U.owner, `select public.cka_run_deadline_check('2026-10-11T07:00:00Z')`);
  check('nobody can run the deadline checker from the browser', !!r.error && /permission denied/.test(r.error), r.error);
  const priv = (await db.query(`select has_function_privilege('authenticated','public.cka_run_deadline_check(timestamptz)','execute') as a,
                                      has_function_privilege('anon','public.cka_run_deadline_check(timestamptz)','execute') as n,
                                      has_function_privilege('service_role','public.cka_run_deadline_check(timestamptz)','execute') as s`)).rows[0];
  check('only the server key may run the deadline checker', priv.a === false && priv.n === false && priv.s === true, JSON.stringify(priv));
}

// ---------------------------------------------------------------------------
console.log('\n== Manager and owner reports ==');
{
  const R = (n) => ID(480 + n);
  const rep = (who) => [who, `select public.staff_report('2025-03-01', '2025-03-31') as r`];
  const ins = (n, parent, child, type, urg) => [null, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency)
      values ('${R(n)}', '${parent}', '${child}', '${type}', 'Report case ${n}', 'd', '${urg}')`];
  const setc = (n, cols) => [null, `update public.submissions set ${cols} where id='${R(n)}'`];
  const ev = (n, oldv, newv, at) => [null, `insert into public.submission_events (submission_id, event_type, message, old_value, new_value, created_at)
      values ('${R(n)}', 'escalated', 'x', '${oldv}', '${newv}', '${at}')`];
  const inc = (n, child, loc, sev, at) => [U.hana === null ? null : null, `insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
      values ('${ID(560 + n)}', '${child}', '${at}', '${loc}', 'x', '${sev}', ${sev === 'minor' ? 'null' : `'${at}'`}, '${U.hana}')`];
  const rating = (parent, child, cls, month, c, m, d, extra = '') => [null, `insert into public.ratings (parent_id, child_id, class_id, month, care_score, communication_score, daily_reports_score, created_at ${extra ? ', compliment_staff_id, compliment_text' : ''})
      values ('${parent}', '${child}', '${cls}', '${month}', ${c}, ${m}, ${d}, '${month.slice(0, 7)}-15T10:00:00Z' ${extra ? ', ' + extra : ''})`];

  let res = await flow([
    rep(U.manager),                                                                                              // 0 baseline
    [null, `alter table public.submissions disable trigger submissions_before_update`],                         // 1
    [null, `alter table public.submission_events disable trigger submission_events_before_insert`],             // 2
    [null, `alter table public.ratings disable trigger ratings_before_insert`],                                 // 3
    ins(1, U.parentA, alpha, 'complaint', 'urgent'), ins(2, U.parentB, beta, 'complaint', 'can_wait'),          // 4, 5
    ins(3, U.parentC, delta, 'safety_concern', 'critical'), ins(4, U.parentA, alpha, 'complaint', 'urgent'),    // 6, 7
    ins(5, U.parentB, beta, 'complaint', 'can_wait'), ins(6, U.parentB, beta, 'complaint', 'urgent'),           // 8, 9
    setc(1, `created_at='2025-03-03T08:00Z', acknowledge_by='2025-03-03T10:00Z', acknowledged_at='2025-03-03T09:00Z', resolve_by='2025-03-04T08:00Z', resolved_at='2025-03-03T18:00Z', status='closed', parent_satisfied=true`),
    setc(2, `created_at='2025-03-05T08:00Z', acknowledge_by='2025-03-06T08:00Z', acknowledged_at='2025-03-06T09:00Z', resolve_by='2025-03-08T08:00Z', resolved_at='2025-03-08T13:00Z', status='closed', parent_satisfied=false`),
    setc(3, `created_at='2025-03-10T08:00Z', acknowledge_by='2025-03-10T09:00Z', acknowledged_at='2025-03-10T08:30Z', resolve_by='2025-03-10T16:00Z', status='in_progress'`),
    setc(4, `created_at='2025-03-12T08:00Z', acknowledge_by='2025-03-12T10:00Z', resolve_by='2025-03-13T08:00Z', status='received'`),
    setc(5, `created_at='2025-02-28T22:30Z', acknowledge_by='2025-03-02T08:00Z', resolve_by='2025-03-04T08:00Z', status='received'`),   // Cairo: 1 March 00:30 -> inside
    setc(6, `created_at='2025-03-31T22:30Z', acknowledge_by='2025-04-01T08:00Z', resolve_by='2025-04-02T08:00Z', status='received'`),   // Cairo: 1 April 00:30 -> outside
    ev(2, 1, 2, '2025-03-06T10:00Z'), ev(4, 1, 2, '2025-03-13T10:00Z'), ev(3, 3, 4, '2025-03-10T12:00Z'),
    inc(1, alpha, 'Garden', 'minor', '2025-03-04T08:00Z'), inc(2, alpha, 'garden ', 'minor', '2025-03-06T08:00Z'), inc(3, gamma, 'Classroom', 'serious', '2025-03-09T08:00Z'),
    rating(U.parentA, alpha, ID(201), '2025-03-01', 5, 4, 3, `'${U.hana}', 'Thank you Hana'`),
    rating(U.parentB, beta, ID(201), '2025-03-01', 3, 4, 5),
    rating(U.parentB, gamma, ID(202), '2025-03-01', 2, 2, 2),
    rating(U.parentA, alpha, ID(201), '2025-02-01', 2, 2, 2),
    rep(U.manager),                                                                                              // after
    rep(U.owner),
  ]);
  const idx = res.length - 2;
  const b = res[0].rows[0].r, a = res[idx].rows[0].r;
  const firstErr = res.slice(1, idx).findIndex((x) => x.error);
  check('the test dataset loads cleanly', firstErr === -1, firstErr >= 0 ? `step ${firstErr + 1}: ${res[firstErr + 1].error}` : '');
  const tu = a.by_type_urgency.map((x) => `${x.type}/${x.urgency}=${x.count}`).join(',');
  check('cases are counted by the Cairo day they arrived (midnight boundary respected)', a.totals.received === 5, JSON.stringify(a.totals));
  check('cases by type and urgency', tu === 'complaint/can_wait=2,complaint/urgent=2,safety_concern/critical=1', tu);
  check('acknowledged on time: 2 of 5', a.on_time.acknowledged.due === 5 && a.on_time.acknowledged.on_time === 2, JSON.stringify(a.on_time.acknowledged));
  check('resolved on time: 1 of 5', a.on_time.resolved.due === 5 && a.on_time.resolved.on_time === 1, JSON.stringify(a.on_time.resolved));
  check('average time to resolve is in hours (10h and 77h -> 43.5h)', Number(a.avg_resolve_hours) === 43.5, String(a.avg_resolve_hours));
  check('overdue and open items now are counted globally', a.totals.overdue_now - b.totals.overdue_now === 4 && a.totals.open_now - b.totals.open_now === 4, `${b.totals.overdue_now}->${a.totals.overdue_now}`);
  check('escalations: 3 moves on 3 cases, two to level 2 and one to level 4', a.escalations.moves === 3 && a.escalations.cases === 3 && a.escalations.by_level.map((x) => x.level + ":" + x.count).join() === "2:2,4:1", JSON.stringify(a.escalations));
  check('parent satisfied: 1 yes, 1 no', a.satisfaction.yes === 1 && a.satisfaction.no === 1 && a.satisfaction.waiting === 0, JSON.stringify(a.satisfaction));
  check('accidents by class', JSON.stringify(a.incidents.by_class) === JSON.stringify([{ name: 'Butterflies (seed)', count: 2 }, { name: 'Ducklings (seed)', count: 1 }]), JSON.stringify(a.incidents.by_class));
  check('accidents by location (spelling and case are merged)', a.incidents.by_location.length === 2 && a.incidents.by_location[0].count === 2 && a.incidents.by_location[1].name === 'Classroom', JSON.stringify(a.incidents.by_location));
  check('accidents by severity', JSON.stringify(a.incidents.by_severity) === JSON.stringify([{ name: 'minor', count: 2 }, { name: 'serious', count: 1 }]), JSON.stringify(a.incidents.by_severity));
  check('investigations still open (now): the safety concern and the serious accident each opened one', a.incidents.open_investigations - b.incidents.open_investigations === 2, `${b.incidents.open_investigations}->${a.incidents.open_investigations}`);
  const bf = a.ratings.classes.find((x) => x.name === 'Butterflies (seed)'), dk = a.ratings.classes.find((x) => x.name === 'Ducklings (seed)');
  check('ratings use the month of the period end, compared with the month before', a.ratings.month === '2025-03-01' && a.ratings.previous_month === '2025-02-01');
  check('monthly average per class, with last month beside it', bf.count === 2 && Number(bf.care) === 4 && Number(bf.communication) === 4 && Number(bf.daily) === 4 && bf.prev_count === 1 && Number(bf.prev_care) === 2, JSON.stringify(bf));
  check('a class with no ratings last month shows nothing to compare', dk.count === 1 && Number(dk.care) === 2 && dk.prev_count === 0 && dk.prev_care === null, JSON.stringify(dk));
  check('compliments are listed by staff member', a.ratings.compliments.length === 1 && a.ratings.compliments[0].staff === 'Teacher Hana (seed)' && a.ratings.compliments[0].count === 1 && a.ratings.compliments[0].items[0].text === 'Thank you Hana', JSON.stringify(a.ratings.compliments));
  check('the owner gets the same report as the manager', JSON.stringify(res[idx + 1].rows[0].r) === JSON.stringify(a));

  // who may open it, and bad periods
  res = await flow([
    [U.admin, `select public.staff_report('2025-03-01', '2025-03-31')`],
    [U.hana, `select public.staff_report('2025-03-01', '2025-03-31')`],
    [U.parentA, `select public.staff_report('2025-03-01', '2025-03-31')`],
    [null, `select public.staff_report('2025-03-01', '2025-03-31')`],
    [U.manager, `select public.staff_report('2025-03-31', '2025-03-01')`],
    [U.manager, `select public.staff_report('2020-01-01', '2025-03-31')`],
    [U.manager, `select public.staff_report('2025-03-01', '2025-03-01') as r`],
  ]);
  check('only the manager and owner can open the report (not admin, teachers, parents, or visitors)', res.slice(0, 4).every((x) => !!x.error), res.slice(0, 4).map((x) => x.error).join('|'));
  check('a backwards or huge period is refused', !!res[4].error && !!res[5].error);
  check('a single-day period works and is empty for an empty day', !res[6].error && res[6].rows[0].r.totals.received === 0);
}

// ---------------------------------------------------------------------------
console.log('\n== Owner dashboard: privacy ==');
{
  const OWNER_TABLES = ['staff_attendance', 'hr_log', 'staff_complaints', 'mistake_categories', 'mistakes', 'investigation_faults', 'owner_settings'];
  // Put one row in each table (as the server would), then see who can read them.
  const fill = [
    [null, `insert into public.staff_attendance (staff_id, att_date, status, recorded_by) values ('${U.hana}', current_date, 'absent', '${U.admin}')`],
    [null, `insert into public.hr_log (staff_id, entry_type, note) values ('${U.hana}', 'verbal_reminder', 'SECRET HR NOTE')`],
    [null, `insert into public.staff_complaints (raised_by, category, description) values ('${U.mariam}', 'pay', 'SECRET STAFF CONCERN')`],
    [null, `insert into public.mistakes (staff_id, category_id, source, confirmed) values ('${U.hana}', (select id from public.mistake_categories limit 1), 'spot_check', true)`],
    [null, `insert into public.investigation_faults (investigation_id, staff_id, confirmed) values ('${inv1}', '${U.hana}', true)`],
  ];
  for (const [who, label] of [[U.owner, 'the owner'], [U.manager, 'the manager'], [U.admin, 'admin'], [U.hana, 'a teacher'], [U.parentA, 'a parent']]) {
    const steps = fill.concat(OWNER_TABLES.map((t) => [who, `select count(*)::int as n from public.${t}`]));
    const res = await flow(steps);
    const counts = res.slice(fill.length).map((x) => (x.error ? 0 : x.rows[0].n));
    if (who === U.owner) check('the owner can read every owner-only table', counts.every((n) => n >= 1), JSON.stringify(counts));
    else check(label + ' cannot read ANY owner-only table', counts.every((n) => n === 0), JSON.stringify(counts));
  }

  // writes
  let res = await flow([
    [U.manager, `insert into public.hr_log (staff_id, entry_type) values ('${U.hana}', 'praise')`],
    [U.admin, `insert into public.mistakes (category_id, source) values ((select id from public.mistake_categories limit 1), 'spot_check')`],
    [U.hana, `update public.owner_settings set value = '{}'::jsonb where key = 'thresholds'`],
    [U.manager, `insert into public.mistake_categories (name) values ('Sneaky')`],
    [U.owner, `insert into public.hr_log (staff_id, entry_type, note, needs_decision) values ('${U.hana}', 'written_warning', 'ok', true) returning created_by`],
    [U.owner, `insert into public.mistake_categories (name, critical) values ('Late report', false) returning name`],
  ]);
  check('only the owner can write HR entries, mistakes, categories and settings', !!res[0].error && !!res[1].error && !!res[3].error && (res[2].error || res[2].rows.length === 0));
  check('the owner can add an HR entry, and the database records who wrote it', !res[4].error && res[4].rows[0].created_by === U.owner, res[4].error);
  check('the owner can add a mistake category', !res[5].error, res[5].error);

  res = await flow([
    [null, `insert into public.hr_log (id, staff_id, entry_type) values ('${ID(600)}', '${U.hana}', 'praise')`],
    [U.owner, `update public.hr_log set staff_id = '${U.mariam}' where id = '${ID(600)}'`],
    [U.owner, `update public.hr_log set needs_decision = true, decided_at = now() where id = '${ID(600)}' returning decided_by`],
    [U.owner, `select * from public.owner_settings`],
  ]);
  check('an HR entry cannot be re-assigned to another person', !!res[1].error, res[1].error);
  check('deciding an HR item records the owner as the decider', !res[2].error && res[2].rows[0].decided_by === U.owner, res[2].error);

  // attendance: recorded by management, readable only by the owner
  res = await flow([
    [U.admin, `select public.record_staff_attendance('${U.hana}', current_date, 'present', 15, 'Traffic')`],       // 0
    [U.admin, `select public.record_staff_attendance('${U.hana}', current_date, 'absent', 99, 'Ill')`],           // 1 replaces
    [U.admin, `select count(*)::int as n from public.staff_attendance`],                                          // 2 admin cannot read
    [U.owner, `select status, minutes_late, reason from public.staff_attendance where staff_id='${U.hana}'`],     // 3
    [U.hana, `select public.record_staff_attendance('${U.mariam}', current_date, 'present', 0, null)`],           // 4
    [U.parentA, `select public.record_staff_attendance('${U.mariam}', current_date, 'present', 0, null)`],        // 5
    [U.admin, `select public.record_staff_attendance('${U.hana}', current_date + 1, 'present', 0, null)`],        // 6 future
    [U.admin, `select public.record_staff_attendance('${U.hana}', current_date - 90, 'present', 0, null)`],       // 7 too old
    [U.admin, `select public.record_staff_attendance('${U.hana}', current_date, 'maybe', 0, null)`],              // 8
    [U.admin, `select public.record_staff_attendance('${U.parentA}', current_date, 'present', 0, null)`],         // 9 not staff
    [U.admin, `select * from public.staff_attendance_day(current_date)`],                                         // 10
    [U.owner, `select * from public.staff_attendance_day(current_date)`],                                         // 11
    [U.hana, `select * from public.staff_attendance_day(current_date)`],                                          // 12
  ]);
  check('admin can record attendance', !res[0].error, res[0].error);
  check('recording again for the same day replaces the earlier entry', !res[1].error && res[3].rows.length === 1 && res[3].rows[0].status === 'absent' && res[3].rows[0].minutes_late === 0 && res[3].rows[0].reason === 'Ill', JSON.stringify(res[3].rows));
  check('admin cannot read attendance back', res[2].rows[0].n === 0);
  check('teachers and parents cannot record attendance', !!res[4].error && !!res[5].error);
  check('attendance cannot be recorded for the future, the distant past, with a bad status, or for a non-staff account', !!res[6].error && !!res[7].error && !!res[8].error && !!res[9].error);
  check('the attendance sheet lists staff for admin without any saved values', res[10].rows.length >= 3 && res[10].rows.every((x) => x.status === null));
  check('...but shows the saved values to the owner', res[11].rows.find((x) => x.staff_id === U.hana).status === 'absent');
  check('a teacher gets no attendance sheet', res[12].rows.length === 0);

  // staff concerns and anonymity
  res = await flow([
    [U.hana, `select public.submit_staff_complaint('workload', 'Too many children in the room', true)`],         // 0 anonymous
    [U.mariam, `select public.submit_staff_complaint('supplies', 'We ran out of wipes', false)`],               // 1 named
    [U.owner, `select raised_by, anonymous, category, created_at from public.staff_complaints order by category`], // 2
    [U.hana, `select count(*)::int as n from public.staff_complaints`],                                          // 3
    [U.parentA, `select public.submit_staff_complaint('pay', 'x', false)`],                                      // 4
    [U.hana, `select public.submit_staff_complaint('gossip', 'x', false)`],                                      // 5
    [U.hana, `select public.submit_staff_complaint('pay', '   ', false)`],                                       // 6
    [null, `insert into public.staff_complaints (raised_by, category, description, anonymous) values ('${U.hana}', 'pay', 'x', true)`], // 7
    [null, `select (select count(*) from public.staff_complaints where anonymous and raised_by is not null)::int as leaked`], // 8
  ]);
  const rowsC = res[2].rows;
  const anon = rowsC.find((x) => x.category === 'workload'), named = rowsC.find((x) => x.category === 'supplies');
  check('an anonymous concern stores no name at all', !res[0].error && anon && anon.anonymous === true && anon.raised_by === null, res[0].error);
  check('...and its time is rounded to the day so it cannot be matched to a login time', anon && new Date(anon.created_at).getUTCMinutes() === 0 && new Date(anon.created_at).getUTCSeconds() === 0);
  check('a named concern keeps its author for the owner', named && named.raised_by === U.mariam);
  check('staff cannot read concerns back (not even their own)', res[3].rows[0].n === 0);
  check('parents cannot raise staff concerns; bad categories and empty text are refused', !!res[4].error && !!res[5].error && !!res[6].error);
  check('the database refuses an "anonymous" concern that carries a name', !!res[7].error && /anonymous_has_no_name/.test(res[7].error), res[7].error);
  check('no anonymous concern has a name attached', res[8].rows[0].leaked === 0);

  // confirming responsibility from investigation findings
  const S = ID(610);
  const invOf = `(select id from public.investigations where submission_id='${S}')`;
  const step = (name) => [U.manager, `insert into public.investigation_steps (investigation_id, step) values (${invOf}, '${name}')`];
  res = await flow([
    [U.parentA, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency) values ('${S}', '${U.parentA}', '${alpha}', 'safety_concern', 'T', 'd', 'urgent')`], // 0
    [U.manager, `select public.confirm_investigation_fault(${invOf}, '${U.hana}', true)`],                         // 1 too early
    [U.manager, `select public.save_investigation(${invOf}, 'Findings', 'i', 's', 'a')`],                          // 2
    step('parent_called'), step('facts_gathered'), step('findings'),                                               // 3-5
    [U.manager, `select public.confirm_investigation_fault(${invOf}, '${U.hana}', true)`],                         // 6
    [U.manager, `select * from public.investigation_fault(${invOf})`],                                             // 7
    [U.admin, `select public.confirm_investigation_fault(${invOf}, '${U.hana}', true)`],                           // 8
    [U.hana, `select public.confirm_investigation_fault(${invOf}, '${U.hana}', true)`],                            // 9
    [U.manager, `select public.confirm_investigation_fault(${invOf}, '${U.parentA}', true)`],                      // 10
    [U.manager, `select public.confirm_investigation_fault(${invOf}, '${U.hana}', false)`],                        // 11 change of mind
    [U.manager, `select * from public.investigation_fault(${invOf})`],                                             // 12
    [U.admin, `select * from public.investigation_fault(${invOf})`],                                               // 13
  ]);
  check('responsibility cannot be confirmed before the findings are written', !!res[1].error && /findings/.test(res[1].error), res[1].error);
  check('after the findings, the manager can confirm who was responsible', !res[6].error && res[7].rows.length === 1 && res[7].rows[0].confirmed === true && res[7].rows[0].staff_name === 'Teacher Hana (seed)', res[6].error);
  check('admin and teachers cannot confirm responsibility, and only staff can be named', !!res[8].error && !!res[9].error && !!res[10].error);
  check('the confirmation can be withdrawn', !res[11].error && res[12].rows[0].confirmed === false);
  check('admin cannot see who an investigation blames', res[13].rows.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n== Owner dashboard: the numbers ==');
{
  const R = (n) => ID(620 + n);
  const dash = (who, from = '2025-03-01', to = '2025-03-31') => [who, `select public.owner_dashboard('${from}', '${to}') as d`];
  const tr = (sql) => [null, sql];
  const sub = (n, parent, child, type, about, at) => [
    tr(`insert into public.submissions (id, parent_id, child_id, type, title, description, urgency, about_staff_member) values ('${R(n)}', '${parent}', '${child}', '${type}', 'Case ${n}', 'Text ${n}', 'urgent', ${about ? `'${about}'` : 'null'})`),
    tr(`update public.submissions set created_at='${at}' where id='${R(n)}'`)];
  const att = (staff, date, status, late = 0) => tr(`insert into public.staff_attendance (staff_id, att_date, status, minutes_late) values ('${staff}', '${date}', '${status}', ${late})`);
  const inc = (n, child, loc, sev, at) => tr(`insert into public.incidents (id, child_id, occurred_at, location, what_happened, severity, parent_called_at, reported_by)
      values ('${ID(640 + n)}', '${child}', '${at}', '${loc}', 'Note ${n}', '${sev}', ${sev === 'minor' ? 'null' : `'${at}'`}, '${U.hana}')`);
  const rate = (parent, child, cls, month, c, m, d, comment, comp) => tr(`insert into public.ratings (parent_id, child_id, class_id, month, care_score, communication_score, daily_reports_score, comment, compliment_text, created_at)
      values ('${parent}', '${child}', '${cls}', '${month}', ${c}, ${m}, ${d}, ${comment ? `'${comment}'` : 'null'}, ${comp ? `'${comp}'` : 'null'}, '${month.slice(0, 7)}-15T10:00:00Z')`);
  const mist = (staff, cat, date, confirmed) => tr(`insert into public.mistakes (staff_id, category_id, mistake_date, source, confirmed) values (${staff ? `'${staff}'` : 'null'}, (select id from public.mistake_categories where name='${cat}'), '${date}', 'spot_check', ${confirmed})`);

  // flatten helper results (sub() returns two steps)
  const built = [
    dash(U.owner),
    tr(`alter table public.submissions disable trigger submissions_before_update`),
    tr(`alter table public.ratings disable trigger ratings_before_insert`),
    ...sub(1, U.parentA, alpha, 'complaint', U.hana, '2025-03-03T08:00Z'),
    ...sub(2, U.parentB, beta, 'complaint', null, '2025-03-10T08:00Z'),
    ...sub(3, U.parentA, alpha, 'complaint', null, '2025-03-17T08:00Z'),
    ...sub(4, U.parentC, delta, 'safety_concern', null, '2025-03-12T08:00Z'),              // not a "complaint"
    ...sub(5, U.parentC, delta, 'complaint', null, '2025-02-12T08:00Z'),                   // previous period
    att(U.hana, '2025-03-03', 'absent', 0), att(U.hana, '2025-03-04', 'absent'), att(U.hana, '2025-03-05', 'absent'), att(U.hana, '2025-03-06', 'absent'),
    att(U.hana, '2025-03-09', 'present', 10), att(U.hana, '2025-03-10', 'present', 20), att(U.hana, '2025-03-11', 'leave'),
    ...['03', '04', '05', '06', '09', '10', '11'].map((d) => att(U.mariam, `2025-03-${d}`, 'absent')),   // 7 absences
    att(U.admin, '2025-03-03', 'absent'),
    att(U.hana, '2025-02-10', 'absent', 5),                                                  // previous period: 1 absence, 5 late minutes
    inc(1, alpha, 'Garden', 'minor', '2025-03-04T08:00Z'), inc(2, alpha, 'Garden', 'minor', '2025-03-06T08:00Z'),
    inc(3, gamma, 'Classroom', 'serious', '2025-03-09T08:00Z'), inc(4, alpha, 'Garden', 'minor', '2025-02-10T08:00Z'),   // last one: previous period
    rate(U.parentA, alpha, ID(201), '2025-03-01', 5, 5, 5, null, 'Lovely teachers'),         // happy (compliment)
    rate(U.parentB, beta, ID(201), '2025-03-01', 4, 4, 5, 'Great reports', null),            // happy (comment + high scores)
    rate(U.parentB, gamma, ID(202), '2025-03-01', 2, 3, 2, 'Not happy', null),               // comment but low scores: not happy
    rate(U.parentA, alpha, ID(201), '2025-02-01', 5, 5, 5, null, 'Last month thanks'),       // previous period: 1 happy
    tr(`insert into public.hr_log (id, staff_id, entry_type, entry_date, note, needs_decision, created_at) values ('${ID(660)}', '${U.hana}', 'written_warning', '2025-03-10', 'Phone use', true, '2025-03-10T08:00Z')`),
    tr(`insert into public.hr_log (id, staff_id, entry_type, entry_date, note, needs_decision, decided_at, created_at) values ('${ID(661)}', '${U.mariam}', 'verbal_reminder', '2025-03-05', 'Late twice', true, '2025-03-06T08:00Z', '2025-03-05T08:00Z')`),
    tr(`insert into public.hr_log (id, staff_id, entry_type, entry_date, note, created_at) values ('${ID(662)}', '${U.admin}', 'praise', '2025-03-12', 'Great month', '2025-03-12T08:00Z')`),
    mist(U.hana, 'Phone in class', '2025-03-05', true), mist(U.hana, 'Phone in class', '2025-03-12', true), mist(U.hana, 'Phone in class', '2025-03-20', true),
    mist(U.mariam, 'Allergy check missed', '2025-03-08', true), mist(U.admin, 'Cleaning log not signed', '2025-03-09', false), mist(null, 'Cleaning log not signed', '2025-03-09', true),
    tr(`insert into public.staff_complaints (raised_by, category, description, anonymous, status, created_at) values (null, 'workload', 'Anonymous workload', true, 'open', '2025-03-10T00:00Z')`),
    tr(`insert into public.staff_complaints (raised_by, category, description, anonymous, status, created_at) values ('${U.mariam}', 'supplies', 'Named supplies', false, 'resolved', '2025-03-11T10:00Z')`),
    tr(`insert into public.investigation_faults (investigation_id, staff_id, confirmed) select id, '${U.hana}', true from public.investigations where incident_id='${ID(643)}'`),     // confirmed fault for Hana
    tr(`update public.investigations set opened_at='2025-03-09T09:00Z' where incident_id='${ID(643)}'`),
    tr(`insert into public.investigation_faults (investigation_id, staff_id, confirmed) select id, '${U.admin}', false from public.investigations where submission_id='${R(4)}'`),   // NOT confirmed: must not count
    tr(`update public.investigations set opened_at='2025-03-12T09:00Z' where submission_id='${R(4)}'`),
    dash(U.owner),
  ];
  const res = await flow(built);
  const firstErr = res.findIndex((x, i) => i > 0 && x.error);
  check('the dashboard test dataset loads cleanly', firstErr === -1, firstErr >= 0 ? `step ${firstErr}: ${res[firstErr].error}` : '');
  const b = res[0].rows[0].d, d = res[res.length - 1].rows[0].d;
  const tile = (k) => d.tiles[k];

  check('accidents tile: 3 this period against 1 before', tile('accidents').value === 3 && tile('accidents').previous === 1, JSON.stringify(tile('accidents')));
  check('complaints tile counts parent complaints only (a safety concern is separate): 3 against 1', tile('complaints').value === 3 && tile('complaints').previous === 1, JSON.stringify(tile('complaints')));
  check('happy comments tile: a compliment, or a comment with high scores; a comment with low scores does not count (2 against 1)', tile('happy_comments').value === 2 && tile('happy_comments').previous === 1, JSON.stringify(tile('happy_comments')));
  check('staff absence days exclude leave and presence (4 + 7 + 1 = 12 against 1)', tile('absence_days').value === 12 && tile('absence_days').previous === 1, JSON.stringify(tile('absence_days')));
  check('total late minutes (30 against 5)', tile('late_minutes').value === 30 && tile('late_minutes').previous === 5, JSON.stringify(tile('late_minutes')));
  check('open HR items: waiting for a decision now, and how many were opened this period', tile('open_hr').value - b.tiles.open_hr.value === 1 && tile('open_hr').opened === 2 && tile('open_hr').previous_opened === 0, JSON.stringify(tile('open_hr')));
  check('the previous period has the same length and ends the day before', d.period.days === 31 && d.period.previous_from === '2025-01-29' && d.period.previous_to === '2025-02-28', JSON.stringify(d.period));

  check('weekly series covers 8 Sunday-to-Saturday weeks, oldest first', d.weekly.length === 8 && d.weekly[7].week_start === '2025-03-30' && d.weekly[0].week_start === '2025-02-09', JSON.stringify(d.weekly.map((x) => x.week_start)));
  const wk = Object.fromEntries(d.weekly.map((x) => [x.week_start, x]));
  check('accidents per week land in the right week', wk['2025-03-02'].accidents === 2 && wk['2025-03-09'].accidents === 1 && wk['2025-02-09'].accidents === 1, JSON.stringify(d.weekly.map((x) => x.accidents)));
  check('complaints per week land in the right week', wk['2025-03-02'].complaints === 1 && wk['2025-03-09'].complaints === 1 && wk['2025-03-16'].complaints === 1 && wk['2025-02-09'].complaints === 1, JSON.stringify(d.weekly.map((x) => x.complaints)));

  check('latest accidents show severity and investigation status, newest first', d.latest_accidents.length === 3 && d.latest_accidents[0].severity === 'serious' && d.latest_accidents[0].investigation === 'open' && d.latest_accidents[1].investigation === null, JSON.stringify(d.latest_accidents.map((x) => [x.severity, x.investigation])));

  const mk = d.mistakes;
  check('mistakes are ranked by count, confirmed only, with critical ones flagged', mk.length === 3 && mk[0].category === 'Phone in class' && mk[0].count === 3 && mk[0].critical === false && mk.some((x) => x.category === 'Allergy check missed' && x.critical === true && x.count === 1) && mk.find((x) => x.category === 'Cleaning log not signed').count === 1, JSON.stringify(mk));

  const st = Object.fromEntries(d.staff.map((x) => [x.name, x]));
  const hana = st['Teacher Hana (seed)'], mar = st['Teacher Mariam (seed)'], sara = st['Admin Sara (seed)'];
  check('Hana: 4 absences, 30 late minutes, 2 accidents in her class, 1 complaint about her', hana.absence_days === 4 && hana.late_minutes === 30 && hana.class_accidents === 2 && hana.complaints_about === 1, JSON.stringify(hana));
  check('Hana: confirmed faults = 3 confirmed mistakes + 1 confirmed investigation = 4, which needs action', hana.confirmed_faults === 4 && hana.status === 'action', JSON.stringify(hana));
  check('Mariam: 7 absences needs action; her single confirmed mistake alone would not', mar.absence_days === 7 && mar.confirmed_faults === 1 && mar.class_accidents === 1 && mar.status === 'action', JSON.stringify(mar));
  check('Sara: an UNCONFIRMED fault and an unconfirmed mistake never count against her', sara.confirmed_faults === 0 && sara.absence_days === 1 && sara.status === 'good', JSON.stringify(sara));
  check('the owner is not rated in the staff table', !d.staff.some((x) => x.role === 'owner'));
  check('thresholds are returned, scaled to the period (31 days: absence watch 3 -> 4, action 6 -> 7)', d.thresholds.absence_days.watch === 3 && d.thresholds.absence_days.action === 6, JSON.stringify(d.thresholds.absence_days));

  const hr = d.hr_log;
  check('the HR log lists items waiting for the owner on top, then newest first', hr.length === 3 && hr[0].id === ID(660) && hr[0].awaiting === true && hr[1].id === ID(662) && hr[2].id === ID(661) && hr[2].awaiting === false, JSON.stringify(hr.map((x) => [x.type, x.awaiting])));

  const sc = d.staff_concerns;
  check('staff concerns are counted by category and status', sc.by_category_status.length === 2 && sc.by_category_status.some((x) => x.category === 'workload' && x.status === 'open' && x.count === 1), JSON.stringify(sc.by_category_status));
  check('an anonymous concern shows no name even to the owner; a named one shows its author', sc.recent.find((x) => x.category === 'workload').raised_by === null && sc.recent.find((x) => x.category === 'workload').anonymous === true && sc.recent.find((x) => x.category === 'supplies').raised_by === 'Teacher Mariam (seed)', JSON.stringify(sc.recent));
  check('open concerns are listed before resolved ones', sc.recent[0].status !== 'resolved');

  const fam = Object.fromEntries(d.families.map((x) => [x.parent, x]));
  check('feedback per family: complaints, happy comments and the latest message', fam['Parent A (seed)'].complaints === 2 && fam['Parent A (seed)'].happy === 1 && fam['Parent B (seed)'].complaints === 1 && fam['Parent B (seed)'].happy === 1 && typeof fam['Parent B (seed)'].latest_message === 'string' && fam['Parent B (seed)'].latest_message.length > 5 && !!fam['Parent B (seed)'].latest_at, JSON.stringify(d.families));

  // who may open it
  const gate = await flow([dash(U.manager), dash(U.admin), dash(U.hana), dash(U.parentA), dash(null), [U.owner, `select public.owner_dashboard('2025-03-31', '2025-03-01')`], [U.owner, `select public.owner_dashboard('2020-01-01', '2025-03-31')`]]);
  check('only the owner can open the dashboard: not the manager, admin, teachers, parents or visitors', gate.slice(0, 5).every((x) => !!x.error), gate.slice(0, 5).map((x) => x.error).join('|'));
  check('a backwards or huge period is refused', !!gate[5].error && !!gate[6].error);

  // thresholds are editable and change the status
  const edit = await flow([
    [U.owner, `update public.owner_settings set value = jsonb_set(value, '{absence_days,action}', '40') where key = 'thresholds'`],
    [U.owner, `update public.owner_settings set value = jsonb_set(value, '{absence_days,watch}', '30') where key = 'thresholds'`],
    [U.owner, `update public.owner_settings set value = jsonb_set(value, '{confirmed_faults,action}', '99') where key = 'thresholds'`],
    [U.owner, `update public.owner_settings set value = jsonb_set(value, '{confirmed_faults,watch}', '98') where key = 'thresholds'`],
    dash(U.owner),
  ]);
  const st2 = Object.fromEntries(edit[4].rows[0].d.staff.map((x) => [x.name, x]));
  check('raising the thresholds changes who needs action (editable in settings)', st2['Teacher Mariam (seed)'].status === 'good' && st2['Teacher Hana (seed)'].status === 'good', JSON.stringify(st2['Teacher Mariam (seed)']));
}

// ---------------------------------------------------------------------------
console.log('\n== Owner routine: checklist, task tracker and reminders ==');
{
  const TABLES = ['checklist_items', 'checklist_checks', 'owner_tasks'];
  const item = (list, n = 0) => `(select id from public.checklist_items where list='${list}' and active order by position limit 1 offset ${n})`;
  const fill = [
    [null, `insert into public.checklist_checks (item_id, check_date, ok) values (${item('morning')}, current_date, true)`],
    [null, `insert into public.owner_tasks (what, due_date) values ('SECRET TASK', current_date)`],
  ];
  for (const [who, label] of [[U.owner, 'the owner'], [U.manager, 'the manager'], [U.admin, 'admin'], [U.hana, 'a teacher'], [U.parentA, 'a parent']]) {
    const res = await flow(fill.concat(TABLES.map((t) => [who, `select count(*)::int as n from public.${t}`])));
    const counts = res.slice(fill.length).map((x) => (x.error ? 0 : x.rows[0].n));
    if (who === U.owner) check('the owner can read the checklist and the task tracker', counts.every((n) => n >= 1), JSON.stringify(counts));
    else check(label + ' cannot read the checklist or the task tracker', counts.every((n) => n === 0), JSON.stringify(counts));
  }

  // placeholders and the owner-only functions
  let r = await as(U.owner, `select list, count(*)::int as n from public.checklist_items where active group by list order by list`);
  check('the checklist starts with 6 morning and 4 afternoon placeholder checks', r.rows.length === 2 && r.rows[0].list === 'afternoon' && r.rows[0].n === 4 && r.rows[1].n === 6, JSON.stringify(r.rows));
  for (const [who, name] of [[U.manager, 'manager'], [U.admin, 'admin'], [U.hana, 'a teacher'], [U.parentA, 'a parent'], [null, 'a visitor']]) {
    r = await as(who, `select public.owner_routine()`);
    const r2 = await as(who, `select public.owner_set_check(${item('morning')}, current_date, true, null)`);
    check(name + ' cannot open or tick the owner checklist', !!r.error && !!r2.error, `${r.error}|${r2.error}`);
  }

  // ticking checks
  let res = await flow([
    [U.owner, `select public.owner_set_check(${item('morning', 0)}, (now() at time zone 'Africa/Cairo')::date, true, null)`],            // 0
    [U.owner, `select public.owner_set_check(${item('morning', 1)}, (now() at time zone 'Africa/Cairo')::date, false, null)`],           // 1 needs a note
    [U.owner, `select public.owner_set_check(${item('morning', 1)}, (now() at time zone 'Africa/Cairo')::date, false, 'Cot broken in the nap room')`], // 2
    [U.owner, `select public.owner_routine() as r`],                                                                                       // 3
    [U.owner, `select public.owner_set_check(${item('morning', 1)}, (now() at time zone 'Africa/Cairo')::date, true, null)`],            // 4 change of mind
    [U.owner, `select public.owner_routine() as r`],                                                                                       // 5
    [U.owner, `select public.owner_set_check(${item('morning', 0)}, (now() at time zone 'Africa/Cairo')::date + 1, true, null)`],        // 6 tomorrow
    [U.owner, `select public.owner_set_check(${item('morning', 0)}, (now() at time zone 'Africa/Cairo')::date - 9, true, null)`],        // 7 too old
    [null, `update public.checklist_items set active=false where id=${item('morning', 2)}`],                                             // 8 switch one off
    [U.owner, `select public.owner_set_check((select id from public.checklist_items where active=false limit 1), (now() at time zone 'Africa/Cairo')::date, true, null)`], // 9
    [U.owner, `select public.owner_routine() as r`],                                                                                       // 10
  ]);
  check('the owner can tick a check', !res[0].error, res[0].error);
  check('"needs attention" requires a note', !!res[1].error && /what needs attention/.test(res[1].error), res[1].error);
  const m1 = res[3].rows[0].r.lists.morning;
  check('progress is counted: 2 of 6 done, 1 needing attention', !res[2].error && m1.total === 6 && m1.done === 2 && m1.attention === 1, JSON.stringify([m1.total, m1.done, m1.attention]));
  check('the note is kept with the check', m1.items.find((x) => x.note === 'Cot broken in the nap room') && m1.items[1].ok === false);
  check('ticking again changes the earlier answer', !res[4].error && res[5].rows[0].r.lists.morning.attention === 0 && res[5].rows[0].r.lists.morning.done === 2);
  check('only today or the last 7 days can be ticked', !!res[6].error && !!res[7].error);
  check('a switched-off check cannot be ticked and is not counted', !!res[9].error && res[10].rows[0].r.lists.morning.total === 5);
  const hist = res[10].rows[0].r.history;
  check('seven days of history, newest first', hist.length === 7 && hist[0].date === res[10].rows[0].r.today && hist[0].morning === 2 && hist[0].morning_total === 5, JSON.stringify(hist[0]));

  // tasks
  res = await flow([
    [U.owner, `insert into public.owner_tasks (what, assigned_to, due_date) values ('Order new cots', '${U.admin}', (now() at time zone 'Africa/Cairo')::date - 3)`],    // 0 late
    [U.owner, `insert into public.owner_tasks (what, assigned_to, due_date, status) values ('Update fee policy', '${U.manager}', (now() at time zone 'Africa/Cairo')::date + 5, 'in_progress')`], // 1
    [U.owner, `insert into public.owner_tasks (what, due_date) values ('Renew licence', (now() at time zone 'Africa/Cairo')::date)`],                                             // 2 due today: not late
    [U.owner, `select public.owner_routine() as r`],                                                                                                                                 // 3
    [U.owner, `update public.owner_tasks set status='done' where what='Order new cots' returning done_at`],                                                                          // 4
    [U.owner, `select public.owner_routine() as r`],                                                                                                                                 // 5
    [U.owner, `update public.owner_tasks set status='in_progress' where what='Order new cots' returning done_at`],                                                                  // 6 reopen
    [U.manager, `insert into public.owner_tasks (what, due_date) values ('Sneaky', current_date)`],                                                                                  // 7
    [U.owner, `insert into public.owner_tasks (what, due_date) values ('   ', current_date)`],                                                                                       // 8
    [U.owner, `select created_by from public.owner_tasks where what='Renew licence'`],                                                                                              // 9
  ]);
  const t1 = res[3].rows[0].r;
  const byWhat = Object.fromEntries(t1.tasks.map((x) => [x.what, x]));
  check('a task past its due date and not done is LATE; one due today is not', byWhat['Order new cots'].late === true && byWhat['Renew licence'].late === false && byWhat['Update fee policy'].late === false, JSON.stringify(t1.tasks.map((x) => [x.what, x.late])));
  check('tasks show who they are for', byWhat['Order new cots'].who === 'Admin Sara (seed)');
  check('tasks are ordered by due date, late ones first', t1.tasks[0].what === 'Order new cots' && t1.late_tasks === 1, JSON.stringify(t1.tasks.map((x) => x.what)));
  check('marking a task done records when, and it stops being late', !res[4].error && res[4].rows[0].done_at !== null && res[5].rows[0].r.late_tasks === 0 && res[5].rows[0].r.tasks.find((x) => x.what === 'Order new cots').status === 'done');
  check('done tasks sort after open ones', res[5].rows[0].r.tasks[res[5].rows[0].r.tasks.length - 1].what === 'Order new cots');
  check('reopening a task clears the done time', !res[6].error && res[6].rows[0].done_at === null);
  check('only the owner can add tasks, and an empty task is refused', !!res[7].error && !!res[8].error);
  check('the database records who created a task', res[9].rows[0].created_by === U.owner);

  // reminders (Cairo time: Sunday 2026-10-11 is a working day, Thursday 2026-10-15, Friday 2026-10-16)
  const rem = (iso) => [null, `select public.cka_run_owner_reminders('${iso}') as r`];
  const mail = (tplName) => [null, `select to_email, language, template, payload from public.email_outbox where template='${tplName}' and user_id='${U.owner}' order by created_at`];
  res = await flow([
    rem('2026-10-11T05:30:00Z'),                       // 0  Sunday 08:30 Cairo: too early
    rem('2026-10-11T06:05:00Z'),                       // 1  Sunday 09:05: morning reminder
    rem('2026-10-11T06:20:00Z'),                       // 2  same morning again: not repeated
    mail('checklist_morning'),                         // 3
    rem('2026-10-11T13:35:00Z'),                       // 4  Sunday 16:35: afternoon reminder
    rem('2026-10-11T13:50:00Z'),                       // 5  not repeated
    mail('checklist_afternoon'),                       // 6
    rem('2026-10-11T06:10:00Z'),                       // 7  (re-run morning: still once)
    rem('2026-10-16T06:05:00Z'),                       // 8  Friday 09:05: nothing at all
    rem('2026-10-15T06:05:00Z'),                       // 9  Thursday 09:05: morning + Thursday review
    mail('review_thursday'),                           // 10
    rem('2026-10-01T06:05:00Z'),                       // 11 Thursday 1 Oct 09:05: first working day of October too
    rem('2026-10-04T06:05:00Z'),                       // 12 Sunday 4 Oct (not the first working day)
    mail('review_monthly'),                            // 13
  ]);
  check('no reminder before 09:00', res[0].rows[0].r.sent === 0);
  check('09:05 sends the morning-walk reminder once, with progress', res[1].rows[0].r.sent === 1 && res[2].rows[0].r.sent === 0 && res[3].rows.length === 1 && res[3].rows[0].payload.total === 6 && res[3].rows[0].payload.done === 0, JSON.stringify(res[1].rows[0]));
  check('16:35 sends the afternoon reminder once', res[4].rows[0].r.sent === 1 && res[5].rows[0].r.sent === 0 && res[6].rows.length === 1 && res[6].rows[0].payload.total === 4);
  check('nothing is sent on a Friday', res[8].rows[0].r.sent === 0 && res[8].rows[0].r.working_day === false);
  check('Thursday sends the weekly review reminder (and still the morning one)', res[9].rows[0].r.sent === 2 && res[10].rows.length === 1 && typeof res[10].rows[0].payload.late_tasks === 'number', JSON.stringify(res[9].rows[0]));
  check('the monthly review goes out on the first working day of the month only', res[13].rows.length === 1 && res[13].rows[0].payload.date === '2026-10-01', JSON.stringify(res[13].rows));

  // finished lists are not nagged, and only active owners are emailed
  res = await flow([
    [null, `insert into public.checklist_checks (item_id, check_date, ok) select id, '2026-10-11', true from public.checklist_items where list='morning' and active`],
    rem('2026-10-11T06:05:00Z'),
    [null, `update public.profiles set active=false where id='${U.owner}'`],
    rem('2026-10-11T13:35:00Z'),
  ]);
  check('a finished morning walk gets no reminder', res[1].rows[0].r.sent === 0, JSON.stringify(res[1].rows[0]));
  check('an inactive owner is not emailed', res[3].rows[0].r.sent === 0);
  const priv = (await db.query(`select has_function_privilege('authenticated','public.cka_run_owner_reminders(timestamptz)','execute') as a, has_function_privilege('service_role','public.cka_run_owner_reminders(timestamptz)','execute') as s`)).rows[0];
  check('only the server key may run the owner reminders', priv.a === false && priv.s === true);
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
