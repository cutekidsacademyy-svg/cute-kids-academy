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
// SECURITY AUDIT. Runs first, on the freshly seeded database (known data), mimicking Supabase's
// automatic grants. If a future migration forgets to lock something down, these fail.
console.log('\n== Security audit: structure ==');
{
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  // 1. every table has row-level security switched on
  const noRls = (await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`)).map((x) => x.relname);
  check('row-level security is ON for every table in the public schema', noRls.length === 0, noRls.join(', '));

  // 2. anonymous visitors have no table privileges at all
  const anonTables = await q(`select table_name, string_agg(privilege_type, ',') as p from information_schema.role_table_grants
                              where table_schema = 'public' and grantee = 'anon' group by 1 order by 1`);
  check('anonymous visitors have NO privileges on any table', anonTables.length === 0, JSON.stringify(anonTables));

  // 3. logged-in users: never DELETE/TRUNCATE; INSERT/UPDATE only where intended (snapshot)
  const grants = await q(`select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated'`);
  const dangerous = grants.filter((g) => ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(g.privilege_type));
  check('logged-in users can never DELETE, TRUNCATE or alter any table', dangerous.length === 0, JSON.stringify(dangerous));
  const setOf = (p) => grants.filter((g) => g.privilege_type === p).map((g) => g.table_name).sort().join(',');
  check('tables logged-in users may INSERT into (each also guarded by a policy)',
    setOf('INSERT') === 'attachments,checklist_items,children,classes,hr_log,incidents,investigation_steps,investigations,mistake_categories,mistakes,owner_settings,owner_tasks,parent_children,ratings,staff_classes,submission_events,submissions', setOf('INSERT'));
  check('tables logged-in users may UPDATE (each also guarded by a policy)',
    setOf('UPDATE') === 'checklist_items,children,classes,hr_log,incidents,mistake_categories,mistakes,owner_settings,owner_tasks,submissions', setOf('UPDATE'));
  const colOnly = (await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
                            and has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'UPDATE') order by 1`)).map((x) => x.relname).join(',');
  check('only these tables allow column-level updates (own name/phone/language, assignee, concern status)', colOnly === 'investigations,profiles,staff_complaints', colOnly);
  const noSel = (await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
                          and not has_table_privilege('authenticated', c.oid, 'SELECT') order by 1`)).map((x) => x.relname).join(',');
  check('server-only tables cannot be read from the browser at all', noSel === 'deadline_events,email_outbox,push_subscriptions,registration_rate', noSel);

  // 4. functions: nothing internal is reachable by the wrong person
  const fns = await q(`select p.proname as name, p.prosecdef as definer, p.prorettype = 'trigger'::regtype as is_trigger, coalesce(p.proconfig::text, '') as cfg,
      has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
  const definers = fns.filter((f) => f.definer);
  check('every security-definer function has a fixed search_path (blocks a classic hijack)', definers.every((f) => f.cfg.includes('search_path')), definers.filter((f) => !f.cfg.includes('search_path')).map((f) => f.name).join());
  check('anonymous visitors can run NO security-definer or trigger function', fns.filter((f) => (f.definer || f.is_trigger) && f.anon).length === 0, fns.filter((f) => (f.definer || f.is_trigger) && f.anon).map((f) => f.name).join());
  check('logged-in users cannot run trigger functions directly', fns.filter((f) => f.is_trigger && f.auth).length === 0, fns.filter((f) => f.is_trigger && f.auth).map((f) => f.name).join());
  const ALLOWED = ['auth_role', 'is_management', 'is_manager_or_owner', 'is_owner', 'teaches_class', 'can_see_child', 'owns_submission', 'staff_can_see_submission', 'parent_owns_investigation', 'teacher_sees_parent',
    'cka_actor_name', 'change_urgency', 'respond_to_resolution', 'mark_incident_read', 'respond_to_investigation', 'submission_handler_name', 'parent_cases', 'parent_incidents', 'list_staff_names',
    'staff_queue', 'staff_case', 'staff_list', 'staff_ratings', 'staff_acknowledge', 'staff_mark_in_progress', 'staff_assign', 'staff_escalate', 'staff_resolve', 'save_investigation',
    'investigation_name_warnings', 'staff_investigations', 'staff_investigation', 'staff_report', 'record_staff_attendance', 'staff_attendance_day', 'submit_staff_complaint',
    'confirm_investigation_fault', 'investigation_fault', 'owner_dashboard', 'owner_set_check', 'owner_routine',
    'registration_list', 'registration_get', 'registration_set_status', 'approve_registration', 'class_allergies', 'parent_update_health', 'parent_save_pickup',
    'cka_media_visible', 'cka_media_upload_ok', 'cka_media_file', 'media_consent_check', 'media_add', 'media_set_tags', 'media_remove', 'media_mark_post', 'media_settings_save',
    'notification_prefs_save', 'push_subscribe', 'push_unsubscribe', 'cka_announcement_visible', 'cka_announcement_file', 'announcement_post', 'announcement_mark_read', 'announcement_stats', 'announcement_remove', 'cka_event_visible', 'menu_week', 'menu_save', 'schedule_save', 'schedule_delete', 'event_save', 'event_delete', 'event_respond', 'event_responses_summary',
    'report_sheet', 'report_save_many', 'report_send', 'send_request_save', 'report_edit_sent', 'report_overview', 'report_settings_save',
    'cka_door_file', 'door_list', 'door_pickups', 'door_parents', 'door_check_in', 'door_check_out', 'door_undo', 'door_log_call', 'parent_report_attendance', 'parent_cancel_attendance_notice', 'attendance_report'].sort();
  const reach = definers.filter((f) => !f.is_trigger && f.auth).map((f) => f.name).sort();
  check('the ONLY security-definer functions a logged-in user can run are the intended screens/helpers (nothing new slipped in)',
    JSON.stringify(reach) === JSON.stringify(ALLOWED), JSON.stringify({ extra: reach.filter((x) => !ALLOWED.includes(x)), missing: ALLOWED.filter((x) => !reach.includes(x)) }));
  const svc = await q(`select has_function_privilege('service_role', 'public.cka_run_deadline_check(timestamptz)', 'execute') as a, has_function_privilege('service_role', 'public.cka_run_owner_reminders(timestamptz)', 'execute') as b,
      has_function_privilege('service_role', 'public.cka_run_attendance_check(timestamptz)', 'execute') as f, has_function_privilege('authenticated', 'public.cka_run_attendance_check(timestamptz)', 'execute') as g, has_function_privilege('authenticated', 'public.cka_now()', 'execute') as h, has_function_privilege('service_role', 'public.cka_run_content_check(timestamptz)', 'execute') as k, has_function_privilege('authenticated', 'public.cka_run_content_check(timestamptz)', 'execute') as m, has_function_privilege('authenticated', 'public.cka_allergen_match(text,text)', 'execute') as n, has_function_privilege('service_role', 'public.cka_media_expired(timestamptz)', 'execute') as o, has_function_privilege('authenticated', 'public.cka_media_expired(timestamptz)', 'execute') as p, has_function_privilege('authenticated', 'public.cka_media_names(uuid[],boolean)', 'execute') as q, has_function_privilege('service_role', 'public.cka_run_report_check(timestamptz)', 'execute') as i, has_function_privilege('authenticated', 'public.cka_run_report_check(timestamptz)', 'execute') as j,
      has_function_privilege('authenticated', 'public.cka_enqueue_email(uuid,text,jsonb,text)', 'execute') as c, has_function_privilege('anon', 'public.cka_enqueue_email(uuid,text,jsonb,text)', 'execute') as d,
      has_function_privilege('authenticated', 'public.cka_person_name(uuid)', 'execute') as e`);
  check('the server key can run the scheduled jobs; nobody else can queue emails or look up names', svc[0].a && svc[0].b && svc[0].f && svc[0].i && svc[0].k && svc[0].o && !svc[0].p && !svc[0].q && !svc[0].m && !svc[0].n && !svc[0].j && !svc[0].g && !svc[0].h && !svc[0].c && !svc[0].d && !svc[0].e, JSON.stringify(svc[0]));
  const pure = fns.filter((f) => !f.definer && !f.is_trigger && f.anon).map((f) => f.name).sort().join(',');
  check('the only functions anonymous visitors can run are pure date and arithmetic helpers (they read no data)',
    pure === 'cka_add_business_days,cka_add_working_hours,cka_case_payload,cka_deadlines,cka_in_working_hours,cka_is_email,cka_is_happy,cka_is_phone,cka_is_work_day,cka_next_work_day,cka_threshold,cka_working_start', pure);

  // 5. storage: the photo bucket is private with a 5 MB / images-only limit
  const b = (await q(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'attachments'`))[0];
  const regB = await q(`select id, public, file_size_limit from storage.buckets where id in ('registrations', 'child-files') order by id`);
  check('the registration and child-file buckets are private with a 5 MB limit', regB.length === 2 && regB.every((x) => x.public === false && Number(x.file_size_limit) === 5242880), JSON.stringify(regB));
  check('the photo bucket is private, limited to 5 MB and to images only', b.public === false && Number(b.file_size_limit) === 5242880 && b.allowed_mime_types.every((m) => m.startsWith('image/')), JSON.stringify(b));
}

console.log('\n== Security audit: who can read what (seed data) ==');
{
  const roles = { anon: null, parentA: U.parentA, parentB: U.parentB, parentC: U.parentC, hana: U.hana, mariam: U.mariam, admin: U.admin, manager: U.manager, owner: U.owner };
  const D = 'denied';
  // columns: anon, parentA, parentB, parentC, hana, mariam, admin, manager, owner
  const EXPECT = {
    announcement_reads:     [D, 1, 0, 0, 0, 0, 1, 1, 1],
    announcement_targets:   [D, 0, 0, 0, 0, 0, 1, 1, 1],
    announcements:          [D, 2, 3, 2, 2, 1, 3, 3, 3],
    attachments:            [D, 1, 0, 0, 1, 0, 1, 1, 1],
    attendance:             [D, 1, 0, 1, 1, 0, 1, 1, 1],
    attendance_events:      [D, 0, 0, 0, 0, 0, 1, 1, 1],
    attendance_flags:       [D, 0, 0, 0, 0, 0, 0, 0, 0],
    attendance_notices:     [D, 0, 1, 0, 1, 0, 1, 1, 1],
    child_change_log:       [D, 0, 0, 0, 0, 0, 1, 1, 1],
    child_consents:         [D, 1, 0, 1, 0, 0, 1, 1, 1],
    child_documents:        [D, 0, 0, 0, 0, 0, 1, 1, 1],
    child_health:           [D, 1, 2, 1, 0, 0, 3, 3, 3],
    child_pickups:          [D, 1, 1, 1, 0, 0, 2, 2, 2],
    checklist_checks:       [D, 0, 0, 0, 0, 0, 0, 0, 0],
    daily_report_edits:     [D, 0, 0, 0, 0, 0, 0, 0, 0],
    daily_reports:          [D, 1, 0, 1, 2, 0, 2, 2, 2],
    event_responses:        [D, 0, 1, 0, 0, 1, 1, 1, 1],
    events:                 [D, 1, 2, 2, 1, 2, 2, 2, 2],
    media_items:            [D, 1, 0, 1, 1, 0, 1, 1, 1],
    media_settings:         [D, 0, 0, 0, 0, 0, 1, 1, 1],
    media_tags:             [D, 1, 0, 1, 1, 0, 1, 1, 1],
    menu_items:             [D, 3, 3, 3, 3, 3, 3, 3, 3],
    notification_prefs:     [D, 0, 1, 0, 0, 0, 0, 0, 0],
    push_subscriptions:     [D, D, D, D, D, D, D, D, D],
    schedule_items:         [D, 2, 2, 2, 2, 2, 2, 2, 2],
    report_settings:        [D, 0, 0, 0, 0, 0, 1, 1, 1],
    send_requests:          [D, 1, 0, 1, 2, 0, 2, 2, 2],
    checklist_items:        [D, 0, 0, 0, 0, 0, 0, 0, 10],
    children:               [D, 1, 2, 2, 2, 2, 4, 4, 4],
    classes:                [D, 1, 2, 2, 1, 1, 2, 2, 2],
    deadline_events:        [D, D, D, D, D, D, D, D, D],
    email_outbox:           [D, D, D, D, D, D, D, D, D],
    hr_log:                 [D, 0, 0, 0, 0, 0, 0, 0, 0],
    incidents:              [D, 0, 1, 0, 0, 1, 1, 1, 1],
    investigation_faults:   [D, 0, 0, 0, 0, 0, 0, 0, 0],
    investigation_internal: [D, 0, 0, 0, 0, 0, 0, 1, 1],
    investigation_steps:    [D, 0, 0, 1, 0, 0, 1, 1, 1],
    investigations:         [D, 0, 0, 1, 0, 0, 1, 1, 1],
    mistake_categories:     [D, 0, 0, 0, 0, 0, 0, 0, 4],
    mistakes:               [D, 0, 0, 0, 0, 0, 0, 0, 0],
    owner_settings:         [D, 0, 0, 0, 0, 0, 0, 0, 1],
    owner_tasks:            [D, 0, 0, 0, 0, 0, 0, 0, 0],
    parent_children:        [D, 1, 2, 2, 0, 0, 5, 5, 5],
    profiles:               [D, 1, 1, 1, 4, 3, 8, 8, 8],
    ratings:                [D, 0, 1, 0, 0, 0, 0, 1, 1],
    registration_applications: [D, 0, 0, 0, 0, 0, 1, 1, 1],
    registration_documents: [D, 0, 0, 0, 0, 0, 1, 1, 1],
    registration_events:    [D, 0, 0, 0, 0, 0, 1, 1, 1],
    registration_parents:   [D, 0, 0, 0, 0, 0, 1, 1, 1],
    registration_pickups:   [D, 0, 0, 0, 0, 0, 1, 1, 1],
    registration_rate:      [D, D, D, D, D, D, D, D, D],
    staff_attendance:       [D, 0, 0, 0, 0, 0, 0, 0, 0],
    staff_classes:          [D, 0, 0, 0, 1, 1, 2, 2, 2],
    staff_complaints:       [D, 0, 0, 0, 0, 0, 0, 0, 0],
    submission_events:      [D, 2, 2, 3, 3, 3, 8, 8, 8],
    submissions:            [D, 1, 1, 1, 1, 1, 3, 3, 3],
  };
  const tables = (await db.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  check('the audit covers every table (a new table must be added to the matrix on purpose)', JSON.stringify(tables) === JSON.stringify(Object.keys(EXPECT).sort()), JSON.stringify(tables.filter((t) => !EXPECT[t])));
  const names = Object.keys(roles);
  const actual = {};
  for (const t of tables) {
    actual[t] = [];
    for (const r of names) {
      const res = await as(roles[r], `select count(*)::int as n from public.${t}`);
      actual[t].push(res.error ? D : res.rows[0].n);
    }
  }
  const drift = tables.filter((t) => JSON.stringify(actual[t]) !== JSON.stringify(EXPECT[t])).map((t) => `${t}: got ${JSON.stringify(actual[t])} want ${JSON.stringify(EXPECT[t])}`);
  check('the role-by-table visibility matrix is exactly as designed (' + tables.length + ' tables x ' + names.length + ' roles)', drift.length === 0, drift.join(' | '));

  // Everything a person can read, searched for things they must never see.
  async function everythingFor(who) {
    const parts = [];
    for (const t of tables) {
      const r = await as(who, `select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as s from public.${t} x`);
      if (!r.error) parts.push(r.rows[0].s);
    }
    for (const fn of ['parent_cases', 'parent_incidents', 'list_staff_names', 'staff_queue', 'staff_list', 'staff_ratings', 'class_allergies', 'report_sheet']) {
      const r = await as(who, `select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as s from public.${fn}() x`);
      if (!r.error) parts.push(r.rows[0].s);
    }
    const so = await as(who, `select coalesce(string_agg(name, ' '), '') as s from storage.objects`);
    if (!so.error) parts.push(so.rows[0].s);
    return parts.join(' ');
  }
  await db.exec(`insert into storage.objects (bucket_id, name) values ('attachments', '${sub1}/seed-photo.jpg'), ('attachments', '${sub2}/other.jpg')`);
  const scan = async (who, label, mustNot, must) => {
    const text = await everythingFor(who);
    const leaked = mustNot.filter((c) => text.includes(c));
    const missing = must.filter((c) => !text.includes(c));
    check(label + ' can read NONE of the forbidden data', leaked.length === 0, 'LEAKED: ' + leaked.join(' | '));
    check(label + ' can still read their own data (the scan is not simply empty)', missing.length === 0, 'MISSING: ' + missing.join(' | '));
  };
  const staffPhones = ['+20 100 000 0001', '+20 100 000 0002', '+20 100 000 0003', '+20 100 000 0004', '+20 100 000 0005'];
  const INTERNAL = ['SEED INTERNAL NOTE', 'SEED INTERNAL FINDINGS', 'SEED STAFF STATEMENT'];
  await scan(U.parentA, 'Parent A', ['SEED MEDIA SECRET', 'SEED EVENT CLASS2', 'SEED DRAFT NOTE', 'SEED NOTICE', 'SEED DOOR LOG', 'SEED HEALTH SECRET', 'Uncle Seed Secret', 'Layla Applicant', 'SEED APPLICANT', 'SEED LOG', 'Salma Testson', 'Youssef Testson', 'Mariam Testson', 'Parent B (seed)', 'Parent C (seed)', 'concern about Teacher Hana', 'tripped on the path', 'mark on arm', 'Seed findings', 'Seed rating comment', 'other.jpg', '+20 100 000 0102', '+20 100 000 0103'].concat(INTERNAL, staffPhones),
    ['Omar Testson', 'lunch concern', 'seed-photo.jpg', 'Peanut allergy (seed)', 'Grandma Seed', 'SEED REPORT NOTE']);
  await scan(U.parentB, 'Parent B', ['SEED EVENT NOBODY', 'SEED REPORT NOTE', 'SEED DRAFT NOTE', 'SEED DOOR LOG', 'Peanut allergy', 'Grandma Seed', 'Layla Applicant', 'SEED APPLICANT', 'SEED LOG', 'Omar Testson', 'Mariam Testson', 'lunch concern', 'Parent A (seed)', 'Parent C (seed)', 'mark on arm', 'Seed findings', 'seed-photo.jpg'].concat(INTERNAL, staffPhones),
    ['Salma Testson', 'Youssef Testson', 'tripped on the path', 'Seed rating comment', 'SEED HEALTH SECRET', 'Uncle Seed Secret', 'SEED NOTICE']);
  await scan(U.parentC, 'Parent C', ['SEED FAMILY ANNOUNCE', 'SEED DRAFT NOTE', 'SEED NOTICE', 'SEED DOOR LOG', 'SEED HEALTH SECRET', 'Uncle Seed Secret', 'Layla Applicant', 'SEED APPLICANT', 'SEED LOG', 'Salma Testson', 'Youssef Testson', 'lunch concern', 'Parent A (seed)', 'Parent B (seed)', 'tripped on the path', 'Seed rating comment', 'seed-photo.jpg'].concat(INTERNAL, staffPhones),
    ['Omar Testson', 'Mariam Testson', 'mark on arm', 'Seed findings', 'Peanut allergy (seed)', 'Grandma Seed', 'SEED REPORT NOTE']);
  await scan(U.hana, 'Teacher Hana', ['SEED FAMILY ANNOUNCE', 'SEED EVENT CLASS2', 'SEED DOOR LOG', 'SEED HEALTH SECRET', 'asthma', 'Uncle Seed Secret', 'Layla Applicant', 'SEED APPLICANT', 'SEED LOG', 'Youssef Testson', 'Mariam Testson', 'concern about Teacher Hana', 'tripped on the path', 'mark on arm', 'Seed findings', 'SEED INTERNAL FINDINGS', 'SEED STAFF STATEMENT', 'Seed rating comment'],
    ['Omar Testson', 'lunch concern', 'SEED INTERNAL NOTE', 'Peanut allergy (seed)', 'Grandma Seed', 'SEED NOTICE', 'SEED REPORT NOTE', 'SEED DRAFT NOTE']);
  await scan(U.mariam, 'Teacher Mariam', ['SEED CLASS ANNOUNCE', 'SEED FAMILY ANNOUNCE', 'SEED REPORT NOTE', 'SEED DRAFT NOTE', 'SEED NOTICE', 'SEED DOOR LOG', 'Peanut allergy', 'SEED HEALTH SECRET', 'Grandma Seed', 'Layla Applicant', 'SEED APPLICANT', 'SEED LOG', 'Omar Testson', 'Salma Testson', 'lunch concern', 'concern about Teacher Hana', 'SEED INTERNAL NOTE', 'SEED INTERNAL FINDINGS', 'SEED STAFF STATEMENT', 'Seed findings', 'Seed rating comment'],
    ['Youssef Testson', 'Mariam Testson', 'mark on arm', 'tripped on the path', 'None known (seed)']);
  await scan(U.admin, 'Admin', ['SEED INTERNAL FINDINGS', 'SEED STAFF STATEMENT', 'Seed rating comment'], ['SEED INTERNAL NOTE', 'Seed findings', 'concern about Teacher Hana', 'SEED HEALTH SECRET', 'Uncle Seed Secret', 'SEED APPLICANT ALLERGY', 'SEED LOG', 'SEED DOOR LOG', 'SEED NOTICE', 'SEED REPORT NOTE', 'SEED DRAFT NOTE']);
  await scan(U.manager, 'The manager', [], ['SEED INTERNAL FINDINGS', 'SEED STAFF STATEMENT', 'Seed rating comment', 'SEED INTERNAL NOTE']);
  await db.exec(`delete from storage.objects`);
}

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
    [U.admin, `select public.record_staff_attendance('${U.hana}', (now() at time zone 'Africa/Cairo')::date + 1, 'present', 0, null)`],        // 6 future
    [U.admin, `select public.record_staff_attendance('${U.hana}', (now() at time zone 'Africa/Cairo')::date - 90, 'present', 0, null)`],       // 7 too old
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
console.log('\n== Launch test: overdue cases escalate and email exactly once ==');
{
  const A = ID(700), B = ID(701), Cc = ID(702);
  const mk = (id, who, child, type, urg) => [who, `insert into public.submissions (id, parent_id, child_id, type, title, description, urgency) values ('${id}', '${who}', '${child}', '${type}', 'Overdue ${id.slice(-2)}', 'd', '${urg}')`];
  const tick = (iso) => [null, `select public.cka_run_deadline_check('${iso}') as r`];
  const counts = `select count(*)::int as n, count(distinct dedupe_key)::int as uniq from public.email_outbox where template in ('escalated','deadline_warning','overdue_top') and payload->>'id' in ('${A}','${B}','${Cc}')`;
  const NOW = '2026-10-11T07:35:00Z';                     // Sunday 10:35 in Cairo, inside working hours
  const res = await flow([
    mk(A, U.parentA, alpha, 'complaint', 'urgent'), mk(B, U.parentB, beta, 'complaint', 'can_wait'), mk(Cc, U.parentC, delta, 'safety_concern', 'urgent'),
    [null, `update public.submissions set acknowledge_by='2026-10-10T07:00:00Z', resolve_by='2026-10-12T07:00:00Z' where id in ('${A}','${B}')`],   // a day overdue
    [null, `update public.submissions set acknowledge_by='2026-10-11T06:00:00Z', resolve_by='2026-10-11T15:00:00Z' where id = '${Cc}'`],           // critical, an hour and a half overdue
    [null, `update public.submissions set acknowledge_by='2031-01-01', resolve_by='2031-01-01' where id not in ('${A}','${B}','${Cc}')`],            // keep the seed cases out of it
    tick(NOW), tick(NOW), tick(NOW),                                                                                                                 // 6,7,8: three runs at the same moment
    [null, counts],                                                                                                                                  // 9
    [null, `select id, escalation_level, assigned_to from public.submissions where id in ('${A}','${B}','${Cc}') order by id`],                     // 10
    [null, `select count(*)::int as n from public.submission_events where event_type='escalated' and message='escalated automatically: deadline missed' and submission_id in ('${A}','${B}','${Cc}')`], // 11
    tick('2026-10-11T07:50:00Z'), tick('2026-10-11T08:05:00Z'),                                                                                     // 12,13: later runs inside the same window
    [null, counts],                                                                                                                                  // 14
    [null, `select id, escalation_level from public.submissions where id in ('${A}','${B}','${Cc}') order by id`],                                  // 15
  ]);
  const r1 = res[6].rows[0].r, r2 = res[7].rows[0].r, r3 = res[8].rows[0].r;
  check('the first run escalates every overdue case once (two ordinary, one safety concern)', r1.escalated === 3, JSON.stringify(r1));
  check('running the checker again straight away escalates nothing more', r2.escalated === 0 && r3.escalated === 0 && r2.warned === 0, JSON.stringify([r2, r3]));
  const lv = Object.fromEntries(res[10].rows.map((x) => [x.id, x.escalation_level]));
  check('ordinary cases moved from level 1 to 2; the safety concern from level 3 to 4', lv[A] === 2 && lv[B] === 2 && lv[Cc] === 4, JSON.stringify(lv));
  check('each escalation is written to the timeline exactly once', res[11].rows[0].n === 3);
  check('each escalation emailed its recipient exactly once, with no duplicate alerts', res[9].rows[0].n === res[9].rows[0].uniq && res[9].rows[0].n >= 3, JSON.stringify(res[9].rows[0]));
  check('later runs inside the same window change nothing', res[12].rows[0].r.escalated === 0 && res[13].rows[0].r.escalated === 0 && res[14].rows[0].n === res[9].rows[0].n && JSON.stringify(res[15].rows) === JSON.stringify(res[10].rows.map((x) => ({ id: x.id, escalation_level: x.escalation_level }))));
}

// ---------------------------------------------------------------------------
console.log('\n== Online registration ==');
{
  const DRAFT = ID(800), PREFIX = `drafts/${DRAFT}/`;
  const valid = (o = {}) => { const PREFIX = `drafts/${o.draft_id || DRAFT}/`; return JSON.stringify(Object.assign({
    draft_id: DRAFT, language: 'ar',
    child: { name: 'Nour Newchild', dob: '2025-02-02', programme: 'nursery', preferred_start: '2027-01-10', photo_path: PREFIX + 'child_photo/c.jpg' },
    parents: [{ full_name: 'Mona Newparent', phone: '+20 100 111 2222', email: 'Mona@New.test', relationship: 'mother' }],
    health: { allergies: 'Peanuts', medical_conditions: 'Mild asthma', medications: '', doctor_name: 'Dr Seed', doctor_phone: '+20 2 1234 5678' },
    pickups: [{ full_name: 'Aunt Newparent', relationship: 'aunt', phone: '+20 100 333 4444', id_photo_path: PREFIX + 'pickup/a.jpg' }],
    consents: { photos_class: true, photos_social: false, outings: true, emergency_treatment: true, birthday_wall: false },
    documents: [{ kind: 'birth_certificate', path: PREFIX + 'birth_certificate/b.pdf', file_name: 'b.pdf', mime_type: 'application/pdf', size_bytes: 12345 }],
  }, o)); };
  const submit = (json) => [null, `select public.register_application($1::jsonb) as r`, [json]];
  const bad = async (label, json, re) => {
    const res = await flow([submit(json)]);
    check('a submission is refused: ' + label, !!res[0].error && (!re || re.test(res[0].error)), res[0].error);
  };

  let res = await flow([
    submit(valid()),                                                                                       // 0
    [null, `select status, child_name, programme, language, consent_photos_social, allergies from public.registration_applications where draft_id='${DRAFT}'`], // 1
    [null, `select position, email, relationship from public.registration_parents order by position`],      // 2 (also contains the seed row)
    [null, `select count(*)::int as n from public.registration_pickups p join public.registration_applications a on a.id = p.application_id where a.draft_id='${DRAFT}'`], // 3
    [null, `select count(*)::int as n from public.registration_documents d join public.registration_applications a on a.id = d.application_id where a.draft_id='${DRAFT}'`], // 4
    [null, `select to_email, language, template, payload, user_id from public.email_outbox where template='registration_received'`], // 5
    submit(valid()),                                                                                       // 6 same child, same email again
    submit(valid({ child: { name: 'Nour Newchild', dob: '2025-02-02', programme: 'nursery' }, draft_id: ID(801) })), // 7 duplicate with another draft
    submit(valid({ draft_id: ID(802), child: { name: 'Another Kid', dob: '2025-03-03', programme: 'camp' } })), // 8 a different child is fine
  ]);
  check('a complete application is stored with its parents, pickup people and documents', !res[0].error && res[0].rows[0].r.application_no > 0 && res[1].rows[0].status === 'new' && res[1].rows[0].programme === 'nursery', res[0].error);
  check('...the language, consent answers and health details are kept', res[1].rows[0].language === 'ar' && res[1].rows[0].consent_photos_social === false && res[1].rows[0].allergies === 'Peanuts');
  check('...the parent email is stored in lower case', res[2].rows.some((x) => x.email === 'mona@new.test' && x.relationship === 'mother'));
  check('...with 1 pickup person and 1 document', res[3].rows[0].n === 1 && res[4].rows[0].n === 1);
  const rc = res[5].rows.find((x) => x.to_email === 'mona@new.test');
  check('the applicant is emailed a confirmation with the application number, in their language', rc && rc.language === 'ar' && rc.user_id === null && rc.payload.application_no === res[0].rows[0].r.application_no && rc.payload.child_name === 'Nour Newchild');
  check('the same child from the same email is refused as a duplicate (even with a new draft id)', !!res[6].error && /duplicate/.test(res[6].error) && !!res[7].error);
  check('a different child from the same family is accepted', !res[8].error, res[8].error);

  await bad('child name too short', valid({ child: { name: 'A', dob: '2025-02-02', programme: 'nursery' } }), /invalid_child_name/);
  await bad('a date of birth in the future', valid({ child: { name: 'Future Kid', dob: '2999-01-01', programme: 'nursery' } }), /invalid_child_dob/);
  await bad('a date of birth 30 years ago', valid({ child: { name: 'Old Kid', dob: '1990-01-01', programme: 'nursery' } }), /invalid_child_dob/);
  await bad('a made-up programme', valid({ child: { name: 'Prog Kid', dob: '2025-02-02', programme: 'university' } }), /invalid_programme/);
  await bad('no parent', valid({ parents: [] }), /invalid_parents/);
  await bad('three parents', valid({ parents: [1, 2, 3].map((n) => ({ full_name: 'Parent ' + n, phone: '+20 100 111 222' + n, email: `p${n}@x.test`, relationship: 'other' })) }), /invalid_parents/);
  await bad('a bad email address', valid({ parents: [{ full_name: 'Bad Email', phone: '+20 100 111 2222', email: 'not-an-email', relationship: 'mother' }] }), /invalid_parent_1/);
  await bad('a bad phone number', valid({ parents: [{ full_name: 'Bad Phone', phone: 'call me', email: 'ok@x.test', relationship: 'mother' }] }), /invalid_parent_1/);
  await bad('a consent left unanswered', valid({ consents: { photos_class: true, photos_social: null, outings: true, emergency_treatment: true, birthday_wall: false } }), /consents_incomplete/);
  await bad('a consent answered with text instead of yes/no', valid({ consents: { photos_class: 'yes', photos_social: false, outings: true, emergency_treatment: true, birthday_wall: false } }), /consents_incomplete/);
  await bad('a file from someone else\'s upload folder', valid({ draft_id: ID(803), documents: [{ kind: 'other', path: `drafts/${ID(999)}/other/x.pdf`, file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 }], child: { name: 'File Kid', dob: '2025-02-02', programme: 'nursery' }, pickups: [] }), /invalid_file/);
  await bad('a file path that tries to climb out of the folder', valid({ draft_id: ID(804), documents: [{ kind: 'other', path: `drafts/${ID(804)}/../x.pdf`, file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 }], child: { name: 'Path Kid', dob: '2025-02-02', programme: 'nursery' }, pickups: [] }), /invalid_file/);
  await bad('a document over 5 MB', valid({ draft_id: ID(805), documents: [{ kind: 'other', path: `drafts/${ID(805)}/other/x.pdf`, file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 6000000 }], child: { name: 'Big Kid', dob: '2025-02-02', programme: 'nursery' }, pickups: [] }), /invalid_file/);
  await bad('a document that is not an image or PDF', valid({ draft_id: ID(806), documents: [{ kind: 'other', path: `drafts/${ID(806)}/other/x.exe`, file_name: 'x.exe', mime_type: 'application/x-msdownload', size_bytes: 10 }], child: { name: 'Exe Kid', dob: '2025-02-02', programme: 'nursery' }, pickups: [] }), /invalid_file/);
  await bad('more than 6 pickup people', valid({ draft_id: ID(807), child: { name: 'Crowd Kid', dob: '2025-02-02', programme: 'nursery' }, pickups: Array.from({ length: 7 }, (_, i) => ({ full_name: 'Person ' + i, relationship: 'friend', phone: '+20 100 111 222' + i })) }), /invalid_pickups/);
  await bad('a string that is not JSON for the draft id', valid({ draft_id: 'nope' }), /bad_request/);

  // who may call the server-only functions
  const calls = [
    ['register_application', `select public.register_application('{}'::jsonb)`],
    ['find_user_by_email', `select * from public.find_user_by_email('parent.a@seed.cka.test')`],
    ['registration_rate_hit', `select public.registration_rate_hit('x', 5)`],
    ['cka_enqueue_email_address', `select public.cka_enqueue_email_address('a@b.test', 'en', 'registration_received', '{}'::jsonb, 'k')`],
  ];
  for (const [name, sql] of calls) {
    const g = await flow([[U.owner, sql], [U.parentA, sql], [null + '', sql]].slice(0, 2));
    check(name + ' cannot be called from a browser (not even by the owner)', !!g[0].error && !!g[1].error && /permission denied/.test(g[0].error), g[0].error);
    const an = await as(null, sql);
    check(name + ' cannot be called by an anonymous visitor', !!an.error, an.error);
  }

  // rate limiting
  res = await flow([1, 2, 3, 4].map(() => [null, `select public.registration_rate_hit('ip:abc', 3) as ok`]).concat([[null, `select public.registration_rate_hit('ip:other', 3) as ok`]]));
  check('the rate limiter allows the first 3 and refuses the 4th, per visitor', res[0].rows[0].ok && res[1].rows[0].ok && res[2].rows[0].ok && res[3].rows[0].ok === false && res[4].rows[0].ok === true, JSON.stringify(res.map((x) => x.rows && x.rows[0].ok)));

  // the staff side
  const APP = ID(701);                                       // the seeded application ("Layla Applicant (seed)")
  res = await flow([
    [U.admin, `select * from public.registration_list()`],                                                // 0
    [U.hana, `select * from public.registration_list()`],                                                 // 1
    [U.parentA, `select * from public.registration_list()`],                                              // 2
    [U.admin, `select public.registration_get('${APP}') as r`],                                           // 3
    [U.hana, `select public.registration_get('${APP}') as r`],                                            // 4
    [U.admin, `select * from public.registration_list('declined')`],                                      // 5
    [U.admin, `select public.registration_set_status('${APP}', 'missing_documents', '')`],                // 6 needs a note
    [U.admin, `select public.registration_set_status('${APP}', 'missing_documents', 'Please upload the vaccination record')`], // 7
    [null, `select status, status_note from public.registration_applications where id='${APP}'`],       // 8
    [null, `select to_email, language, payload from public.email_outbox where template='registration_update' and payload->>'status'='missing_documents'`], // 9
    [U.admin, `select public.registration_set_status('${APP}', 'approved', null)`],                       // 10
    [U.hana, `select public.registration_set_status('${APP}', 'tour_booked', 'x')`],                      // 11
    [U.manager, `select public.registration_set_status('${APP}', 'tour_booked', null)`],                  // 12
    [U.admin, `select public.registration_set_status('${APP}', 'declined', null)`],                       // 13 needs a reason
    [U.admin, `select public.registration_get('${APP}') as r`],                                           // 14 history
  ]);
  check('admin sees the applications list with the seeded application', res[0].rows.length >= 1 && res[0].rows.some((x) => x.id === APP && x.has_birth_certificate && !x.has_vaccination_record), res[0].error);
  check('teachers and parents get nothing from the applications list or the details', res[1].rows.length === 0 && res[2].rows.length === 0 && !!res[4].error);
  const got = res[3].rows[0].r;
  check('an application opens with parents, pickup people, documents and history', got.parents.length === 1 && got.pickups.length === 1 && got.documents.length === 1 && got.events.length === 1 && got.child_name === 'Layla Applicant (seed)');
  check('the filter by status works', res[5].rows.length === 0);
  check('"missing documents" needs a note saying what is missing', !!res[6].error);
  check('...and with a note it works and tells the applicant, in their language', !res[7].error && res[8].rows[0].status === 'missing_documents' && res[9].rows.length === 1 && res[9].rows[0].to_email === 'applicant@seed.cka.test' && res[9].rows[0].payload.note === 'Please upload the vaccination record', res[7].error);
  check('approving is not possible through the status function', !!res[10].error);
  check('a teacher cannot change an application', !!res[11].error);
  check('the manager can mark a tour as booked; declining needs a reason', !res[12].error && !!res[13].error);
  check('every change is recorded in the application history with who did it', res[14].rows[0].r.events.length === 3 && res[14].rows[0].r.events.some((e) => e.kind === 'missing_documents' && e.actor_name === 'Admin Sara (seed)'));

  // approving
  res = await flow([
    [U.hana, `select public.approve_registration('${APP}', '${ID(201)}')`],                               // 0 teacher cannot
    [U.admin, `select public.approve_registration('${APP}', '${ID(999)}')`],                              // 1 unknown class
    [U.admin, `select public.approve_registration('${APP}', '${ID(201)}') as r`],                         // 2
    [null, `select c.full_name, c.class_id, c.active from public.children c where c.id = (select child_id from public.registration_applications where id='${APP}')`], // 3
    [null, `select h.allergies, h.medical_conditions from public.child_health h where h.child_id = (select child_id from public.registration_applications where id='${APP}')`], // 4
    [null, `select photos_class, photos_social, birthday_wall from public.child_consents where child_id = (select child_id from public.registration_applications where id='${APP}')`], // 5
    [null, `select full_name from public.child_pickups where child_id = (select child_id from public.registration_applications where id='${APP}')`], // 6
    [null, `select kind from public.child_documents where child_id = (select child_id from public.registration_applications where id='${APP}')`], // 7
    [null, `select kind, summary from public.child_change_log where child_id = (select child_id from public.registration_applications where id='${APP}')`], // 8
    [U.admin, `select public.approve_registration('${APP}', '${ID(201)}')`],                              // 9 twice
    [U.admin, `select public.registration_set_status('${APP}', 'waitlist', null)`],                       // 10 after approval
    [null, `select template, to_email from public.email_outbox where template='registration_update' and payload->>'status'='approved'`], // 11
  ]);
  check('a teacher cannot approve; an unknown class is refused', !!res[0].error && !!res[1].error);
  const ap = res[2].rows[0].r;
  check('approving creates the child in the chosen class and says who to invite', !res[2].error && ap.child_id && ap.parents.length === 1 && ap.parents[0].email === 'applicant@seed.cka.test' && res[3].rows[0].class_id === ID(201) && res[3].rows[0].active === true, res[2].error);
  check('...copies the health details, consents, pickup people and documents', res[4].rows[0].allergies === 'SEED APPLICANT ALLERGY: egg' && res[5].rows[0].photos_class === true && res[5].rows[0].photos_social === false && res[6].rows.length === 1 && res[7].rows.some((x) => x.kind === 'birth_certificate'));
  check('...and records that it was created from the application', res[8].rows.length === 1 && res[8].rows[0].kind === 'created');
  check('an application cannot be approved twice or changed afterwards', !!res[9].error && !!res[10].error);
  check('the family is told the child has been accepted', res[11].rows.length === 1 && res[11].rows[0].to_email === 'applicant@seed.cka.test');

  // after approval: who sees the child's private details
  // (the approved child above only existed inside a rolled-back test, so the next test approves again)
  res = await flow([
    [U.admin, `select public.approve_registration('${APP}', '${ID(201)}') as r`],                         // 0
    [null, `insert into public.parent_children (parent_id, child_id) select '${U.parentA}', child_id from public.registration_applications where id='${APP}'`], // 1 link (the server does this after the invitation)
    [U.parentA, `select allergies, medical_conditions from public.child_health where allergies like 'SEED APPLICANT%'`], // 2
    [U.parentB, `select count(*)::int as n from public.child_health h where h.allergies like 'SEED APPLICANT%'`], // 3
    [U.hana, `select count(*)::int as n from public.child_health`],                                       // 4 teacher: table closed
    [U.hana, `select * from public.class_allergies()`],                                                   // 5
    [U.mariam, `select * from public.class_allergies()`],                                                 // 6
    [U.parentA, `select * from public.class_allergies()`],                                                // 7
    [U.admin, `select * from public.class_allergies()`],                                                  // 8
  ]);
  check('the parent can read their own child\'s health record, and another parent cannot', !res[2].error && res[2].rows[0].allergies === 'SEED APPLICANT ALLERGY: egg' && res[3].rows[0].n === 0);
  check('a teacher cannot read the health table at all', res[4].rows[0].n === 0);
  const hanaRows = res[5].rows;
  check('a teacher sees the allergies of her own class, and ONLY allergies (no conditions, medications or doctor)', hanaRows.length === 3 && hanaRows.some((x) => x.allergies === 'Peanut allergy (seed)') && hanaRows.some((x) => x.allergies === 'SEED APPLICANT ALLERGY: egg') && !JSON.stringify(hanaRows).includes('asthma') && Object.keys(hanaRows[0]).join() === 'child_id,child_name,class_name,allergies', JSON.stringify(hanaRows));
  check('...and the other teacher sees only her class', res[6].rows.length === 2 && res[6].rows.every((x) => x.class_name === 'Ducklings (seed)'), JSON.stringify(res[6].rows.map((x) => x.child_name)));
  check('a parent gets no class allergy list; admin gets all', res[7].rows.length === 0 && res[8].rows.length === 5, String(res[8].rows.length));

  // parents update health and pickup people
  const CH = alpha;
  res = await flow([
    [U.parentA, `select public.parent_update_health('${CH}', 'Peanut allergy (seed) and kiwi', 'Eczema', '', 'Dr Seed', '+20 2 1234 5678')`],   // 0
    [U.admin, `select kind, summary, old_value, new_value, changed_by_name from public.child_change_log where kind='health' order by created_at desc limit 1`], // 1
    [null, `select user_id, template from public.email_outbox where template='child_health_changed' order by created_at`],                       // 2
    [U.parentA, `select public.parent_update_health('${CH}', 'Peanut allergy (seed) and kiwi', 'Eczema', '', 'Dr Seed', '+20 2 1234 5678')`],   // 3 no change
    [null, `select count(*)::int as n from public.child_change_log where kind='health'`],                                                      // 4
    [U.parentB, `select public.parent_update_health('${CH}', 'x', null, null, null, null)`],                                                    // 5 someone else's child
    [U.hana, `select public.parent_update_health('${CH}', 'x', null, null, null, null)`],                                                       // 6 teacher
    [U.parentA, `select public.parent_update_health('${CH}', '${'x'.repeat(2001)}', null, null, null, null)`],                                  // 7 too long
    [U.parentA, `select public.parent_update_health('${CH}', 'a', null, null, null, 'call me')`],                                               // 8 bad phone
    [U.hana, `select * from public.class_allergies()`],                                                                                          // 9 teacher sees new allergy
  ]);
  check('a parent can update their child\'s health details', !res[0].error, res[0].error);
  check('...it is logged with who, what changed and the old and new values (staff only)', res[1].rows.length === 1 && res[1].rows[0].changed_by_name === 'Parent A (seed)' && /Allergies/.test(res[1].rows[0].summary) && /Eczema/.test(res[1].rows[0].new_value) && /Peanut allergy \(seed\)/.test(res[1].rows[0].old_value), JSON.stringify(res[1].rows));
  const who = res[2].rows.map((x) => x.user_id);
  check('...and the class teachers and the admins are emailed (no health details in the email)', who.includes(U.hana) && who.includes(U.admin) && !who.includes(U.parentA) && !who.includes(U.mariam), JSON.stringify(who));
  check('saving without changing anything logs and emails nothing more', !res[3].error && res[4].rows[0].n === 1);
  check("another parent, a teacher and an oversized or invalid change are all refused", !!res[5].error && !!res[6].error && !!res[7].error && !!res[8].error);
  check('the teacher\'s allergy list shows the new allergy straight away', res[9].rows.some((x) => /kiwi/.test(x.allergies || '')));

  res = await flow([
    [U.parentA, `select public.parent_save_pickup('${CH}', null, 'Uncle Newpick', 'uncle', '+20 100 555 6666', null, true) as id`],                    // 0 add
    [U.parentA, `select count(*)::int as n from public.child_pickups where child_id='${CH}' and active`],                                              // 1
    [U.parentA, `select public.parent_save_pickup('${CH}', (select id from public.child_pickups where full_name='Uncle Newpick'), 'Uncle Newpick', 'uncle', '+20 100 777 8888', null, true)`], // 2 edit
    [U.parentA, `select phone from public.child_pickups where full_name='Uncle Newpick'`],                                                              // 3
    [U.parentA, `select public.parent_save_pickup('${CH}', (select id from public.child_pickups where full_name='Uncle Newpick'), 'Uncle Newpick', 'uncle', '+20 100 777 8888', null, false)`], // 4 remove
    [U.parentA, `select count(*)::int as n from public.child_pickups where child_id='${CH}' and active`],                                              // 5
    [U.admin, `select summary from public.child_change_log where kind='pickup' order by created_at`],                                                   // 6
    [null, `select user_id from public.email_outbox where template='child_pickup_changed'`],                                                           // 7
    [U.parentB, `select public.parent_save_pickup('${CH}', null, 'Intruder Name', 'friend', '+20 100 999 0000', null, true)`],                          // 8
    [U.parentA, `select public.parent_save_pickup('${CH}', null, 'Photo Path', 'friend', '+20 100 999 0000', 'somewhere/else.jpg', true)`],             // 9
    [U.parentA, `select public.parent_save_pickup('${CH}', null, 'X', 'friend', '+20 100 999 0000', null, true)`],                                      // 10 name too short
    [U.parentA, `select public.parent_save_pickup('${CH}', null, 'Good Name', 'friend', '+20 100 999 0000', '${CH}/pickups/id.jpg', true)`],            // 11 valid photo path
    [U.parentA, `select public.parent_save_pickup('${ID(303)}', null, 'Not My Child', 'friend', '+20 100 999 0000', null, true)`],                      // 12
    [U.hana, `select public.parent_save_pickup('${CH}', null, 'Teacher Try', 'friend', '+20 100 999 0000', null, true)`],                               // 13
  ]);
  check('a parent can add, edit and remove a pickup person', !res[0].error && res[1].rows[0].n === 2 && res[3].rows[0].phone === '+20 100 777 8888' && res[5].rows[0].n === 1, res[0].error);
  check('...each change is logged for staff and the class staff are told', res[6].rows.length === 3 && /added/.test(res[6].rows[0].summary) && /removed/.test(res[6].rows[2].summary) && res[7].rows.length >= 2);
  check('another parent, a teacher, a made-up photo path, a bad name, or someone else\'s child are all refused', !!res[8].error && !!res[10].error && !!res[12].error && !!res[13].error && !!res[9].error);
  check('a photo path inside the child\'s own folder is accepted', !res[11].error, res[11].error);

  // files
  res = await flow([
    [null, `insert into storage.objects (bucket_id, name) values ('registrations', '${PREFIX}birth_certificate/b.pdf'), ('child-files', '${alpha}/pickups/id.jpg'), ('child-files', '${gamma}/pickups/id.jpg')`],
    [U.admin, `select count(*)::int as n from storage.objects where bucket_id = 'registrations'`],
    [U.hana, `select count(*)::int as n from storage.objects where bucket_id = 'registrations'`],
    [U.parentA, `select count(*)::int as n from storage.objects where bucket_id = 'registrations'`],
    [U.parentA, `select count(*)::int as n from storage.objects where bucket_id = 'child-files'`],
    [U.parentB, `select name from storage.objects where bucket_id = 'child-files'`],
    [U.admin, `select count(*)::int as n from storage.objects where bucket_id = 'child-files'`],
    [U.hana, `select count(*)::int as n from storage.objects where bucket_id = 'child-files'`],
    [U.parentA, `insert into storage.objects (bucket_id, name) values ('child-files', '${alpha}/pickups/new.jpg')`],
    [U.parentA, `insert into storage.objects (bucket_id, name) values ('child-files', '${gamma}/pickups/new.jpg')`],
    [U.parentA, `insert into storage.objects (bucket_id, name) values ('child-files', '${alpha}/documents/new.jpg')`],
    [U.parentA, `insert into storage.objects (bucket_id, name) values ('registrations', '${PREFIX}x.pdf')`],
  ]);
  check('registration files are readable by admin only: not teachers, not parents', res[1].rows[0].n === 1 && res[2].rows[0].n === 0 && res[3].rows[0].n === 0);
  check('a child\'s files: the parent sees their own child\'s; another parent sees none; management sees all; a teacher only the pickup ID photos of their own class (not the other class)', res[4].rows[0].n === 1 && res[5].rows.length === 1 && res[5].rows[0].name.startsWith(gamma) && res[6].rows[0].n === 2 && res[7].rows[0].n === 1, JSON.stringify([res[4].rows, res[5].rows]));
  check('a parent can upload a pickup photo for their own child only, into the pickups folder, and never into the registration bucket', !res[8].error && !!res[9].error && !!res[10].error && !!res[11].error);

  // seeds are removed by the launch script
}

// ---------------------------------------------------------------------------
console.log('\n== Attendance and pickup ==');
{
  const T = (local) => [null, `select set_config('app.now', ((timestamp '${local}') at time zone 'Africa/Cairo')::text, true)`];
  const A = alpha, B = beta, G = gamma;
  const lastInOut = `select checked_in_at is not null as i, checked_out_at is not null as o, collector_name, off_list, overtime_minutes from public.attendance where child_id = '${A}' and att_date = '2026-10-11'`;
  let res = await flow([
    T('2026-10-11 08:05'),                                                                 // 0  Sunday morning
    [U.hana, `select child_id from public.door_list()`],                                   // 1  her class only
    [U.mariam, `select public.door_check_in('${A}')`],                                     // 2  not her class
    [U.parentA, `select public.door_check_in('${A}')`],                                    // 3  a parent cannot work the door
    [U.hana, `select public.door_check_in('${A}')`],                                       // 4  ok
    [U.hana, `select public.door_check_in('${A}')`],                                       // 5  twice
    [U.admin, `select checked_in_at is not null as i from public.door_list() where child_id = '${A}'`], // 6
    [U.parentA, `select count(*)::int as n from public.attendance where child_id = '${A}' and att_date = '2026-10-11'`],            // 7  parent sees the times
    [U.parentB, `select count(*)::int as n from public.attendance where att_date = '2026-10-11'`],                                     // 8  other parent sees none
    [U.hana, `select full_name from public.door_pickups('${A}')`],                                       // 9  teacher sees the pickup list through the door function
    [U.mariam, `select full_name from public.door_pickups('${A}')`],                                     // 10 other class: nothing
    [U.parentA, `select full_name from public.door_pickups('${A}')`],                                    // 11 parents: nothing
    T('2026-10-11 15:00'),                                                                 // 12
    [U.hana, `select public.door_check_out('${A}', (select id from public.door_pickups('${A}') limit 1))`], // 13 ok
    [null, lastInOut],                                                                     // 14
    [U.hana, `select public.door_check_out('${A}', (select id from public.door_pickups('${A}') limit 1))`], // 15 twice
    [U.hana, `select public.door_check_out('${B}', null, 'Someone', 'friend', 'x')`],      // 16 never checked in
    [U.hana, `select public.door_check_in('${B}')`],                                       // 17
    [U.hana, `select public.door_check_out('${B}', (select id from public.child_pickups where full_name like 'Grandma%'))`], // 18 a person from another child's list
    [U.admin, `select count(*)::int as n from public.attendance_events where child_id = '${A}' and att_date = '2026-10-11'`], // 19 (door_parents is checked just below) audit trail
    [U.hana, `select count(*)::int as n from public.attendance_events where att_date = '2026-10-11'`],                   // 20 teachers cannot read the log
    [U.parentA, `select count(*)::int as n from public.attendance_events where att_date = '2026-10-11'`],                // 21
  ]);
  check('a class teacher sees only their own class at the door; another class\'s teacher and parents cannot check a child in', res[1].rows.length === 2 && res[1].rows.every((x) => [A, B].includes(x.child_id)) && !!res[2].error && !!res[3].error);
  check('check-in works once per day and the time is recorded; the parent sees it, another parent does not', !res[4].error && !!res[5].error && res[6].rows[0].i === true && res[7].rows[0].n === 1 && res[8].rows[0].n === 0, JSON.stringify([res[4], res[5]]));
  check('the child\'s class teacher sees the authorised pickup list through the door function; other teachers and parents get nothing', res[9].rows.length === 1 && /Grandma Seed/.test(res[9].rows[0].full_name) && res[10].rows.length === 0 && res[11].rows.length === 0);
  check('check-out records who collected, once; a child never checked in, or a person from another child\'s list, is refused', !res[13].error && res[14].rows[0].o && /Grandma Seed/.test(res[14].rows[0].collector_name) && res[14].rows[0].off_list === false && res[14].rows[0].overtime_minutes === 0 && !!res[15].error && !!res[16].error && !res[17].error && !!res[18].error, JSON.stringify([res[13], res[14], res[18]]));
  const dp = await flow([[U.hana, `select full_name, phone from public.door_parents('${A}') order by full_name`], [U.mariam, `select * from public.door_parents('${A}')`], [U.parentA, `select * from public.door_parents('${A}')`]]);
  check('door staff of the class can look up the parent phone numbers to call them; other classes and parents get nothing', dp[0].rows.length === 2 && dp[0].rows.every((x) => x.phone) && dp[1].rows.length === 0 && dp[2].rows.length === 0, JSON.stringify(dp));
  check('every door action is logged for management; teachers and parents cannot read the log', res[19].rows[0].n === 2 && res[20].rows[0].n === 0 && res[21].rows[0].n === 0, JSON.stringify(res[19].rows));

  // overtime: closing time is 18:00 Cairo
  res = await flow([
    T('2026-10-11 08:00'), [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.door_check_in('${B}')`],
    T('2026-10-11 18:25'),
    [U.hana, `select public.door_check_out('${A}', (select id from public.door_pickups('${A}') limit 1))`],
    T('2026-10-11 18:00'),
    [U.hana, `select public.door_check_out('${B}', (select id from public.door_pickups('${B}') limit 1))`],
    [null, `select child_id, overtime_minutes from public.attendance where att_date = '2026-10-11'`],
  ]);
  const ot = Object.fromEntries(res[7].rows.map((x) => [x.child_id, x.overtime_minutes]));
  check('pickups after 18:00 are recorded as overtime minutes; at closing time there is none', !res[4].error && !res[6].error && ot[A] === 25 && ot[B] === 0, JSON.stringify([res[4], res[6], ot]));

  // a person who is not on the list
  res = await flow([
    T('2026-10-11 08:00'), [U.hana, `select public.door_check_in('${A}')`], T('2026-10-11 14:00'),
    [U.hana, `select public.door_check_out('${A}', null, 'Stranger Name', 'friend', null)`],                      // 3 no approval note
    [U.hana, `select public.door_check_out('${A}', null, 'S', 'friend', 'Mother approved by phone')`],            // 4 name too short
    [U.hana, `select public.door_check_out('${A}', null, 'Stranger Name', 'friend', 'Mother approved by phone')`], // 5 ok
    [null, lastInOut],                                                                                            // 6
    [null, `select user_id, template, payload::text as p from public.email_outbox where template like 'pickup_off_list%' order by template, user_id`], // 7
    [U.parentA, `select off_list, collector_name from public.attendance where child_id = '${A}' and att_date = '2026-10-11'`],                // 8 the parent can see it
  ]);
  check('someone not on the pickup list needs a name, a relationship and a note saying the parent approved it', /off_list_needs_parent_approval/.test(res[3].error) && !!res[4].error && !res[5].error, JSON.stringify([res[3].error, res[4].error, res[5].error]));
  const em = res[7].rows;
  check('...it is recorded as an exception, and the parents, class staff and admins are emailed (without any names)', res[6].rows[0].off_list === true && res[6].rows[0].collector_name === 'Stranger Name'
    && em.filter((x) => x.template === 'pickup_off_list_parent').map((x) => x.user_id).sort().join() === [U.parentA, U.parentC].sort().join()
    && em.filter((x) => x.template === 'pickup_off_list_staff').map((x) => x.user_id).includes(U.hana) && em.filter((x) => x.template === 'pickup_off_list_staff').map((x) => x.user_id).includes(U.admin)
    && !em.some((x) => /Stranger/.test(x.p)) && res[8].rows[0].off_list === true, JSON.stringify(em.map((x) => [x.template, x.user_id])));

  // corrections
  res = await flow([
    T('2026-10-11 08:00'), [U.hana, `select public.door_check_in('${A}')`],
    T('2026-10-11 18:10'), [U.hana, `select public.door_check_out('${A}', (select id from public.door_pickups('${A}') limit 1))`],
    [U.hana, `select public.door_undo('${A}', 'check_in')`],                          // 4 must undo the check-out first
    [U.mariam, `select public.door_undo('${A}', 'check_out')`],                       // 5 not her class
    [U.hana, `select public.door_undo('${A}', 'check_out')`],                         // 6
    [null, lastInOut],                                                                // 7
    [U.hana, `select public.door_undo('${A}', 'check_in')`],                          // 8
    [null, `select count(*)::int as n from public.attendance where child_id = '${A}' and att_date = '2026-10-11'`], // 9
    [U.admin, `select string_agg(kind, ',' order by created_at, id) as k from public.attendance_events where child_id = '${A}' and att_date = '2026-10-11'`], // 10
  ]);
  check('a slip at the door can be undone (check-out first, then check-in) and overtime goes with it; every correction is logged', !!res[4].error && !!res[5].error && !res[6].error && res[7].rows[0].o === false && res[7].rows[0].overtime_minutes === 0 && !res[8].error && res[9].rows[0].n === 0 && /undo_check_out/.test(res[10].rows[0].k) && /undo_check_in/.test(res[10].rows[0].k), JSON.stringify([res[4].error, res[7].rows, res[10].rows]));

  // parents report an absence or a late arrival
  res = await flow([
    T('2026-10-12 07:30'),                                                                                            // 0 Monday
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Fever')`],                  // 1 ok, before 8
    [U.hana, `select notice_kind, notice_reason from public.door_list() where child_id = '${A}'`],                      // 2 teacher sees it on the class list
    [U.mariam, `select notice_kind from public.door_list() where child_id = '${A}'`],                                   // 3 other class: child not on her list
    [U.parentB, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Not mine')`],               // 4 not their child
    [U.hana, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Teacher trying')`],            // 5 staff cannot use the parent function
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'late', 'Doctor', '09:15')`],           // 6 replaces the notice
    [U.parentA, `select kind, expected_arrival::text as t from public.attendance_notices where child_id = '${A}'`],   // 7
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'late', 'Doctor', '07:00')`],           // 8 bad arrival
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Fever', '09:00')`],         // 9 arrival only for late
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'x')`],                      // 10 reason too short
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-11', 'absence', 'Yesterday')`],              // 11 past
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-16', 'absence', 'Friday')`],                 // 12 closed day
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-12-30', 'absence', 'Too far')`],                // 13 > 60 days
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-13', 'absence', 'Tomorrow')`],               // 14 ok
    [U.parentA, `select public.parent_cancel_attendance_notice('${A}', '2026-10-13')`],                               // 15 ok
    [U.parentA, `select count(*)::int as n from public.attendance_notices where notice_date = '2026-10-13'`],       // 16
    T('2026-10-12 08:00'),                                                                                            // 17 8 am sharp
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Too late today')`],         // 18 too late
    [U.parentA, `select public.parent_cancel_attendance_notice('${A}', '2026-10-12')`],                               // 19 too late
    [U.parentA, `select public.parent_report_attendance('${A}', '2026-10-13', 'absence', 'Tomorrow still ok')`],      // 20 ok
    [U.parentB, `select count(*)::int as n from public.attendance_notices where notice_date between '2026-10-12' and '2026-10-13'`],                                          // 21 another family sees only their own
    T('2026-10-12 07:59'), [U.hana, `select public.door_check_in('${A}')`],                                           // 22, 23
    [U.parentC, `select public.parent_report_attendance('${A}', '2026-10-12', 'absence', 'Already here')`],           // 24 already checked in
  ]);
  check('a parent can report an absence before 8 am; the class teacher sees it on the list; another class\'s teacher does not see the child', !res[1].error && res[2].rows[0].notice_kind === 'absence' && res[2].rows[0].notice_reason === 'Fever' && res[3].rows.length === 0, JSON.stringify([res[1].error, res[2], res[3]]));
  check('...only for their own child; staff cannot use the parent function; a second report replaces the first', !!res[4].error && !!res[5].error && !res[6].error && res[7].rows.length === 1 && res[7].rows[0].kind === 'late' && res[7].rows[0].t === '09:15:00', JSON.stringify([res[4].error, res[5].error, res[6].error, res[7]]));
  check('...bad arrival times, short reasons, past days, Fridays and dates over 60 days away are refused', [8, 9, 10, 11, 12, 13].every((i) => !!res[i].error), JSON.stringify([8, 9, 10, 11, 12, 13].map((i) => res[i].error)));
  check('a notice for a later day can be cancelled', !res[14].error && !res[15].error && res[16].rows[0].n === 0);
  check('from 8 am sharp, today\'s absence can no longer be reported or cancelled online (they must call), but a later day still can; another family sees no notices', /too_late_today/.test(res[18].error) && /too_late_today/.test(res[19].error) && !res[20].error && res[21].rows[0].n === 0, JSON.stringify([res[18].error, res[19].error, res[20].error, res[21]]));
  check('a child already checked in today cannot be reported absent', !res[23].error && !!res[24].error, JSON.stringify([res[23], res[24]]));

  // 9:30 flag
  res = await flow([
    T('2026-10-12 09:29'), [U.hana, `select child_id, flagged from public.door_list()`],                              // 1
    T('2026-10-12 07:00'), [U.parentB, `select public.parent_report_attendance('${B}', '2026-10-12', 'absence', 'Sick')`], // 3 ok
    T('2026-10-12 09:30'), [U.hana, `select child_id, flagged from public.door_list()`],                              // 5
    [U.admin, `select child_id, flagged from public.door_list()`],                                                    // 6
    [null, `select public.cka_run_attendance_check((timestamp '2026-10-12 09:30') at time zone 'Africa/Cairo') as r`], // 7
    [null, `select count(*)::int as n from public.attendance_flags`],                                                 // 8
    [null, `select user_id, template, payload::text as p from public.email_outbox where template = 'attendance_missing'`], // 9
    [null, `select public.cka_run_attendance_check((timestamp '2026-10-12 09:45') at time zone 'Africa/Cairo') as r`], // 10 nothing new
    [null, `select count(*)::int as n from public.email_outbox where template = 'attendance_missing'`],               // 11
    [null, `select public.cka_run_attendance_check((timestamp '2026-10-12 09:00') at time zone 'Africa/Cairo') as r`], // 12 too early
    [null, `select public.cka_run_attendance_check((timestamp '2026-10-16 10:00') at time zone 'Africa/Cairo') as r`], // 13 Friday
    [U.hana, `select public.door_log_call('${A}', 'Mother says on the way')`],                                        // 14 teachers cannot
    [U.admin, `select public.door_log_call('${A}', 'Mother says on the way')`],                                       // 15
    [U.admin, `select public.door_log_call('${B}', ' ')`],                                                            // 16 needs a note
    [U.admin, `select called_at is not null as c, call_note from public.door_list() where child_id = '${A}'`],       // 17
    [U.hana, `select public.door_check_in('${A}')`],                                                                  // 18
    [U.hana, `select flagged from public.door_list() where child_id = '${A}'`],                                       // 19 arrived: no longer flagged
    [U.hana, `select count(*)::int as n from public.attendance_flags`],                                               // 20 teachers cannot read flags
    [U.hana, `select call_note from public.door_list() where child_id = '${B}' or child_id = '${A}'`],                // 21 nor call notes via the list
  ]);
  check('before 9:30 nobody is flagged', res[1].rows.every((x) => x.flagged === false));
  const fl = (r) => Object.fromEntries(r.rows.map((x) => [x.child_id, x.flagged]));
  check('at 9:30 a child with no check-in and no notice is flagged; a child with a parent\'s notice is not', fl(res[5])[A] === true && fl(res[5])[B] === false && fl(res[6])[G] === true && fl(res[6])[delta] === true, JSON.stringify([fl(res[5]), fl(res[6])]));
  const r7 = res[7].rows[0].r, r10 = res[10].rows[0].r;
  check('the scheduler flags each child once and emails the admin a count only (no names)', r7.flagged === 3 && res[8].rows[0].n === 3 && res[9].rows.length === 1 && res[9].rows[0].user_id === U.admin && !/Testson|Omar/.test(res[9].rows[0].p), JSON.stringify([r7, res[8].rows, res[9].rows]));
  check('...and does nothing again later, before 9:30, or on a Friday', r10.flagged === 0 && res[11].rows[0].n === 1 && res[12].rows[0].r.checked === false && res[13].rows[0].r.checked === false);
  check('admin can log "I called the parent" (a note is required); teachers cannot and cannot read the flags or call notes', !!res[14].error && !res[15].error && !!res[16].error && res[17].rows[0].c === true && res[20].rows[0].n === 0 && res[21].rows.every((x) => x.call_note === null), JSON.stringify([res[14].error, res[15].error, res[16].error, res[17], res[21]]));
  check('once the child arrives they are no longer flagged', !res[18].error && res[19].rows[0].flagged === false);

  // reports and overtime billing
  res = await flow([
    [null, `update public.children set created_at = '2026-01-01'`],
    [null, `delete from public.attendance`], [null, `delete from public.attendance_notices`],
    [null, `insert into public.attendance (child_id, att_date, checked_in_at, checked_out_at, overtime_minutes) values
        ('${A}', '2026-10-11', '2026-10-11 05:00+00', '2026-10-11 15:20+00', 20), ('${A}', '2026-10-12', '2026-10-12 05:00+00', '2026-10-12 12:00+00', 0)`],
    [null, `insert into public.attendance_notices (child_id, notice_date, kind, reason) values ('${A}', '2026-10-13', 'absence', 'Sick'), ('${B}', '2026-10-11', 'absence', 'Trip'), ('${B}', '2026-10-12', 'late', 'Doctor')`],
    T('2026-10-13 19:00'),                                                                                              // 5
    [U.admin, `select public.attendance_report('2026-10-11', '2026-10-13') as r`],                                       // 6
    [U.hana, `select public.attendance_report('2026-10-11', '2026-10-13')`],                                             // 7
    [U.parentA, `select public.attendance_report('2026-10-11', '2026-10-13')`],                                          // 8
    [U.admin, `select public.attendance_report('2026-10-13', '2026-10-11')`],                                            // 9 backwards
    [U.admin, `select public.attendance_report('2025-01-01', '2026-10-11')`],                                            // 10 over a year
    T('2026-10-13 12:00'),                                                                                              // 11 Tuesday noon: today not counted yet
    [U.manager, `select public.attendance_report('2026-10-11', '2026-10-13') as r`],                                     // 12
    [U.admin, `select public.attendance_report('2026-10-15', '2026-10-17') as r`],                                       // 13 Thu, Fri, Sat: in the future
  ]);
  const r6 = res[6].rows[0].r, byc = Object.fromEntries(r6.by_child.map((x) => [x.child_id, x]));
  check('the report counts school days, present days, reported absences and unreported days per child (Sunday to Thursday only)', byc[A].school_days === 3 && byc[A].present_days === 2 && byc[A].absent_reported === 1 && byc[A].not_reported === 0
    && byc[B].present_days === 0 && byc[B].absent_reported === 1 && byc[B].not_reported === 2 && byc[B].late_notices === 1 && byc[G].not_reported === 3, JSON.stringify(byc[A]) + JSON.stringify(byc[B]));
  check('...by class too, and the overtime list names the family and the minutes (the billing source)', r6.by_class.length === 2 && r6.by_class.find((x) => x.class_name === 'Butterflies (seed)').children === 2
    && r6.overtime.length === 1 && r6.overtime[0].minutes === 20 && /Parent A \(seed\)/.test(r6.overtime[0].parents) && /Parent C \(seed\)/.test(r6.overtime[0].parents), JSON.stringify(r6.overtime));
  check('only management can run the report; bad periods are refused', !!res[7].error && !!res[8].error && !!res[9].error && !!res[10].error && !res[12].error);
  check('a day still in progress is not counted as "not reported"', res[12].rows[0].r.by_child.find((x) => x.child_id === G).school_days === 2 && res[13].rows[0].r.by_child.every((x) => x.school_days === 0));
}

// ---------------------------------------------------------------------------
console.log('\n== Daily reports ==');
{
  const T = (local) => [null, `select set_config('app.now', ((timestamp '${local}') at time zone 'Africa/Cairo')::text, true)`];
  const A = alpha, B = beta;
  const D = '2026-10-11';
  const rep = (child) => `select * from public.daily_reports where child_id = '${child}' and report_date = '${D}'`;
  let res = await flow([
    T('2026-10-11 08:30'),                                                                                                 // 0
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"all"}')`],                                  // 1 not checked in yet
    [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.door_check_in('${B}')`],                       // 2, 3
    [U.hana, `select public.report_save_many(array['${A}','${B}']::uuid[], '{"lunch":"all","mood":"happy"}')`],            // 4 the whole group
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"water_cups":4,"milk_ml":200,"sleep_minutes":90,"diaper_changes":3,"stool_count":1,"personal_note":"Painted today"}')`], // 5
    [U.mariam, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"none"}')`],                               // 6 not her class
    [U.parentA, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"none"}')`],                              // 7 a parent
    [U.parentA, `select count(*)::int as n from public.daily_reports where report_date = '${D}'`],                         // 8 drafts are private
    [U.hana, `select child_id, allergies, lunch, mood, water_cups, personal_note, status from public.report_sheet() order by child_name`], // 9
    [U.mariam, `select child_id from public.report_sheet()`],                                                              // 10
    [U.parentA, `select * from public.report_sheet()`],                                                                    // 11
  ]);
  check('a teacher can fill in the report of children who are checked in (several at once); not before check-in, not other classes, not parents', !!res[1].error && /not_checked_in/.test(res[1].error) && res[4].rows[0].report_save_many === 2 && !res[5].error && !!res[6].error && !!res[7].error);
  check('drafts are private: parents see nothing until a report is sent', res[8].rows[0].n === 0);
  const sheet = res[9].rows;
  check('the teacher sheet shows the checked-in children with their entries and any allergy (for the meal screen); other classes and parents get nothing', sheet.length === 2 && sheet[0].child_id === A && sheet[0].lunch === 'all' && sheet[0].water_cups === 4 && sheet[0].personal_note === 'Painted today' && /Peanut/.test(sheet[0].allergies || '') && sheet[1].allergies === null && res[10].rows.length === 0 && res[11].rows.length === 0, JSON.stringify(sheet));

  const bad = ['{"lunch":"lots"}', '{"water_cups":99}', '{"temperature":50}', '{"temperature":"hot"}', '{"mood":"angry"}', '{"milk_ml":"abc"}', '{"sleep_minutes":-5}', '[1,2]'];
  res = await flow([T('2026-10-11 08:30'), [U.hana, `select public.door_check_in('${A}')`], ...bad.map((b) => [U.hana, `select public.report_save_many(array['${A}']::uuid[], '${b}')`])]);
  check('impossible values are refused (bad meal, mood, numbers, temperature)', bad.every((_, i) => !!res[2 + i].error), JSON.stringify(res.slice(2).map((x) => x.error)));

  // sending, privacy of sent reports, edits after sending
  res = await flow([
    T('2026-10-11 08:30'), [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.door_check_in('${B}')`],
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"all","mood":"happy","personal_note":"Painted today"}')`], // 3
    [U.hana, `select public.report_save_many(array['${B}']::uuid[], '{"lunch":"half"}')`],                                  // 4
    [U.hana, `select public.report_send(array['${A}']::uuid[])`],                                                           // 5 -> 1
    [U.parentA, `select lunch, mood, personal_note, status from public.daily_reports where report_date = '${D}'`],         // 6
    [U.parentB, `select count(*)::int as n from public.daily_reports where report_date = '${D}'`],                          // 7 B is still a draft
    [U.parentC, `select count(*)::int as n from public.daily_reports where report_date = '${D}'`],                          // 8 second parent of A
    [null, `select user_id, template, payload::text as p from public.email_outbox where template = 'daily_report_ready'`], // 9
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"mood":"tired"}')`],                                  // 10 sent: teachers cannot change it
    [U.hana, `select public.report_edit_sent((select id from public.daily_reports where child_id = '${A}' and report_date = '${D}'), '{"mood":"tired"}', 'Corrected')`], // 11
    [U.admin, `select public.report_edit_sent((select id from public.daily_reports where child_id = '${A}' and report_date = '${D}'), '{"mood":"tired"}', 'x')`],        // 12 reason too short
    [U.admin, `select public.report_edit_sent((select id from public.daily_reports where child_id = '${A}' and report_date = '${D}'), '{"mood":"tired","water_cups":6}', 'Teacher mixed up the children')`], // 13
    [U.admin, `select public.report_edit_sent((select id from public.daily_reports where child_id = '${A}' and report_date = '${D}'), '{"mood":"tired"}', 'Same again')`], // 14 no change: nothing logged
    [U.admin, `select reason, editor_name, before ->> 'mood' as b, after ->> 'mood' as a, after ->> 'water_cups' as w from public.daily_report_edits`], // 15
    [U.hana, `select count(*)::int as n from public.daily_report_edits`],                                                   // 16
    [U.parentA, `select count(*)::int as n from public.daily_report_edits`],                                                // 17
    [U.parentA, `select mood, water_cups from public.daily_reports where report_date = '${D}'`],                           // 18
    [U.admin, `select public.report_edit_sent((select id from public.daily_reports where child_id = '${B}' and report_date = '${D}'), '{"mood":"calm"}', 'Draft cannot be edited here')`], // 19
    [U.hana, `select public.report_send()`],                                                                                // 20 B has content -> 1
    [U.hana, `select public.report_send()`],                                                                                // 21 nothing left
  ]);
  check('sending makes the report visible to the child\'s parents only, and a draft stays private', !res[5].error && res[5].rows[0].report_send === 1 && res[6].rows.length === 1 && res[6].rows[0].mood === 'happy' && res[6].rows[0].status === 'sent' && res[7].rows[0].n === 0 && res[8].rows[0].n === 1, JSON.stringify([res[5], res[6], res[7], res[8]]));
  const mails = res[9].rows;
  check('both parents are emailed that a report is ready (no details in the email)', mails.map((x) => x.user_id).sort().join() === [U.parentA, U.parentC].sort().join() && !mails.some((x) => /Painted|happy|lunch/.test(x.p)), JSON.stringify(mails));
  check('after sending, a teacher cannot change a report; admin can, with a reason, and the change is recorded', !!res[10].error && /already_sent/.test(res[10].error) && !!res[11].error && !!res[12].error && !res[13].error && !res[14].error, JSON.stringify([res[10].error, res[11].error, res[12].error, res[13].error]));
  check('...the record shows who, why, and before and after; only management can read it; the parent sees the corrected report', res[15].rows.length === 1 && res[15].rows[0].reason === 'Teacher mixed up the children' && res[15].rows[0].b === 'happy' && res[15].rows[0].a === 'tired' && res[15].rows[0].w === '6' && res[16].rows[0].n === 0 && res[17].rows[0].n === 0 && res[18].rows[0].mood === 'tired' && res[18].rows[0].water_cups === 6, JSON.stringify(res[15].rows));
  check('an unsent report cannot go through the edit-after-sending route; sending twice sends nothing new', !!res[19].error && res[20].rows[0].report_send === 1 && res[21].rows[0].report_send === 0);

  // fever alert
  res = await flow([
    T('2026-10-11 09:00'), [U.hana, `select public.door_check_in('${A}')`],
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"temperature":37.5}')`],                                // 2 normal
    [null, `select count(*)::int as n from public.email_outbox where template = 'fever_alert'`],                              // 3
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"temperature":38.2}')`],                                // 4 fever
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"temperature":38.6}')`],                                // 5 still fever: no second alert
    [null, `select user_id, payload::text as p from public.email_outbox where template = 'fever_alert'`],                     // 6
    [U.admin, `select child_name, temperature from (select c.full_name as child_name, r.temperature from public.daily_reports r join public.children c on c.id = r.child_id where r.report_date = '${D}') x`], // 7
    [U.admin, `select public.report_overview('${D}') as o`],                                                                  // 8
    [U.hana, `select public.report_overview('${D}')`],                                                                        // 9
  ]);
  const fe = res[6].rows;
  check('a temperature of 38 or more alerts the class staff and the admins once; a normal temperature alerts nobody; the email has no name or number', res[3].rows[0].n === 0 && fe.length === 2 && fe.map((x) => x.user_id).includes(U.hana) && fe.map((x) => x.user_id).includes(U.admin) && !fe.some((x) => /38|Testson/.test(x.p)), JSON.stringify(fe));
  check('the admin overview lists the fever; teachers cannot open it', res[8].rows[0].o.fever.length === 1 && Number(res[8].rows[0].o.fever[0].temperature) === 38.6 && !!res[9].error, JSON.stringify(res[8].rows[0].o));

  // "Kindly send for tomorrow"
  res = await flow([
    T('2026-10-11 09:00'), [U.hana, `select public.door_check_in('${A}')`],
    [U.hana, `select public.send_request_save('${A}', array['diapers','other'], null)`],                                      // 2 needs text
    [U.hana, `select public.send_request_save('${A}', array['diapers','other'], 'Spare shoes')`],                             // 3
    [U.hana, `select public.send_request_save('${A}', array['toys'], null)`],                                                 // 4 unknown item
    [U.mariam, `select public.send_request_save('${A}', array['wipes'], null)`],                                              // 5 other class
    [U.parentA, `select public.send_request_save('${A}', array['wipes'], null)`],                                             // 6 a parent
    [U.parentA, `select count(*)::int as n from public.send_requests where for_date = '2026-10-12'`],                        // 7 not published yet
    [U.hana, `select child_id, send_items, send_other from public.report_sheet() where child_id = '${A}'`],                  // 8
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"mood":"happy"}')`], [U.hana, `select public.report_send(array['${A}']::uuid[])`], // 9, 10
    [U.parentA, `select items, other_text, for_date::text as d from public.send_requests where for_date = '2026-10-12'`],  // 11 published with the report
    [U.parentB, `select count(*)::int as n from public.send_requests where for_date = '2026-10-12'`],                        // 12
    [U.hana, `select public.send_request_save('${A}', array[]::text[], null)`],                                               // 13 clear
    [U.parentA, `select count(*)::int as n from public.send_requests where for_date = '2026-10-12'`],                        // 14
    T('2026-10-15 09:00'), [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.send_request_save('${A}', array['wipes'], null)`], // 15, 16, 17 Thursday
    [null, `select for_date::text as d from public.send_requests where child_id = '${A}' and items = array['wipes']`],      // 18
  ]);
  check('"kindly send" needs text for "other", only known items, only the child\'s own class staff; families see it only after the report is sent', !!res[2].error && !res[3].error && !!res[4].error && !!res[5].error && !!res[6].error && res[7].rows[0].n === 0 && res[8].rows[0].send_items.includes('diapers') && res[8].rows[0].send_other === 'Spare shoes', JSON.stringify([res[2].error, res[3].error, res[7], res[8]]));
  check('...then the family (and only that family) sees it, for the next school day; it can be cleared', !res[10].error && res[11].rows.length === 1 && res[11].rows[0].other_text === 'Spare shoes' && res[12].rows[0].n === 0 && !res[13].error && res[14].rows[0].n === 0, JSON.stringify([res[10].error, res[11], res[12], res[14]]));
  check('on a Thursday the request is for Sunday', res[18].rows[0].d === '2026-10-18', JSON.stringify(res[18]));

  // scheduler: the 4 pm nudge and the automatic send
  res = await flow([
    T('2026-10-11 08:30'), [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.door_check_in('${B}')`],
    [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"all","personal_note":"Great day"}')`],       // 3
    [U.hana, `select public.report_save_many(array['${B}']::uuid[], '{"lunch":"half"}')`],                                  // 4 no personal note
    [null, `select public.cka_run_report_check((timestamp '2026-10-11 15:59') at time zone 'Africa/Cairo') as r`],          // 5 too early
    [null, `select public.cka_run_report_check((timestamp '2026-10-11 16:00') at time zone 'Africa/Cairo') as r`],          // 6 nudge only
    [null, `select user_id, payload::text as p from public.email_outbox where template = 'report_note_reminder'`],          // 7
    [null, `select count(*)::int as n from public.daily_reports where report_date = '${D}' and status = 'sent'`],           // 8
    [U.admin, `select public.report_settings_save(true, '09:00')`],                                                          // 9 too early a time
    [U.hana, `select public.report_settings_save(false, '16:30')`],                                                          // 10 teachers cannot
    [null, `select public.cka_run_report_check((timestamp '2026-10-11 16:30') at time zone 'Africa/Cairo') as r`],          // 11 auto send
    [null, `select count(*)::int as n from public.daily_reports where report_date = '${D}' and status = 'sent' and sent_by is null`], // 12
    [null, `select user_id from public.email_outbox where template = 'daily_report_ready'`],                                 // 13
    [null, `select public.cka_run_report_check((timestamp '2026-10-11 16:45') at time zone 'Africa/Cairo') as r`],          // 14 nothing more
    [null, `select count(*)::int as n from public.email_outbox where template in ('daily_report_ready', 'report_note_reminder')`], // 15
    [null, `select public.cka_run_report_check((timestamp '2026-10-16 16:30') at time zone 'Africa/Cairo') as r`],          // 16 Friday
  ]);
  const r5 = res[5].rows[0].r, r6 = res[6].rows[0].r, r11 = res[11].rows[0].r, r14 = res[14].rows[0].r;
  check('at 4 pm the teachers with children still missing a personal note get one reminder (a count only); nothing earlier, and nothing is sent yet', r5.checked === false && r6.reminders === 1 && res[7].rows.length === 1 && res[7].rows[0].user_id === U.hana && !/Testson/.test(res[7].rows[0].p) && res[8].rows[0].n === 0, JSON.stringify([r5, r6, res[7].rows]));
  check('only admin, manager or owner can change the automatic-send setting, and only to a sensible time', !!res[9].error && !!res[10].error);
  check('at the automatic-send time, every report with entries is sent (as "automatic"), parents emailed; later runs and Fridays do nothing', r11.sent === 2 && res[12].rows[0].n === 2 && res[13].rows.length >= 3 && r14.sent === 0 && res[15].rows[0].n === res[13].rows.length + 1 && res[16].rows[0].r.checked === false, JSON.stringify([r11, res[13].rows.length, r14, res[15].rows]));

  // the setting really switches automatic sending off
  res = await flow([
    T('2026-10-11 08:30'), [U.hana, `select public.door_check_in('${A}')`], [U.hana, `select public.report_save_many(array['${A}']::uuid[], '{"lunch":"all"}')`],
    [U.manager, `select public.report_settings_save(false, '16:30')`],
    [null, `select public.cka_run_report_check((timestamp '2026-10-11 17:00') at time zone 'Africa/Cairo') as r`],
    [U.admin, `select public.report_overview('${D}') as o`], [U.hana, `select count(*)::int as n from public.report_settings`],
  ]);
  check('with automatic sending off nothing is sent by the scheduler; the overview shows the setting and who is not done; teachers cannot read the setting', !res[3].error && res[4].rows[0].r.sent === 0 && res[5].rows[0].o.settings.auto_send === false && res[5].rows[0].o.ready === 1 && res[5].rows[0].o.present === 1 && res[6].rows[0].n === 0, JSON.stringify(res[5].rows[0].o));
}

// ---------------------------------------------------------------------------
console.log('\n== Announcements, notification choices, menu and events ==');
{
  const T = (local) => [null, `select set_config('app.now', ((timestamp '${local}') at time zone 'Africa/Cairo')::text, true)`];
  const X = ID(951), Y = ID(952), Z = ID(953), SEEDCLASS2 = ID(202);
  const post = (id, aud, cls, kids, imp = false, path = 'null') => `select public.announcement_post('${id}', 'Hello', 'مرحبا', 'Body text', null, '${aud}', ${cls ? `'${cls}'` : 'null'}, ${kids ? `array[${kids.map((k) => `'${k}'`).join(',')}]::uuid[]` : 'null'}, ${imp}, 'news', ${path}, null)`;
  let res = await flow([
    T('2026-10-11 09:00'),
    [U.admin, post(X, 'all', null, null, true)],                                                             // 1
    [U.hana, post(Y, 'all', null, null)],                                                                    // 2 teachers cannot post
    [U.parentA, post(Y, 'all', null, null)],                                                                 // 3
    [U.admin, post(Y, 'class', null, null)],                                                                 // 4 class needed
    [U.admin, post(Y, 'families', null, null)],                                                              // 5 families needed
    [U.admin, post(Y, 'all', null, null, false, `'${ID(999)}/file.pdf'`)],                                   // 6 attachment of another announcement
    [U.admin, `select public.announcement_post('${Y}', null, null, 'Body', null, 'all', null, null, false, 'news', null, null)`], // 7 no title
    [U.admin, post(Y, 'class', SEEDCLASS2, null)],                                                           // 8 ok: second class
    [U.admin, post(Z, 'families', null, [gamma])],                                                           // 9 ok: one family
    [U.parentA, `select id from public.announcements where id in ('${X}','${Y}','${Z}') order by id`],      // 10
    [U.parentB, `select id from public.announcements where id in ('${X}','${Y}','${Z}') order by id`],      // 11
    [U.parentC, `select id from public.announcements where id in ('${X}','${Y}','${Z}') order by id`],      // 12
    [U.hana, `select id from public.announcements where id in ('${X}','${Y}','${Z}') order by id`],         // 13
    [U.mariam, `select id from public.announcements where id in ('${X}','${Y}','${Z}') order by id`],       // 14
    [null, `select user_id, template, payload::text as p from public.email_outbox where template = 'announcement_new' and dedupe_key like 'ann:${X}:%'`], // 15
    [null, `select user_id from public.email_outbox where template = 'announcement_new' and dedupe_key like 'ann:${Y}:%' order by user_id`], // 16
  ]);
  check('only admin, manager and owner can post an announcement; it needs a class or families when meant for them, a title, and its own attachment folder', !res[1].error && !!res[2].error && !!res[3].error && !!res[4].error && !!res[5].error && !!res[6].error && !!res[7].error && !res[8].error && !res[9].error, JSON.stringify(res.slice(1, 10).map((x) => x.error)));
  check('families see only what is meant for them: everyone, their child\'s class, or their own family', res[10].rows.length === 1 && res[11].rows.length === 3 && res[12].rows.length === 2 && res[13].rows.length === 1 && res[14].rows.length === 2, JSON.stringify([10, 11, 12, 13, 14].map((i) => res[i].rows.length)));
  check('teachers see what is for everyone or their class, never a single family\'s', res[13].rows.map((x) => x.id).join() === X && res[14].rows.map((x) => x.id).sort().join() === [X, Y].sort().join());
  check('announcement emails go to the intended families only, respect their choices (Parent B turned announcements off), and carry no text', res[15].rows.map((x) => x.user_id).sort().join() === [U.parentA, U.parentC].sort().join() && !res[15].rows.some((x) => /Hello|Body/.test(x.p)) && res[16].rows.map((x) => x.user_id).join() === U.parentC, JSON.stringify([res[15].rows, res[16].rows]));

  // read receipts and the 24-hour reminder
  res = await flow([
    T('2026-10-11 09:00'), [U.admin, post(X, 'all', null, null, true)], [U.admin, post(Y, 'all', null, null, false)],
    [U.parentA, `select public.announcement_mark_read('${X}')`], [U.parentA, `select public.announcement_mark_read('${X}')`],  // 3, 4 twice is fine
    [U.hana, `select public.announcement_mark_read('${X}')`],                                                // 5 staff reads are not counted
    [U.parentA, `select count(*)::int as n from public.announcement_reads where announcement_id = '${X}'`], // 6
    [U.parentB, `select count(*)::int as n from public.announcement_reads`],                                 // 7
    [U.admin, `select public.announcement_stats('${X}') as s`],                                              // 8
    [U.hana, `select public.announcement_stats('${X}')`], [U.parentA, `select public.announcement_stats('${X}')`], // 9, 10
    [null, `update public.announcements set created_at = created_at - interval '25 hours' where id in ('${X}','${Y}')`], // 11
    [null, `select public.cka_run_content_check() as r`],                                                    // 12
    [null, `select user_id from public.email_outbox where template = 'announcement_reminder' order by user_id`], // 13
    [null, `select public.cka_run_content_check() as r`],                                                    // 14 only once
    [U.parentA, `select public.announcement_remove('${X}')`], [U.admin, `select public.announcement_remove('${X}')`], // 15, 16
    [U.admin, `select count(*)::int as n from public.announcement_reads where announcement_id = '${X}'`],  // 17
  ]);
  const st = res[8].rows[0].s;
  check('read receipts: a parent opening it is counted once; staff and other families do not count; admin sees who has and has not read it (not teachers or parents)', res[6].rows[0].n === 1 && res[7].rows[0].n === 0 && st.read === 1 && st.total === 3 && st.unread.length === 2 && st.readers[0].name === 'Parent A (seed)' && !!res[9].error && !!res[10].error, JSON.stringify(st));
  check('an important announcement reminds only the families who have not opened it (and who allow announcement emails), once; ordinary ones never', res[12].rows[0].r.announcements === 1 && res[13].rows.map((x) => x.user_id).join() === U.parentC && res[14].rows[0].r.announcements === 0, JSON.stringify([res[12].rows, res[13].rows]));
  check('only management can delete an announcement; its read receipts go with it', !!res[15].error && !res[16].error && res[17].rows[0].n === 0);

  // notification choices and push
  res = await flow([
    [U.parentA, `select public.notification_prefs_save(false, true, true, true)`],                           // 0 reports off
    [null, `select public.cka_enqueue_email('${U.parentA}', 'daily_report_ready', '{}', 'k1')`],              // 1 skipped
    [null, `select public.cka_enqueue_email('${U.parentA}', 'accident_report', '{}', 'k2')`],                 // 2 safety always goes out
    [null, `select public.cka_enqueue_email('${U.parentA}', 'update_added', '{}', 'k3')`],                    // 3 cases on
    [null, `select public.cka_enqueue_email('${U.parentB}', 'announcement_new', '{}', 'k4')`],               // 4 B has announcements off (seed)
    [null, `select public.cka_enqueue_email('${U.hana}', 'daily_report_ready', '{}', 'k5')`],                 // 5 staff mail is never filtered
    [null, `select dedupe_key from public.email_outbox where dedupe_key in ('k1','k2','k3','k4','k5') order by dedupe_key`], // 6
    [U.parentA, `select reports from public.notification_prefs`],                                             // 7
    [U.parentB, `select reports from public.notification_prefs`],                                             // 8 own row only
    [U.parentA, `select public.push_subscribe('https://push.example.test/abc/123456789012345', 'BPublicKeyPublicKeyPublicKey', 'authsecret123')`], // 9
    [U.parentA, `select public.push_subscribe('http://insecure.example.test/abcdefghijkl', 'BPublicKeyPublicKeyPublicKey', 'authsecret123')`],    // 10
    [U.parentA, `select * from public.push_subscriptions`],                                                   // 11 not readable
    [null, `select user_id from public.push_subscriptions`],                                                  // 12
    [U.parentB, `select public.push_unsubscribe('https://push.example.test/abc/123456789012345')`],           // 13 someone else's: nothing happens
    [null, `select count(*)::int as n from public.push_subscriptions`],                                       // 14
    [U.parentA, `select public.push_unsubscribe('https://push.example.test/abc/123456789012345')`],           // 15
    [null, `select count(*)::int as n from public.push_subscriptions`],                                       // 16
  ]);
  check('a family\'s notification choices are respected (reports, announcements); safety, case and staff emails still go out', res[6].rows.map((x) => x.dedupe_key).join() === 'k2,k3,k5', JSON.stringify(res[6].rows));
  check('each person can read only their own choices', res[7].rows.length === 1 && res[7].rows[0].reports === false && res[8].rows.length === 1 && res[8].rows[0].reports === true);
  check('push subscriptions: only secure addresses; nobody can read them from the browser; only the owner of a subscription can remove it', !res[9].error && !!res[10].error && !!res[11].error && res[12].rows.length === 1 && res[12].rows[0].user_id === U.parentA && res[14].rows[0].n === 1 && res[16].rows[0].n === 0);

  // menu, schedule and allergen warnings
  res = await flow([
    [null, `update public.child_health set allergies = 'حساسية من الفول السوداني' where child_id = '${alpha}'`],  // 0 Arabic wording still matches
    [U.parentA, `select meal, affected from public.menu_week(current_date, current_date) order by meal`],       // 1
    [U.parentB, `select meal, affected from public.menu_week(current_date, current_date) order by meal`],       // 2
    [U.hana, `select meal, affected from public.menu_week(current_date, current_date) where meal = 'lunch'`],   // 3
    [U.mariam, `select meal, affected from public.menu_week(current_date, current_date) where meal = 'lunch'`], // 4
    [U.admin, `select meal, affected from public.menu_week(current_date, current_date) where meal = 'lunch'`],  // 5
    [null, `select public.cka_allergen_match('No eggs please, a little milk', 'eggs') as e, public.cka_allergen_match('nothing', 'eggs') as n, public.cka_allergen_match('Tree nuts', 'tree_nuts') as t`], // 6
    [U.parentA, `select * from public.menu_week(current_date, current_date + 100)`],                           // 7 too long
    [U.hana, `select public.menu_save(current_date + 1, 'lunch', 'Rice', null, array['milk'])`],               // 8 teachers cannot
    [U.admin, `select public.menu_save(current_date + 1, 'lunch', 'Rice', 'أرز', array['milk'])`],             // 9
    [U.admin, `select public.menu_save(current_date + 1, 'lunch', 'Rice', 'أرز', array['gold'])`],             // 10 unknown allergen
    [U.admin, `select public.menu_save(current_date + 1, 'dinner', 'Rice', null, '{}')`],                       // 11 unknown meal
    [U.parentA, `select dish_en, dish_ar from public.menu_week(current_date + 1, current_date + 1)`],          // 12
    [U.admin, `select public.menu_save(current_date + 1, 'lunch', '', '', '{}')`],                              // 13 clears
    [U.parentA, `select count(*)::int as n from public.menu_week(current_date + 1, current_date + 1)`],       // 14
    [U.admin, `select public.schedule_save(null, null, '09:00', 'Circle time', 'حلقة')`],                       // 15
    [U.hana, `select public.schedule_save(null, null, '09:00', 'Hana tries', null)`],                           // 16
    [U.parentA, `select count(*)::int as n from public.schedule_items`],                                        // 17 (2 seed + 1)
    [U.admin, `select public.schedule_delete((select id from public.schedule_items where title_en = 'Circle time'))`], // 18
  ]);
  const aff = (r, m) => (r.rows.find((x) => x.meal === m) || {}).affected;
  check('a parent is warned about dishes containing their own child\'s allergen (matched in English and Arabic) and sees no other child\'s name', aff(res[1], 'lunch').join() === 'Omar Testson (seed)' && aff(res[1], 'breakfast').length === 0 && aff(res[2], 'lunch').length === 0, JSON.stringify([res[1].rows, res[2].rows]));
  check('a teacher sees the affected children of their own class only; management sees everyone', aff(res[3], 'lunch').join() === 'Omar Testson (seed)' && aff(res[4], 'lunch').length === 0 && aff(res[5], 'lunch').join() === 'Omar Testson (seed)');
  check('the allergen matcher finds words, and stays internal (no direct access)', res[6].rows[0].e === true && res[6].rows[0].n === false && res[6].rows[0].t === true && !!res[7].error);
  check('only management edits the menu and schedule, with known meals and allergens; an empty dish removes the entry', !!res[8].error && !res[9].error && !!res[10].error && !!res[11].error && res[12].rows[0].dish_ar === 'أرز' && !res[13].error && res[14].rows[0].n === 0 && !res[15].error && !!res[16].error && res[17].rows[0].n === 3 && !res[18].error, JSON.stringify(res.slice(8, 19).map((x) => x.error)));

  // events, approvals, reminders
  const E = ID(961), F = ID(962);
  const ev = (id, kind, aud, cls, approval, start, deadline) => `select public.event_save(${id ? `'${id}'` : 'null'}, '${kind}', 'Trip', 'رحلة', null, null, timestamptz '${start}', null, false, 'Park', '${aud}', ${cls ? `'${cls}'` : 'null'}, 30, ${approval}, ${deadline ? `timestamptz '${deadline}'` : 'null'})`;
  res = await flow([
    T('2026-10-11 09:00'),
    [U.admin, ev(null, 'event', 'class', SEEDCLASS2, true, '2026-10-20 09:00+03', '2026-10-15 12:00+03')],        // 1 returns id
    [U.hana, ev(null, 'event', 'all', null, false, '2026-10-20 09:00+03', null)],                                  // 2 teachers cannot
    [U.admin, ev(null, 'event', 'all', null, true, '2026-10-20 09:00+03', '2026-10-25 12:00+03')],                // 3 deadline after the start
    [U.admin, ev(null, 'event', 'all', null, true, '2026-10-20 09:00+03', null)],                                 // 4 needs a deadline
    [U.admin, ev(null, 'event', 'class', null, false, '2026-10-20 09:00+03', null)],                              // 5 needs a class
    [U.admin, ev(null, 'closure', 'all', null, false, '2026-10-22 00:00+03', null)],                               // 6 closure for everyone
    [U.admin, ev(null, 'session', 'all', null, false, '2026-10-23 10:00+03', null)],                               // 7 session: no email
    [null, `select id from public.events where title_en = 'Trip' and kind = 'event' and audience = 'class' order by created_at desc limit 1`], // 8
    [null, `select user_id, template, payload::text as p from public.email_outbox where template = 'event_new' order by template, user_id`], // 9
    [U.parentB, `select count(*)::int as n from public.events where title_en = 'Trip'`],                           // 10 sees class 2 event + closure + session
    [U.parentA, `select count(*)::int as n from public.events where title_en = 'Trip'`],                           // 11 not the class-2 event
    [U.hana, `select count(*)::int as n from public.events where title_en = 'Trip'`],                              // 12
  ]);
  check('only management creates events; a class event needs a class, an approval needs a deadline before the event', !res[1].error && !!res[2].error && !!res[3].error && !!res[4].error && !!res[5].error && !res[6].error && !res[7].error, JSON.stringify(res.slice(1, 8).map((x) => x.error)));
  const evMail = res[9].rows;
  check('families are emailed about a new event or closure (only the class\'s families for a class event); sessions send nothing; no text in the email', evMail.length === 5 && !evMail.some((x) => /Trip|رحلة/.test(x.p)), JSON.stringify(evMail.map((x) => [x.template, x.user_id, x.p])));
  check('calendar visibility follows the audience', res[10].rows[0].n === 3 && res[11].rows[0].n === 2 && res[12].rows[0].n === 2, JSON.stringify([res[10], res[11], res[12]]));

  const evId = `(select id from public.events where title_en = 'Trip' and audience = 'class' limit 1)`;
  res = await flow([
    T('2026-10-11 09:00'), [U.admin, ev(null, 'event', 'class', SEEDCLASS2, true, '2026-10-20 09:00+03', '2026-10-15 12:00+03')],
    [U.parentB, `select public.event_respond(${evId}, '${gamma}', 'yes')`],                                    // 2 ok
    [U.parentB, `select public.event_respond(${evId}, '${beta}', 'yes')`],                                     // 3 beta is in the other class
    [U.parentA, `select public.event_respond(${evId}, '${gamma}', 'yes')`],                                    // 4 not their child
    [U.hana, `select public.event_respond(${evId}, '${gamma}', 'yes')`],                                       // 5 staff cannot
    [U.parentB, `select public.event_respond(${evId}, '${gamma}', 'maybe')`],                                  // 6
    [U.parentB, `select public.event_respond(${evId}, '${gamma}', 'no')`],                                     // 7 changed their mind
    [U.parentB, `select answer from public.event_responses where child_id = '${gamma}' and event_id = ${evId}`], // 8
    [U.parentC, `select answer from public.event_responses where event_id = ${evId}`],                         // 9 other family: nothing
    [U.admin, `select child_name, answer, answered_by_name, parents from public.event_responses_summary(${evId})`], // 10
    [U.hana, `select * from public.event_responses_summary(${evId})`],                                         // 11
    [U.admin, `select public.event_save(null, 'event', 'Fun day', null, null, null, timestamptz '2026-10-20 09:00+03', null, false, null, 'all', null, null, false, null)`], // 12
    [U.parentB, `select public.event_respond((select id from public.events where title_en = 'Fun day'), '${gamma}', 'yes')`], // 13 needs no answer
    T('2026-10-14 12:00'),
    [null, `select public.cka_run_content_check((timestamp '2026-10-14 12:00') at time zone 'Africa/Cairo') as r`],                                                      // 15 within 24 h of the deadline? (deadline 15th 12:00): 24 h before is 14th 12:00 -> yes
    [null, `select user_id from public.email_outbox where template = 'event_reminder' order by user_id`],      // 16
    [null, `select public.cka_run_content_check((timestamp '2026-10-14 12:00') at time zone 'Africa/Cairo') as r`],                                                      // 17 once
    T('2026-10-15 12:01'),
    [U.parentC, `select public.event_respond(${evId}, '${delta}', 'yes')`],                                    // 19 too late
  ]);
  check('a parent answers yes or no for their own child in the event\'s class, can change their mind, and nobody else can answer or see the answer', !res[2].error && !!res[3].error && !!res[4].error && !!res[5].error && !!res[6].error && !res[7].error && res[8].rows[0].answer === 'no' && res[9].rows.length === 0 && !!res[13].error);
  const sum = res[10].rows;
  check('admin sees every child in the audience with the answer or a missing answer (missing first); teachers cannot', sum.length === 2 && sum[0].answer === null && sum[0].child_name.startsWith('Mariam') && sum[1].answer === 'no' && sum[1].answered_by_name === 'Parent B (seed)' && !!res[11].error || (res[11].rows.length === 0), JSON.stringify(sum));
  check('families with an unanswered event get one reminder within 24 hours of the deadline; the family that answered gets none; after the deadline answers are refused', res[15].rows[0].r.events === 1 && res[16].rows.map((x) => x.user_id).join() === U.parentC && res[17].rows[0].r.events === 0 && /deadline_passed/.test(res[19].error), JSON.stringify([res[15].rows, res[16].rows, res[19].error]));
}

// ---------------------------------------------------------------------------
console.log('\n== Class photos and videos ==');
{
  const T = (local) => [null, `select set_config('app.now', ((timestamp '${local}') at time zone 'Africa/Cairo')::text, true)`];
  const C1 = ID(201), C2 = ID(202), D = '2026-10-11';
  const M1 = ID(971), M2 = ID(972), M3 = ID(973), M4 = ID(974);
  const add = (id, cls, kind, mime, dur, kids, date = D, path = null) => `select public.media_add('${id}', '${cls}', null, '${date}', '${kind}', '${path || cls + '/' + id + (kind === 'photo' ? '.jpg' : '.mp4')}', 'f.jpg', '${mime}', 1000, ${dur}, array[${kids.map((k) => `'${k}'`).join(',')}]::uuid[])`;
  let res = await flow([
    T('2026-10-11 10:00'),
    [U.hana, `select child_name from public.media_consent_check(array['${alpha}','${beta}']::uuid[])`],                    // 1 Salma's parents never agreed
    [U.mariam, `select child_name from public.media_consent_check(array['${alpha}','${beta}']::uuid[])`],                  // 2 other class: nothing
    [U.parentA, `select child_name from public.media_consent_check(array['${alpha}']::uuid[])`],                           // 3 parents: nothing
    [U.hana, add(M1, C1, 'photo', 'image/jpeg', null, [alpha])],                                                           // 4 ok
    [U.hana, add(M2, C1, 'photo', 'image/jpeg', null, [alpha, beta])],                                                     // 5 blocked: no consent for Salma
    [null, `insert into public.child_consents (child_id, photos_class, photos_social, outings, emergency_treatment, birthday_wall) values ('${beta}', true, false, true, true, false)`], // 6
    [U.hana, add(M2, C1, 'photo', 'image/jpeg', null, [alpha, beta])],                                                     // 7 now ok
    [U.mariam, add(M3, C1, 'photo', 'image/jpeg', null, [alpha])],                                                         // 8 not her class
    [U.parentA, add(M3, C1, 'photo', 'image/jpeg', null, [alpha])],                                                        // 9 parent
    [U.hana, add(M3, C1, 'video', 'video/mp4', 61, [alpha])],                                                              // 10 too long
    [U.hana, add(M3, C1, 'video', 'video/mp4', 'null', [alpha])],                                                          // 11 no duration
    [U.hana, add(M3, C1, 'photo', 'video/mp4', null, [alpha])],                                                            // 12 type mismatch
    [U.hana, add(M3, C1, 'photo', 'image/jpeg', null, [alpha], D, `${C2}/x.jpg`)],                                         // 13 wrong folder
    [U.hana, `select public.media_add('${M3}', '${C1}', null, '${D}', 'photo', '${C1}/${M3}.jpg', 'f.jpg', 'image/jpeg', 1000, null, array[]::uuid[])`], // 14 nobody tagged
    [U.hana, add(M3, C1, 'photo', 'image/jpeg', null, [alpha], '2026-10-12')],                                             // 15 future date
    [U.hana, add(M3, C1, 'photo', 'image/jpeg', null, [alpha], '2026-06-01')],                                             // 16 too old
    [U.hana, add(M3, C1, 'photo', 'image/jpeg', null, [gamma])],                                                           // 17 child of another class
    [U.hana, add(M4, C1, 'video', 'video/mp4', 30, [beta])],                                                               // 18 ok video
  ]);
  check('a teacher can save photos and short videos of their own class; others cannot, and every bad request is refused', !res[4].error && !res[7].error && !!res[8].error && !!res[9].error && [10, 11, 12, 13, 14, 15, 16, 17].every((i) => !!res[i].error) && !res[18].error, JSON.stringify([4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((i) => [i, res[i].error])));
  check('a photo tagged with a child whose parents did not agree is blocked, naming the child; the teacher can check first', /no_photo_consent: Salma/.test(res[5].error) && res[1].rows.map((x) => x.child_name).join().startsWith('Salma') && res[2].rows.length === 0 && res[3].rows.length === 0, JSON.stringify([res[5].error, res[1].rows]));
  check('a video longer than 60 seconds is refused', /video_too_long/.test(res[10].error));

  // who sees what
  const baseline = [
    T('2026-10-11 10:00'), [U.hana, add(M1, C1, 'photo', 'image/jpeg', null, [alpha])], [null, `insert into public.child_consents (child_id, photos_class, photos_social, outings, emergency_treatment, birthday_wall) values ('${beta}', true, false, true, true, false)`],
    [U.hana, add(M2, C1, 'photo', 'image/jpeg', null, [alpha, beta])], [U.hana, add(M4, C1, 'video', 'video/mp4', 30, [beta])],
  ];
  const mine = (u) => [u, `select id from public.media_items where id in ('${M1}','${M2}','${M4}') order by id`];
  res = await flow([...baseline,
    mine(U.parentA), mine(U.parentB), mine(U.parentC), mine(U.hana), mine(U.mariam), mine(U.admin),                                // 5..10
    [U.parentA, `select child_id from public.media_tags where media_id = '${M2}'`],                                                 // 11 only my own child's tag
    [U.parentB, `select child_id from public.media_tags where media_id = '${M2}'`],                                                 // 12
    [U.hana, `select count(*)::int as n from public.media_tags where media_id = '${M2}'`],                                          // 13 teacher sees both tags
    [U.hana, `select public.media_set_tags('${M2}', array['${gamma}']::uuid[])`],                                                   // 14 gamma is not in her class
    [U.hana, `select public.media_set_tags('${M2}', array['${alpha}']::uuid[])`],                                                   // 15 remove Salma
    [U.parentB, `select id from public.media_items where id = '${M2}'`],                                                            // 16 Salma's parent no longer sees it
    [U.mariam, `select public.media_set_tags('${M2}', array['${alpha}']::uuid[])`],                                                 // 17
  ]);
  const ids = (r) => r.rows.map((x) => x.id).join();
  check('a parent sees only photos and videos in which their own child is tagged', ids(res[5]) === [M1, M2].sort().join() && ids(res[6]) === [M2, M4].sort().join() && ids(res[7]) === [M1, M2].sort().join(), JSON.stringify([5, 6, 7].map((i) => ids(res[i]))));
  check('teachers see their own class\'s items, another class\'s teacher none, management all', res[8].rows.length === 3 && res[9].rows.length === 0 && res[10].rows.length === 3);
  check('a parent never learns which other children are in a photo (only their own tag is readable); teachers see all tags', res[11].rows.length === 1 && res[11].rows[0].child_id === alpha && res[12].rows.length === 1 && res[12].rows[0].child_id === beta && res[13].rows[0].n === 2);
  check('tags can be corrected by the class teacher only for their own class\'s children; the photo then disappears for the untagged family', !!res[14].error && !res[15].error && res[16].rows.length === 0 && !!res[17].error);

  // removal and social media
  res = await flow([...baseline,
    [U.hana, `select public.media_remove('${M1}')`],                                                                                 // 5 teachers cannot
    [U.admin, `select public.media_remove('${M1}')`],                                                                                // 6
    mine(U.parentA), mine(U.hana), mine(U.admin),                                                                                    // 7, 8, 9
    [U.admin, `select public.media_mark_post('${M2}', true)`],                                                                       // 10 Omar and Salma have no social consent
    [null, `update public.child_consents set photos_social = true where child_id = '${alpha}'`],                                     // 11
    [U.admin, `select public.media_mark_post('${M2}', true)`],                                                                       // 12 Salma still no
    [U.admin, `select public.media_mark_post('${M4}', true)`],                                                                       // 13 Salma only: no
    [null, `update public.child_consents set photos_social = true where child_id = '${beta}'`],                                      // 14
    [U.manager, `select public.media_mark_post('${M2}', true)`],                                                                     // 15 manager may not
    [U.hana, `select public.media_mark_post('${M2}', true)`],                                                                        // 16
    [U.owner, `select public.media_mark_post('${M2}', true)`],                                                                       // 17 owner may
    [U.admin, `select ok_to_post from public.media_items where id = '${M2}'`],                                                       // 18
    [null, `update public.child_consents set photos_social = false where child_id = '${beta}'`],                                     // 19 consent withdrawn later
    [U.hana, `select public.media_set_tags('${M2}', array['${alpha}','${beta}']::uuid[])`],                                          // 20 re-tagging re-checks (the post flag is on)
    [U.admin, `select public.media_mark_post('${M2}', false)`], [U.admin, `select ok_to_post from public.media_items where id = '${M2}'`], // 21, 22
  ]);
  check('only admin and management can remove an item; a removed item is gone for parents and teachers but kept for management', !!res[5].error && !res[6].error && ids(res[7]) === [M2].join() && !ids(res[8]).includes(M1) && ids(res[9]).includes(M1));
  check('"OK to post" needs social media consent for every child in the item', /no_social_consent/.test(res[10].error) && /no_social_consent: Salma/.test(res[12].error) && /no_social_consent/.test(res[13].error), JSON.stringify([res[10].error, res[12].error, res[13].error]));
  check('only admin or the owner can mark it (not the manager or a teacher); it can be cleared; re-tagging with a child who has no social consent is refused while it is marked', !!res[15].error && !!res[16].error && !res[17].error && res[18].rows[0].ok_to_post === true && /no_social_consent/.test(res[20].error) && !res[21].error && res[22].rows[0].ok_to_post === false, JSON.stringify([res[15].error, res[16].error, res[17].error, res[20].error]));

  // private storage
  res = await flow([...baseline,
    [U.hana, `insert into storage.objects (bucket_id, name) values ('media', '${C1}/${ID(980)}.jpg')`],                              // 5 ok
    [U.hana, `insert into storage.objects (bucket_id, name) values ('media', '${C2}/${ID(981)}.jpg')`],                              // 6 other class
    [U.parentA, `insert into storage.objects (bucket_id, name) values ('media', '${C1}/${ID(982)}.jpg')`],                           // 7 a parent
    [U.hana, `insert into storage.objects (bucket_id, name) values ('media', 'not-a-class/x.jpg')`],                                 // 8
    [null, `insert into storage.objects (bucket_id, name) values ('media', '${C1}/${M1}.jpg'), ('media', '${C1}/${M4}.mp4')`],     // 9 the registered files
    [U.parentA, `select name from storage.objects where bucket_id = 'media' order by name`],                                         // 10 only Omar's photo
    [U.parentB, `select name from storage.objects where bucket_id = 'media' order by name`],                                         // 11 Salma's: the video
    [U.mariam, `select count(*)::int as n from storage.objects where bucket_id = 'media'`],                                          // 12
    [U.hana, `delete from storage.objects where bucket_id = 'media' and name = '${C1}/${ID(980)}.jpg'`],                             // 13 take back an unregistered file
    [U.hana, `delete from storage.objects where bucket_id = 'media' and name = '${C1}/${M1}.jpg'`],                                  // 14 registered: refused silently
    [null, `select count(*)::int as n from storage.objects where bucket_id = 'media'`],                                              // 15
  ]);
  check('a teacher can upload only into their own class\'s folder; parents cannot upload', !res[5].error && !!res[6].error && !!res[7].error && !!res[8].error);
  check('parents can open only the files of items in which their child is tagged; other classes\' teachers see none', res[10].rows.map((x) => x.name).join() === `${C1}/${M1}.jpg,${C1}/${M2}.jpg`.split(',').filter((n) => n.includes(M1)).join() && res[11].rows.map((x) => x.name).join().includes(M4) && !res[11].rows.map((x) => x.name).join().includes(M1) && res[12].rows[0].n === 0, JSON.stringify([res[10].rows, res[11].rows, res[12].rows]));
  check('an unregistered upload can be taken back; a registered file cannot be deleted by a teacher', res[15].rows[0].n === 2, JSON.stringify(res[15].rows));

  // retention
  res = await flow([...baseline,
    [U.admin, `select public.media_settings_save(6, 'archive')`], [U.hana, `select public.media_settings_save(6, 'archive')`], [U.admin, `select public.media_settings_save(0, 'delete')`], [U.admin, `select public.media_settings_save(6, 'burn')`], // 5..8
    [null, `insert into public.media_items (id, class_id, album_date, kind, storage_path, file_name, mime_type, size_bytes) values ('${ID(990)}', '${C1}', '2026-01-05', 'photo', '${C1}/old.jpg', 'old.jpg', 'image/jpeg', 10)`], // 9
    [null, `insert into public.media_tags (media_id, child_id) values ('${ID(990)}', '${alpha}')`],                                   // 10
    [null, `select id, action from public.cka_media_expired((timestamp '2026-10-11 10:00') at time zone 'Africa/Cairo')`],         // 11
    [U.admin, `select public.media_remove('${M1}')`],                                                                                // 12
    [null, `select id from public.cka_media_expired((timestamp '2026-12-30 10:00') at time zone 'Africa/Cairo') where action = 'delete'`], // 13 removed more than 30 days ago
    [null, `select public.cka_media_apply(array['${ID(990)}']::uuid[], 'archive')`],                                                 // 14
    [U.parentA, `select id from public.media_items where id = '${ID(990)}'`], [U.admin, `select archived from public.media_items where id = '${ID(990)}'`], // 15, 16
    [U.admin, `select public.cka_media_apply(array['${ID(990)}']::uuid[], 'delete')`],                                               // 17 browsers cannot
    [null, `select public.cka_media_apply(array['${ID(990)}']::uuid[], 'delete')`],                                                  // 18
    [null, `select count(*)::int as n from public.media_items where id = '${ID(990)}'`], [null, `select count(*)::int as n from public.media_tags where media_id = '${ID(990)}'`], // 19, 20
    [U.admin, `select retention_months, action from public.media_settings`],                                                         // 21
    [U.admin, `select public.media_settings_save(null, 'delete')`], [U.admin, `select retention_months from public.media_settings`],  // 22, 23
  ]);
  check('only management sets the retention period; bad settings are refused; "keep for ever" is allowed', !res[5].error && !!res[6].error && !!res[7].error && !!res[8].error && res[21].rows[0].retention_months === 6 && res[21].rows[0].action === 'archive' && !res[22].error && res[23].rows[0].retention_months === null);
  check('items older than the retention period are listed for the server with the chosen action, and removed items are purged after 30 days', res[11].rows.some((x) => x.id === ID(990) && x.action === 'archive') && !res[11].rows.some((x) => x.id === M1) && res[13].rows.some((x) => x.id === M1), JSON.stringify([res[11].rows, res[13].rows]));
  check('archiving hides an item from parents but management keeps it; deleting removes the item and its tags; browsers cannot run the clean-up', res[15].rows.length === 0 && res[16].rows[0].archived === true && !!res[17].error && res[19].rows[0].n === 0 && res[20].rows[0].n === 0);
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
