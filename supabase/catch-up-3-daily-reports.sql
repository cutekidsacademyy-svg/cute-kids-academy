-- CATCH-UP 3: daily reports (Prompt 13) and any later migrations, plus the security hardening. Paste into the Supabase SQL editor and run ONCE.
-- Only for a project that already ran an earlier catch-up that included 20261006121500_attendance.sql but NOT 20261006121600_daily_reports.sql.
-- Generated from supabase/migrations/*.sql: do not edit; run  bash regen.sh

-- ============================================================
-- migrations/20261006121600_daily_reports.sql
-- ============================================================
-- Daily reports (Prompt 13, with the owner-approved changes of Prompt 21).
--
-- Teachers tap entries during the day for the children who are checked in: lunch (more, all, half, little, none),
-- water (cups), milk (ml), sleep (minutes), diaper changes, stools, temperature when needed, mood, and one personal
-- sentence. "Kindly send for tomorrow" (diapers, wipes, shower gel, cotton, extra clothes, other) is set per child.
-- Reports stay private drafts until they are sent (all together, or automatically at a set time before pickup);
-- after that only admin, manager or owner can change one, and every change is recorded.
-- A temperature of 38.0 or above alerts the class staff and the admins. Browsers only READ these tables.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.daily_reports (
  id               uuid primary key default gen_random_uuid(),
  child_id         uuid not null references public.children (id),
  report_date      date not null,
  lunch            text check (lunch in ('more', 'all', 'half', 'little', 'none')),
  water_cups       integer check (water_cups between 0 and 30),
  milk_ml          integer check (milk_ml between 0 and 2000),
  sleep_minutes    integer check (sleep_minutes between 0 and 720),
  diaper_changes   integer check (diaper_changes between 0 and 30),
  stool_count      integer check (stool_count between 0 and 30),
  temperature      numeric(3, 1) check (temperature between 34 and 43),
  mood             text check (mood in ('happy', 'calm', 'tired', 'upset')),
  personal_note    text check (length(personal_note) <= 1000),
  status           text not null default 'draft' check (status in ('draft', 'sent')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles (id),
  sent_at          timestamptz,
  sent_by          uuid references public.profiles (id),          -- null when it was sent automatically
  unique (child_id, report_date)
);
create index daily_reports_date_idx on public.daily_reports (report_date);

-- Changes to a report AFTER it was sent (admin, manager, owner only): who, why, and exactly what changed.
create table public.daily_report_edits (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.daily_reports (id),
  editor_id    uuid references public.profiles (id),
  editor_name  text,
  reason       text not null,
  before       jsonb not null,
  after        jsonb not null,
  created_at   timestamptz not null default now()
);

-- "Kindly send for tomorrow": things a family should bring on the child's next school day.
create table public.send_requests (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid not null references public.children (id),
  for_date    date not null,
  items       text[] not null check (items <@ array['diapers', 'wipes', 'shower_gel', 'cotton', 'extra_clothes', 'other'] and cardinality(items) > 0),
  other_text  text check (length(other_text) <= 200),
  published   boolean not null default false,                   -- families see it once the child's report has been sent
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  unique (child_id, for_date)
);

-- One row: should reports go out by themselves, and when?
create table public.report_settings (
  id             boolean primary key default true check (id),
  auto_send      boolean not null default true,
  auto_send_time time not null default '16:30',
  updated_by     uuid references public.profiles (id)
);
insert into public.report_settings (id) values (true);

alter table public.daily_reports      enable row level security;
alter table public.daily_report_edits enable row level security;
alter table public.send_requests      enable row level security;
alter table public.report_settings    enable row level security;
revoke all on public.daily_reports, public.daily_report_edits, public.send_requests, public.report_settings from anon, authenticated;
grant select on public.daily_reports, public.daily_report_edits, public.send_requests, public.report_settings to authenticated;

-- Parents see only SENT reports about their own children; the class teacher and management also see drafts.
create policy dr_select   on public.daily_reports      for select using (public.can_see_child(child_id) and (status = 'sent' or public.auth_role() <> 'parent'));
create policy dre_select  on public.daily_report_edits for select using (public.is_management());
create policy sr_select   on public.send_requests      for select using (public.can_see_child(child_id) and (published or public.auth_role() <> 'parent'));
create policy rs_select   on public.report_settings    for select using (public.is_management());

-- ---------------------------------------------------------------------------
-- Helpers (internal)
-- ---------------------------------------------------------------------------
create function public.cka_report_has_content(r public.daily_reports) returns boolean
language sql immutable as $$
  select r.lunch is not null or r.water_cups is not null or r.milk_ml is not null or r.sleep_minutes is not null or r.diaper_changes is not null
      or r.stool_count is not null or r.temperature is not null or r.mood is not null or nullif(btrim(coalesce(r.personal_note, '')), '') is not null
$$;

-- Create or update a report from a JSON object of fields. Only keys that are present are changed; null clears one.
create function public.cka_report_upsert(p_child uuid, p_date date, f jsonb) returns public.daily_reports
language plpgsql security definer set search_path = public as $$
declare r public.daily_reports; s uuid; had_fever boolean;
begin
  select * into r from public.daily_reports where child_id = p_child and report_date = p_date;
  if r.id is null then
    insert into public.daily_reports (child_id, report_date, updated_by) values (p_child, p_date, auth.uid()) returning * into r;
  end if;
  had_fever := coalesce(r.temperature >= 38, false);
  begin
    update public.daily_reports set
      lunch          = case when f ? 'lunch' then nullif(f ->> 'lunch', '') else lunch end,
      water_cups     = case when f ? 'water_cups' then (f ->> 'water_cups')::int else water_cups end,
      milk_ml        = case when f ? 'milk_ml' then (f ->> 'milk_ml')::int else milk_ml end,
      sleep_minutes  = case when f ? 'sleep_minutes' then (f ->> 'sleep_minutes')::int else sleep_minutes end,
      diaper_changes = case when f ? 'diaper_changes' then (f ->> 'diaper_changes')::int else diaper_changes end,
      stool_count    = case when f ? 'stool_count' then (f ->> 'stool_count')::int else stool_count end,
      temperature    = case when f ? 'temperature' then (f ->> 'temperature')::numeric else temperature end,
      mood           = case when f ? 'mood' then nullif(f ->> 'mood', '') else mood end,
      personal_note  = case when f ? 'personal_note' then nullif(btrim(f ->> 'personal_note'), '') else personal_note end,
      updated_at = now(), updated_by = auth.uid()
     where id = r.id returning * into r;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_report_value';
  end;
  -- a fever alerts the class staff and the admins once per report (the email carries no names or numbers)
  if r.temperature >= 38 and not had_fever then
    for s in select * from public.cka_class_staff_and_admins(p_child) loop
      perform public.cka_enqueue_email(s, 'fever_alert', jsonb_build_object('child_id', p_child), 'fever:' || r.id || ':' || s);
    end loop;
  end if;
  return r;
end $$;

-- Mark one report as sent and tell the parents (no details in the email).
create function public.cka_report_send_one(p_report uuid, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.daily_reports; s uuid;
begin
  update public.daily_reports set status = 'sent', sent_at = now(), sent_by = p_by where id = p_report and status = 'draft' returning * into r;
  if r.id is null then return; end if;
  update public.send_requests set published = true where child_id = r.child_id and for_date = public.cka_next_work_day(r.report_date);
  for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = r.child_id loop
    perform public.cka_enqueue_email(s, 'daily_report_ready', jsonb_build_object('child_id', r.child_id), 'report:' || r.id || ':' || s);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The teacher's sheet: today's checked-in children (and anyone who already has a report)
-- ---------------------------------------------------------------------------
create function public.report_sheet(p_date date default null)
returns table (child_id uuid, child_name text, class_id uuid, class_name text, allergies text,
               report_id uuid, status text, lunch text, water_cups int, milk_ml int, sleep_minutes int, diaper_changes int, stool_count int,
               temperature numeric, mood text, personal_note text, sent_at timestamptz,
               send_items text[], send_other text, has_content boolean, checked_out boolean)
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(p_date, public.cka_today()) as day)
  select c.id, c.full_name, c.class_id, cl.name, nullif(btrim(h.allergies), ''),
         r.id, r.status, r.lunch, r.water_cups, r.milk_ml, r.sleep_minutes, r.diaper_changes, r.stool_count, r.temperature, r.mood, r.personal_note, r.sent_at,
         sr.items, sr.other_text, coalesce(public.cka_report_has_content(r), false), a.checked_out_at is not null
    from d
    join public.children c on c.active
    left join public.classes cl on cl.id = c.class_id
    left join public.child_health h on h.child_id = c.id
    left join public.attendance a on a.child_id = c.id and a.att_date = d.day
    left join public.daily_reports r on r.child_id = c.id and r.report_date = d.day
    left join public.send_requests sr on sr.child_id = c.id and sr.for_date = public.cka_next_work_day(d.day)
   where public.auth_role() in ('admin', 'manager', 'owner', 'teacher') and public.can_see_child(c.id) and (a.id is not null or r.id is not null)
   order by cl.name nulls last, c.full_name
$$;

-- Save entries for one or many children at once ("the whole class ate lunch"). Only for children who are checked in today.
create function public.report_save_many(p_children uuid[], p_fields jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); c uuid; n int := 0; st text;
begin
  if p_children is null or cardinality(p_children) = 0 or cardinality(p_children) > 60 then raise exception 'Choose between 1 and 60 children'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then raise exception 'invalid_report_value'; end if;
  foreach c in array p_children loop
    if not public.cka_door_allowed(c) then raise exception 'Not allowed'; end if;
    if not exists (select 1 from public.attendance where child_id = c and att_date = day) then raise exception 'not_checked_in'; end if;
    select status into st from public.daily_reports where child_id = c and report_date = day;
    if st = 'sent' then raise exception 'already_sent'; end if;
    perform public.cka_report_upsert(c, day, p_fields);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Send today's reports now: the given children, or everyone the caller may report on. Empty reports are not sent.
create function public.report_send(p_children uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); r record; n int := 0;
begin
  if public.auth_role() not in ('admin', 'manager', 'owner', 'teacher') then raise exception 'Not allowed'; end if;
  for r in select * from public.daily_reports d where d.report_date = day and d.status = 'draft' and public.cka_report_has_content(d)
              and (p_children is null or d.child_id = any (p_children)) and public.cka_door_allowed(d.child_id) loop
    perform public.cka_report_send_one(r.id, auth.uid());
    n := n + 1;
  end loop;
  return n;
end $$;

-- "Kindly send for tomorrow" for one child (empty list removes it). Applies to the next school day.
create function public.send_request_save(p_child uuid, p_items text[], p_other text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d date := public.cka_next_work_day(public.cka_today()); other text := nullif(btrim(coalesce(p_other, '')), ''); pub boolean;
begin
  if not public.cka_door_allowed(p_child) then raise exception 'Not allowed'; end if;
  if p_items is null or cardinality(p_items) = 0 then
    delete from public.send_requests where child_id = p_child and for_date = d;
    return;
  end if;
  if not (p_items <@ array['diapers', 'wipes', 'shower_gel', 'cotton', 'extra_clothes', 'other']) then raise exception 'Unknown item'; end if;
  if 'other' = any (p_items) and other is null then raise exception 'Please say what to send'; end if;
  pub := exists (select 1 from public.daily_reports where child_id = p_child and report_date = public.cka_today() and status = 'sent');
  insert into public.send_requests (child_id, for_date, items, other_text, published, created_by)
  values (p_child, d, p_items, case when 'other' = any (p_items) then other end, pub, auth.uid())
  on conflict (child_id, for_date) do update set items = excluded.items, other_text = excluded.other_text, created_by = excluded.created_by;
end $$;

-- Admin, manager, owner: change a report AFTER it was sent. The reason is required and the change is recorded.
create function public.report_edit_sent(p_report uuid, p_fields jsonb, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.daily_reports; b jsonb; a jsonb; why text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(why) < 3 then raise exception 'Please say why you are changing a sent report'; end if;
  select * into r from public.daily_reports where id = p_report;
  if r.id is null then raise exception 'Not found'; end if;
  if r.status <> 'sent' then raise exception 'This report has not been sent yet'; end if;
  b := to_jsonb(r) - 'id' - 'child_id' - 'report_date' - 'status' - 'created_at' - 'updated_at' - 'updated_by' - 'sent_at' - 'sent_by';
  r := public.cka_report_upsert(r.child_id, r.report_date, p_fields);
  a := to_jsonb(r) - 'id' - 'child_id' - 'report_date' - 'status' - 'created_at' - 'updated_at' - 'updated_by' - 'sent_at' - 'sent_by';
  if a = b then return; end if;
  insert into public.daily_report_edits (report_id, editor_id, editor_name, reason, before, after) values (r.id, auth.uid(), public.cka_actor_name(), why, b, a);
end $$;

-- ---------------------------------------------------------------------------
-- Admin and owner: how are today's reports going?
-- ---------------------------------------------------------------------------
create function public.report_overview(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare day date := coalesce(p_date, public.cka_today()); out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'date', day,
    'present', (select count(*) from public.attendance where att_date = day),
    'sent', (select count(*) from public.daily_reports r where r.report_date = day and r.status = 'sent'),
    'ready', (select count(*) from public.daily_reports r where r.report_date = day and r.status = 'draft' and public.cka_report_has_content(r)),
    'not_started', (select count(*) from public.attendance a where a.att_date = day
                      and not exists (select 1 from public.daily_reports r where r.child_id = a.child_id and r.report_date = day and public.cka_report_has_content(r))),
    'missing_note', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'child_name', c.full_name, 'class_name', coalesce(cl.name, '')) order by cl.name, c.full_name)
                      from public.attendance a join public.children c on c.id = a.child_id left join public.classes cl on cl.id = c.class_id
                     where a.att_date = day and not exists (select 1 from public.daily_reports r where r.child_id = c.id and r.report_date = day and nullif(btrim(coalesce(r.personal_note, '')), '') is not null)), '[]'),
    'fever', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'child_name', c.full_name, 'class_name', coalesce(cl.name, ''), 'temperature', r.temperature) order by r.temperature desc)
                      from public.daily_reports r join public.children c on c.id = r.child_id left join public.classes cl on cl.id = c.class_id
                     where r.report_date = day and r.temperature >= 38), '[]'),
    'settings', (select jsonb_build_object('auto_send', auto_send, 'auto_send_time', to_char(auto_send_time, 'HH24:MI')) from public.report_settings)
  ) into out;
  return out;
end $$;

create function public.report_settings_save(p_auto boolean, p_time time) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_time is null or p_time < time '12:00' or p_time > time '17:45' then raise exception 'Please choose a time between 12:00 and 17:45'; end if;
  update public.report_settings set auto_send = coalesce(p_auto, true), auto_send_time = p_time, updated_by = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- The scheduler (server only, every 15 minutes): the 4 pm nudge for personal notes, and the automatic send
-- ---------------------------------------------------------------------------
create function public.cka_run_report_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; day date := l::date; s record; r record; reminders int := 0; sent int := 0; cfg public.report_settings; cnt int;
begin
  if not public.cka_is_work_day(day) or l::time < time '16:00' or l::time >= time '18:00' then
    return jsonb_build_object('checked', false, 'reminders', 0, 'sent', 0);
  end if;
  -- teachers whose present children still lack a personal sentence
  for s in select p.id as teacher from public.profiles p where p.role = 'teacher' and p.active loop
    select count(*) into cnt from public.attendance a join public.children c on c.id = a.child_id
     where a.att_date = day and c.class_id is not null
       and (c.class_id in (select class_id from public.staff_classes where staff_id = s.teacher) or c.class_id in (select id from public.classes where head_teacher_id = s.teacher))
       and not exists (select 1 from public.daily_reports d where d.child_id = c.id and d.report_date = day and nullif(btrim(coalesce(d.personal_note, '')), '') is not null);
    if cnt > 0 then
      perform public.cka_enqueue_email(s.teacher, 'report_note_reminder', jsonb_build_object('count', cnt), 'reportnote:' || day || ':' || s.teacher);
      reminders := reminders + 1;
    end if;
  end loop;
  -- automatic send
  select * into cfg from public.report_settings;
  if cfg.auto_send and l::time >= cfg.auto_send_time then
    for r in select id from public.daily_reports d where d.report_date = day and d.status = 'draft' and public.cka_report_has_content(d) loop
      perform public.cka_report_send_one(r.id, null);
      sent := sent + 1;
    end loop;
  end if;
  return jsonb_build_object('checked', true, 'reminders', reminders, 'sent', sent);
end $$;

-- Grants: browsers run the report screens; only the server runs the scheduled check and the internal helpers.
revoke all on function
  public.cka_report_has_content(public.daily_reports), public.cka_report_upsert(uuid, date, jsonb), public.cka_report_send_one(uuid, uuid),
  public.report_sheet(date), public.report_save_many(uuid[], jsonb), public.report_send(uuid[]), public.send_request_save(uuid, text[], text),
  public.report_edit_sent(uuid, jsonb, text), public.report_overview(date), public.report_settings_save(boolean, time), public.cka_run_report_check(timestamptz)
from public, anon, authenticated;
grant execute on function public.report_sheet(date), public.report_save_many(uuid[], jsonb), public.report_send(uuid[]), public.send_request_save(uuid, text[], text),
  public.report_edit_sent(uuid, jsonb, text), public.report_overview(date), public.report_settings_save(boolean, time) to authenticated;
grant execute on function public.cka_run_report_check(timestamptz) to service_role;

-- ============================================================
-- migrations/29991231000000_hardening.sql
-- ============================================================
-- Security hardening (Prompt 10).
--
-- Why: on Supabase, every NEW function in the public schema is automatically executable by anonymous
-- visitors ("anon") and by every logged-in user ("authenticated"). Revoking from PUBLIC (which earlier
-- migrations did) does not remove those automatic grants. So internal helpers, such as the one that
-- queues emails, the deadline checker, or the person-name lookup, could be called straight from the
-- internet. This migration revokes execute on EVERY security-definer and trigger function, then grants
-- back exactly what each role needs:
--   * logged-in users: the screens' functions and the small yes/no helpers that row-level security uses
--   * the server key (service_role): the two scheduled jobs
--   * anonymous visitors: nothing
-- This file is safe to run again at any time, and must always be the LAST migration applied.
-- If you add a new function in a later migration, add it to the list below (the test suite fails if a
-- function is reachable by anyone it should not be).

do $$
declare
  f record;
  logged_in text[] := array[
    -- helpers used inside the row-level-security policies
    'auth_role', 'is_management', 'is_manager_or_owner', 'is_owner', 'teaches_class', 'can_see_child',
    'owns_submission', 'staff_can_see_submission', 'parent_owns_investigation', 'teacher_sees_parent',
    -- needed by a trigger that runs as the logged-in user
    'cka_actor_name',
    -- screens and actions (each checks the caller's role itself)
    'change_urgency', 'respond_to_resolution', 'mark_incident_read', 'respond_to_investigation', 'submission_handler_name',
    'parent_cases', 'parent_incidents', 'list_staff_names',
    'staff_queue', 'staff_case', 'staff_list', 'staff_ratings', 'staff_acknowledge', 'staff_mark_in_progress', 'staff_assign',
    'staff_escalate', 'staff_resolve', 'save_investigation', 'investigation_name_warnings', 'staff_investigations',
    'staff_investigation', 'staff_report', 'record_staff_attendance', 'staff_attendance_day', 'submit_staff_complaint',
    'confirm_investigation_fault', 'investigation_fault', 'owner_dashboard', 'owner_set_check', 'owner_routine',
    'registration_list', 'registration_get', 'registration_set_status', 'approve_registration', 'class_allergies',
    'parent_update_health', 'parent_save_pickup',
    'report_sheet', 'report_save_many', 'report_send', 'send_request_save', 'report_edit_sent', 'report_overview', 'report_settings_save',
    'cka_door_file', 'door_list', 'door_pickups', 'door_parents', 'door_check_in', 'door_check_out', 'door_undo', 'door_log_call', 'parent_report_attendance',
    'parent_cancel_attendance_notice', 'attendance_report'
  ];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.prosecdef or p.prorettype = 'trigger'::regtype)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (logged_in) then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

-- The scheduled jobs are for the server key only (skipped if those migrations are not applied yet;
-- the loop above has already locked down whatever exists, and running this file again later fixes the rest).
do $$
begin
  if to_regprocedure('public.cka_run_deadline_check(timestamptz)') is not null then
    revoke all on function public.cka_run_deadline_check(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_deadline_check(timestamptz) to service_role;
  end if;
  if to_regprocedure('public.cka_run_report_check(timestamptz)') is not null then
    revoke all on function public.cka_run_report_check(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_report_check(timestamptz) to service_role;
  end if;
  if to_regprocedure('public.cka_run_attendance_check(timestamptz)') is not null then
    revoke all on function public.cka_run_attendance_check(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_attendance_check(timestamptz) to service_role;
  end if;
  if to_regprocedure('public.cka_run_owner_reminders(timestamptz)') is not null then
    revoke all on function public.cka_run_owner_reminders(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_owner_reminders(timestamptz) to service_role;
  end if;
end $$;
