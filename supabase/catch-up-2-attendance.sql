-- CATCH-UP 2: attendance and pickup (Prompt 12), daily reports (Prompt 13) and any later migrations, plus the security hardening. Paste into the Supabase SQL editor and run ONCE.
-- Only for a project that already ran an earlier catch-up-migrations.sql (one that did NOT include 20261006121500_attendance.sql).
-- Generated from supabase/migrations/*.sql: do not edit; run  bash regen.sh

-- ============================================================
-- migrations/20261006121500_attendance.sql
-- ============================================================
-- Attendance and pickup (Prompt 12).
--
-- * The door screen: staff check each child in and out; the time is recorded.
-- * At check-out staff choose who is collecting from the child's authorised pickup list. Anyone not on the list
--   is recorded as an exception (the screen tells staff to keep the child and call the parent) and the parents,
--   the class staff and the admins are told.
-- * Parents report an absence or a late arrival (before 8 am for today, any time for a later day).
-- * Children not checked in by 9:30 with no notice are flagged to admin (checked by the scheduler).
-- * Pickups after 18:00 Cairo time are recorded as overtime minutes (the billing report reads them).
-- * Parents see their child's check-in and check-out times; teachers see their own class; admin sees everyone.
-- Browsers only READ these tables (row-level security); every change goes through a checked function.

-- ---------------------------------------------------------------------------
-- The clock. cka_now() is "now", except that tests can set app.now to travel in time.
-- ---------------------------------------------------------------------------
create function public.cka_now() returns timestamptz
language sql stable as $$ select coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now()) $$;

create function public.cka_today() returns date
language sql stable as $$ select (public.cka_now() at time zone 'Africa/Cairo')::date $$;

-- Only the database's own functions use these two.
revoke all on function public.cka_now(), public.cka_today() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.attendance (
  id                    uuid primary key default gen_random_uuid(),
  child_id              uuid not null references public.children (id),
  att_date              date not null,
  checked_in_at         timestamptz not null,
  checked_in_by         uuid references public.profiles (id),
  checked_out_at        timestamptz,
  checked_out_by        uuid references public.profiles (id),
  collector_pickup_id   uuid references public.child_pickups (id),
  collector_name        text,
  collector_relationship text,
  off_list              boolean not null default false,
  off_list_note         text,
  overtime_minutes      integer not null default 0 check (overtime_minutes >= 0),
  unique (child_id, att_date),
  check (checked_out_at is null or checked_out_at >= checked_in_at)
);
create index attendance_date_idx on public.attendance (att_date);

-- A parent's notice about a day: an absence, or a late arrival.
create table public.attendance_notices (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null references public.children (id),
  notice_date       date not null,
  kind              text not null check (kind in ('absence', 'late')),
  expected_arrival  time,
  reason            text not null check (length(btrim(reason)) between 2 and 500),
  reported_by       uuid references public.profiles (id),
  reported_by_role  text not null default 'parent',
  reported_at       timestamptz not null default now(),
  unique (child_id, notice_date)
);

-- A record of everything done at the door (who, when, what), including corrections. Management only.
create table public.attendance_events (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid not null references public.children (id),
  att_date    date not null,
  kind        text not null,
  actor_id    uuid references public.profiles (id),
  actor_name  text,
  note        text,
  created_at  timestamptz not null default now()
);
create index attendance_events_child_idx on public.attendance_events (child_id, att_date);

-- "Not here by 9:30 and no notice": one row per child per day, so admin can log that they called the parent.
create table public.attendance_flags (
  child_id    uuid not null references public.children (id),
  att_date    date not null,
  flagged_at  timestamptz not null default now(),
  called_at   timestamptz,
  called_by   uuid references public.profiles (id),
  call_note   text,
  primary key (child_id, att_date)
);

alter table public.attendance          enable row level security;
alter table public.attendance_notices  enable row level security;
alter table public.attendance_events   enable row level security;
alter table public.attendance_flags    enable row level security;
revoke all on public.attendance, public.attendance_notices, public.attendance_events, public.attendance_flags from anon, authenticated;
grant select on public.attendance, public.attendance_notices, public.attendance_events, public.attendance_flags to authenticated;

-- can_see_child(): management sees every child, a teacher only their own class, a parent only their own children.
create policy attendance_select on public.attendance         for select using (public.can_see_child(child_id));
create policy att_notice_select on public.attendance_notices for select using (public.can_see_child(child_id));
create policy att_events_select on public.attendance_events  for select using (public.is_management());
create policy att_flags_select  on public.attendance_flags   for select using (public.is_management());

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- May the caller work the door for this child? Admin, manager, owner, or the child's own class teacher.
create function public.cka_door_allowed(p_child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() in ('admin', 'manager', 'owner', 'teacher'), false) and public.can_see_child(p_child)
$$;

create function public.cka_att_log(p_child uuid, p_date date, p_kind text, p_note text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.attendance_events (child_id, att_date, kind, actor_id, actor_name, note)
  values (p_child, p_date, p_kind, auth.uid(), public.cka_actor_name(), p_note)
$$;

-- ---------------------------------------------------------------------------
-- The door screen: today's children, class by class
-- ---------------------------------------------------------------------------
create function public.door_list(p_date date default null)
returns table (child_id uuid, child_name text, class_id uuid, class_name text,
               checked_in_at timestamptz, checked_out_at timestamptz, collector_name text, off_list boolean, overtime_minutes int,
               notice_kind text, notice_reason text, notice_arrival time,
               flagged boolean, called_at timestamptz, call_note text)
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(p_date, public.cka_today()) as day)
  select c.id, c.full_name, c.class_id, cl.name,
         a.checked_in_at, a.checked_out_at, a.collector_name, coalesce(a.off_list, false), coalesce(a.overtime_minutes, 0),
         n.kind, n.reason, n.expected_arrival,
         (d.day = public.cka_today() and public.cka_is_work_day(d.day) and a.id is null and n.id is null
            and (public.cka_now() at time zone 'Africa/Cairo')::time >= time '09:30' and (public.cka_now() at time zone 'Africa/Cairo')::time < time '18:00'),
         f.called_at, f.call_note
  from d
  join public.children c on c.active
  left join public.classes cl on cl.id = c.class_id
  left join public.attendance a on a.child_id = c.id and a.att_date = d.day
  left join public.attendance_notices n on n.child_id = c.id and n.notice_date = d.day
  left join public.attendance_flags f on f.child_id = c.id and f.att_date = d.day and public.is_management()
  where public.auth_role() in ('admin', 'manager', 'owner', 'teacher') and public.can_see_child(c.id)
  order by cl.name nulls last, c.full_name
$$;

-- The people allowed to collect one child, for the door staff (management and that child's class teacher).
-- Teachers get the pickup list ONLY through this function; they still cannot read health details or documents.
create function public.door_pickups(p_child uuid)
returns table (id uuid, full_name text, relationship text, phone text, id_photo_path text)
language sql stable security definer set search_path = public as $$
  select k.id, k.full_name, k.relationship, k.phone, k.id_photo_path
    from public.child_pickups k
   where k.child_id = p_child and k.active and public.cka_door_allowed(p_child)
   order by k.full_name
$$;

-- The parents' names and phone numbers, so the door staff can call them ("keep the child and call the parent").
create function public.door_parents(p_child uuid)
returns table (full_name text, phone text)
language sql stable security definer set search_path = public as $$
  select p.full_name, p.phone
    from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active
   where pc.child_id = p_child and public.cka_door_allowed(p_child)
   order by p.full_name
$$;

-- The door staff of the child's class may open the pickup ID photos (and nothing else in the child's files).
create function public.cka_door_file(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when (storage.foldername(p_path))[2] = 'pickups' and (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then public.cka_door_allowed(((storage.foldername(p_path))[1])::uuid) else false end
$$;
create policy child_files_read_door on storage.objects for select to authenticated
  using (bucket_id = 'child-files' and public.cka_door_file(name));

create function public.door_check_in(p_child uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); t timestamptz := public.cka_now();
begin
  if not public.cka_door_allowed(p_child) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  if exists (select 1 from public.attendance where child_id = p_child and att_date = day) then raise exception 'Already checked in today'; end if;
  insert into public.attendance (child_id, att_date, checked_in_at, checked_in_by) values (p_child, day, t, auth.uid());
  perform public.cka_att_log(p_child, day, 'check_in');
  return t;
end $$;

-- Check-out. Choose a person from the child's pickup list (p_pickup), or record someone who is NOT on the list
-- (name, relationship and a note saying who approved it and how: the screen has already told staff to keep the child and call the parent).
create function public.door_check_out(p_child uuid, p_pickup uuid default null, p_name text default null, p_relationship text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  day date := public.cka_today(); t timestamptz := public.cka_now();
  a public.attendance; pk public.child_pickups; ot int; is_off boolean := false; nm text; rel text; note text := nullif(btrim(coalesce(p_note, '')), ''); s uuid;
begin
  if not public.cka_door_allowed(p_child) then raise exception 'Not allowed'; end if;
  select * into a from public.attendance where child_id = p_child and att_date = day for update;
  if a.id is null then raise exception 'This child has not been checked in today'; end if;
  if a.checked_out_at is not null then raise exception 'Already checked out'; end if;

  if p_pickup is not null then
    select * into pk from public.child_pickups where id = p_pickup and child_id = p_child and active;
    if pk.id is null then raise exception 'That person is not on this child''s pickup list'; end if;
    nm := pk.full_name; rel := pk.relationship;
  else
    nm := btrim(coalesce(p_name, '')); rel := btrim(coalesce(p_relationship, ''));
    if length(nm) < 2 or length(rel) < 2 then raise exception 'off_list_needs_details'; end if;
    if note is null or length(note) < 3 then raise exception 'off_list_needs_parent_approval'; end if;
    is_off := true;
  end if;

  ot := greatest(0, floor(extract(epoch from (t - ((day + time '18:00') at time zone 'Africa/Cairo'))) / 60))::int;
  update public.attendance
     set checked_out_at = t, checked_out_by = auth.uid(), collector_pickup_id = pk.id, collector_name = nm, collector_relationship = rel,
         off_list = is_off, off_list_note = case when is_off then note end, overtime_minutes = ot
   where id = a.id;
  perform public.cka_att_log(p_child, day, case when is_off then 'check_out_off_list' else 'check_out' end, nm || ' (' || rel || ')' || coalesce(': ' || note, ''));

  if is_off then
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
      perform public.cka_enqueue_email(s, 'pickup_off_list_parent', jsonb_build_object('child_id', p_child), 'offlist:' || a.id || ':' || s);
    end loop;
    for s in select * from public.cka_class_staff_and_admins(p_child) loop
      perform public.cka_enqueue_email(s, 'pickup_off_list_staff', jsonb_build_object('child_id', p_child), 'offlist:' || a.id || ':' || s);
    end loop;
  end if;
  return jsonb_build_object('checked_out_at', t, 'overtime_minutes', ot, 'off_list', is_off);
end $$;

-- Fix a slip at the door (today only). Every correction is logged.
create function public.door_undo(p_child uuid, p_what text) returns void
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); a public.attendance;
begin
  if not public.cka_door_allowed(p_child) then raise exception 'Not allowed'; end if;
  select * into a from public.attendance where child_id = p_child and att_date = day for update;
  if a.id is null then raise exception 'This child has not been checked in today'; end if;
  if p_what = 'check_out' then
    if a.checked_out_at is null then raise exception 'This child has not been checked out'; end if;
    update public.attendance set checked_out_at = null, checked_out_by = null, collector_pickup_id = null, collector_name = null, collector_relationship = null,
           off_list = false, off_list_note = null, overtime_minutes = 0 where id = a.id;
    perform public.cka_att_log(p_child, day, 'undo_check_out');
  elsif p_what = 'check_in' then
    if a.checked_out_at is not null then raise exception 'Undo the check-out first'; end if;
    delete from public.attendance where id = a.id;
    perform public.cka_att_log(p_child, day, 'undo_check_in');
  else
    raise exception 'Unknown action';
  end if;
end $$;

-- Admin: "I called the parent" for a child who has not arrived and has no notice.
create function public.door_log_call(p_child uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if note is null or length(note) < 2 then raise exception 'Please write what the parent said'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  insert into public.attendance_flags (child_id, att_date, called_at, called_by, call_note) values (p_child, day, public.cka_now(), auth.uid(), note)
  on conflict (child_id, att_date) do update set called_at = excluded.called_at, called_by = excluded.called_by, call_note = excluded.call_note;
  perform public.cka_att_log(p_child, day, 'parent_called', note);
end $$;

-- ---------------------------------------------------------------------------
-- Parents: report an absence or a late arrival
-- ---------------------------------------------------------------------------
create function public.parent_report_attendance(p_child uuid, p_date date, p_kind text, p_reason text, p_arrival time default null) returns void
language plpgsql security definer set search_path = public as $$
declare today date := public.cka_today(); why text := btrim(coalesce(p_reason, ''));
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_kind not in ('absence', 'late') then raise exception 'Unknown kind'; end if;
  if p_date is null or p_date < today or p_date > today + 60 then raise exception 'Please choose today or a day in the next 60 days'; end if;
  if not public.cka_is_work_day(p_date) then raise exception 'The academy is closed that day'; end if;
  if p_date = today and (public.cka_now() at time zone 'Africa/Cairo')::time >= time '08:00' then raise exception 'too_late_today'; end if;
  if length(why) < 2 or length(why) > 500 then raise exception 'Please give a short reason'; end if;
  if p_arrival is not null and (p_kind <> 'late' or p_arrival < time '08:00' or p_arrival > time '18:00') then raise exception 'Please check the arrival time'; end if;
  if p_date = today and exists (select 1 from public.attendance where child_id = p_child and att_date = p_date) then raise exception 'This child has already been checked in today'; end if;
  insert into public.attendance_notices (child_id, notice_date, kind, expected_arrival, reason, reported_by, reported_by_role)
  values (p_child, p_date, p_kind, p_arrival, why, auth.uid(), 'parent')
  on conflict (child_id, notice_date) do update set kind = excluded.kind, expected_arrival = excluded.expected_arrival, reason = excluded.reason,
         reported_by = excluded.reported_by, reported_at = now();
  perform public.cka_att_log(p_child, p_date, 'notice_' || p_kind, null);
end $$;

create function public.parent_cancel_attendance_notice(p_child uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare today date := public.cka_today();
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_date < today or (p_date = today and (public.cka_now() at time zone 'Africa/Cairo')::time >= time '08:00') then raise exception 'too_late_today'; end if;
  delete from public.attendance_notices where child_id = p_child and notice_date = p_date and reported_by_role = 'parent';
  perform public.cka_att_log(p_child, p_date, 'notice_cancelled', null);
end $$;

-- ---------------------------------------------------------------------------
-- The 9:30 check (server only; run by the scheduler every 15 minutes)
-- ---------------------------------------------------------------------------
create function public.cka_run_attendance_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; day date := l::date; added int := 0; a uuid; sent int := 0;
begin
  if not public.cka_is_work_day(day) or l::time < time '09:30' or l::time >= time '18:00' then
    return jsonb_build_object('flagged', 0, 'emails', 0, 'checked', false);
  end if;
  insert into public.attendance_flags (child_id, att_date, flagged_at)
  select c.id, day, p_now from public.children c
   where c.active and c.class_id is not null
     and not exists (select 1 from public.attendance x where x.child_id = c.id and x.att_date = day)
     and not exists (select 1 from public.attendance_notices n where n.child_id = c.id and n.notice_date = day)
  on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    for a in select id from public.profiles where role = 'admin' and active loop
      perform public.cka_enqueue_email(a, 'attendance_missing', jsonb_build_object('count', added), 'att-missing:' || day || ':' || a || ':' || (extract(epoch from p_now)::bigint / 900));
      sent := sent + 1;
    end loop;
  end if;
  return jsonb_build_object('flagged', added, 'emails', sent, 'checked', true);
end $$;

-- ---------------------------------------------------------------------------
-- Reports: attendance by class and by child for any period, and the overtime that feeds billing (management only)
-- ---------------------------------------------------------------------------
create function public.attendance_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cutoff date; out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Please choose a period of up to one year'; end if;
  -- days still in progress are not counted as "not reported": only completed days (today counts after closing time)
  cutoff := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then public.cka_today() else public.cka_today() - 1 end;
  with kids as (
    select c.id, c.full_name, c.class_id, coalesce(cl.name, '') as class_name, (c.created_at at time zone 'Africa/Cairo')::date as since
      from public.children c left join public.classes cl on cl.id = c.class_id where c.active
  ), days as (
    select k.id as child_id, g::date as d from kids k, generate_series(p_from, least(p_to, cutoff), interval '1 day') g
     where public.cka_is_work_day(g::date) and g::date >= k.since
  ), per as (
    select k.id as child_id, k.full_name, k.class_id, k.class_name,
           (select count(*) from days x where x.child_id = k.id)::int as school_days,
           (select count(*) from days x join public.attendance a on a.child_id = x.child_id and a.att_date = x.d where x.child_id = k.id)::int as present_days,
           (select count(*) from days x join public.attendance_notices n on n.child_id = x.child_id and n.notice_date = x.d and n.kind = 'absence'
              where x.child_id = k.id and not exists (select 1 from public.attendance a where a.child_id = x.child_id and a.att_date = x.d))::int as absent_reported,
           (select count(*) from public.attendance_notices n where n.child_id = k.id and n.kind = 'late' and n.notice_date between p_from and p_to)::int as late_notices,
           (select coalesce(sum(a.overtime_minutes), 0) from public.attendance a where a.child_id = k.id and a.att_date between p_from and p_to)::int as overtime_minutes,
           (select count(*) from public.attendance a where a.child_id = k.id and a.att_date between p_from and p_to and a.overtime_minutes > 0)::int as overtime_days
      from kids k
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'by_child', coalesce((select jsonb_agg(jsonb_build_object('child_id', child_id, 'child_name', full_name, 'class_name', class_name, 'school_days', school_days,
          'present_days', present_days, 'absent_reported', absent_reported, 'not_reported', greatest(0, school_days - present_days - absent_reported),
          'late_notices', late_notices, 'overtime_minutes', overtime_minutes) order by class_name, full_name) from per), '[]'),
    'by_class', coalesce((select jsonb_agg(x order by x ->> 'class_name') from (
        select jsonb_build_object('class_name', class_name, 'children', count(*), 'school_days', sum(school_days), 'present_days', sum(present_days),
               'absent_reported', sum(absent_reported), 'not_reported', sum(greatest(0, school_days - present_days - absent_reported)),
               'late_notices', sum(late_notices), 'overtime_minutes', sum(overtime_minutes)) as x
          from per group by class_name) q), '[]'),
    'overtime', coalesce((select jsonb_agg(jsonb_build_object('child_id', child_id, 'child_name', full_name, 'class_name', class_name, 'days', overtime_days, 'minutes', overtime_minutes,
          'parents', coalesce((select string_agg(p.full_name, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = per.child_id), ''))
          order by overtime_minutes desc, full_name) from per where overtime_minutes > 0), '[]')
  ) into out;
  return out;
end $$;

-- Grants: browsers may run the door, parent and report functions; only the server runs the 9:30 check.
revoke all on function
  public.cka_door_allowed(uuid), public.cka_door_file(text), public.cka_att_log(uuid, date, text, text), public.door_list(date), public.door_pickups(uuid), public.door_parents(uuid), public.door_check_in(uuid),
  public.door_check_out(uuid, uuid, text, text, text), public.door_undo(uuid, text), public.door_log_call(uuid, text),
  public.parent_report_attendance(uuid, date, text, text, time), public.parent_cancel_attendance_notice(uuid, date),
  public.cka_run_attendance_check(timestamptz), public.attendance_report(date, date)
from public, anon, authenticated;
grant execute on function public.cka_door_file(text), public.door_list(date), public.door_pickups(uuid), public.door_parents(uuid), public.door_check_in(uuid), public.door_check_out(uuid, uuid, text, text, text), public.door_undo(uuid, text),
  public.door_log_call(uuid, text), public.parent_report_attendance(uuid, date, text, text, time), public.parent_cancel_attendance_notice(uuid, date),
  public.attendance_report(date, date) to authenticated;
grant execute on function public.cka_run_attendance_check(timestamptz) to service_role;

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
  if not coalesce(public.auth_role() in ('admin', 'manager', 'owner', 'teacher'), false) then raise exception 'Not allowed'; end if;
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
-- migrations/20261006121700_announcements.sql
-- ============================================================
-- Announcements, notification choices and push (Prompt 14, part 1).
--
-- * Admin posts news to everyone, one class, or chosen families, in Arabic and English, with an optional image or PDF
--   and an "important" flag. Parents see only what is meant for them; admin sees who has read it.
-- * Important announcements remind the families who have not opened them after 24 hours.
-- * Every notification is also an email; parents choose which kinds they want. Safety messages (accident reports, safety
--   reviews) cannot be switched off. Browsers also get a push "You have a new update" with no private details.

-- ---------------------------------------------------------------------------
-- What each parent wants to hear about
-- ---------------------------------------------------------------------------
create table public.notification_prefs (
  user_id        uuid primary key references public.profiles (id),
  reports        boolean not null default true,
  announcements  boolean not null default true,
  events         boolean not null default true,
  cases          boolean not null default true,
  updated_at     timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
grant select on public.notification_prefs to authenticated;
create policy prefs_own on public.notification_prefs for select using (user_id = auth.uid());

create function public.notification_prefs_save(p_reports boolean, p_announcements boolean, p_events boolean, p_cases boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  insert into public.notification_prefs (user_id, reports, announcements, events, cases)
  values (auth.uid(), coalesce(p_reports, true), coalesce(p_announcements, true), coalesce(p_events, true), coalesce(p_cases, true))
  on conflict (user_id) do update set reports = excluded.reports, announcements = excluded.announcements, events = excluded.events,
         cases = excluded.cases, updated_at = now();
end $$;

-- The email queue now respects those choices (the kinds that protect a child's safety always go out).
create or replace function public.cka_enqueue_email(p_user uuid, p_template text, p_payload jsonb, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e text; lang text; cat text; wanted boolean;
begin
  select u.email, p.language into e, lang
    from auth.users u join public.profiles p on p.id = u.id
   where u.id = p_user and p.active;
  if e is null then return; end if;
  cat := case when p_template = 'daily_report_ready' then 'reports'
              when p_template like 'announcement%' then 'announcements'
              when p_template like 'event\_%' then 'events'
              when p_template in ('received', 'acknowledged', 'update_added', 'urgency_changed', 'resolved') then 'cases'
              else null end;
  if cat is not null then
    select case cat when 'reports' then reports when 'announcements' then announcements when 'events' then events else cases end
      into wanted from public.notification_prefs where user_id = p_user;
    if found and wanted is false then return; end if;
  end if;
  insert into public.email_outbox (user_id, to_email, language, template, payload, dedupe_key)
  values (p_user, e, lang, p_template, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Push subscriptions (browsers register; only the server reads them to send)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id),
  endpoint    text not null unique check (length(endpoint) between 20 and 1000),
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
-- Remember which queued notifications have already been pushed to the person's devices.
alter table public.email_outbox add column pushed_at timestamptz;

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  if p_endpoint !~ '^https://' or length(coalesce(p_p256dh, '')) < 20 or length(coalesce(p_auth, '')) < 8 then raise exception 'Invalid subscription'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create function public.push_unsubscribe(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
create table public.announcements (
  id               uuid primary key default gen_random_uuid(),
  title_en         text,
  title_ar         text,
  body_en          text,
  body_ar          text,
  audience         text not null check (audience in ('all', 'class', 'families')),
  class_id         uuid references public.classes (id),
  important        boolean not null default false,
  kind             text not null default 'news' check (kind in ('news', 'weekly_update')),
  attachment_path  text,
  attachment_name  text,
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  reminded_at      timestamptz,
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0),
  check (length(btrim(coalesce(body_en, ''))) > 0 or length(btrim(coalesce(body_ar, ''))) > 0),
  check ((audience = 'class') = (class_id is not null))
);
create table public.announcement_targets (
  announcement_id  uuid not null references public.announcements (id) on delete cascade,
  child_id         uuid not null references public.children (id),
  primary key (announcement_id, child_id)
);
create table public.announcement_reads (
  announcement_id  uuid not null references public.announcements (id) on delete cascade,
  user_id          uuid not null references public.profiles (id),
  read_at          timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- Who may see an announcement: management all; a teacher what is for everyone or their class; a parent what is for
-- everyone, their child's class, or their own family.
create function public.cka_announcement_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.announcements a where a.id = p_id and (
    public.is_management()
    or (public.auth_role() = 'teacher' and (a.audience = 'all' or (a.audience = 'class' and public.teaches_class(a.class_id))))
    or (public.auth_role() = 'parent' and (a.audience = 'all'
        or (a.audience = 'class' and exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id
                                              where pc.parent_id = auth.uid() and c.class_id = a.class_id and c.active))
        or (a.audience = 'families' and exists (select 1 from public.announcement_targets t join public.parent_children pc on pc.child_id = t.child_id
                                                 where t.announcement_id = a.id and pc.parent_id = auth.uid()))))))
$$;

-- The active parents an announcement is meant for.
create function public.cka_announcement_parents(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct pc.parent_id
    from public.announcements a
    join public.parent_children pc on true
    join public.children c on c.id = pc.child_id and c.active
    join public.profiles p on p.id = pc.parent_id and p.active
   where a.id = p_id and (a.audience = 'all'
      or (a.audience = 'class' and c.class_id = a.class_id)
      or (a.audience = 'families' and exists (select 1 from public.announcement_targets t where t.announcement_id = a.id and t.child_id = c.id)))
$$;

alter table public.announcements        enable row level security;
alter table public.announcement_targets enable row level security;
alter table public.announcement_reads   enable row level security;
revoke all on public.announcements, public.announcement_targets, public.announcement_reads from anon, authenticated;
grant select on public.announcements, public.announcement_targets, public.announcement_reads to authenticated;
create policy ann_select    on public.announcements        for select using (public.cka_announcement_visible(id));
create policy ann_tg_select on public.announcement_targets for select using (public.is_management());
create policy ann_rd_select on public.announcement_reads   for select using (public.is_management() or user_id = auth.uid());

-- Private storage for attachments (an image or a PDF); readable by whoever may see the announcement.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('announcements', 'announcements', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

create function public.cka_announcement_file(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then public.cka_announcement_visible(((storage.foldername(p_path))[1])::uuid) else false end
$$;
create policy announcements_read on storage.objects for select to authenticated
  using (bucket_id = 'announcements' and public.cka_announcement_file(name));
create policy announcements_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'announcements' and public.is_management());

-- Post an announcement. The page makes the id first (so the attachment can be uploaded into its own folder).
create function public.announcement_post(p_id uuid, p_title_en text, p_title_ar text, p_body_en text, p_body_ar text, p_audience text, p_class uuid,
                                         p_children uuid[], p_important boolean, p_kind text, p_attachment_path text, p_attachment_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_id is null then raise exception 'Invalid request'; end if;
  if p_audience not in ('all', 'class', 'families') then raise exception 'Choose who it is for'; end if;
  if p_audience = 'class' and not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;
  if p_audience = 'families' and (p_children is null or cardinality(p_children) = 0) then raise exception 'Choose at least one family'; end if;
  if p_attachment_path is not null and (p_attachment_path not like p_id::text || '/%' or p_attachment_path like '%..%') then raise exception 'Invalid attachment'; end if;
  insert into public.announcements (id, title_en, title_ar, body_en, body_ar, audience, class_id, important, kind, attachment_path, attachment_name, created_by)
  values (p_id, nullif(btrim(coalesce(p_title_en, '')), ''), nullif(btrim(coalesce(p_title_ar, '')), ''), nullif(btrim(coalesce(p_body_en, '')), ''), nullif(btrim(coalesce(p_body_ar, '')), ''),
          p_audience, case when p_audience = 'class' then p_class end, coalesce(p_important, false), case when p_kind = 'weekly_update' then 'weekly_update' else 'news' end,
          nullif(p_attachment_path, ''), nullif(left(p_attachment_name, 200), ''), auth.uid());
  if p_audience = 'families' then
    insert into public.announcement_targets (announcement_id, child_id) select p_id, c from unnest(p_children) c where exists (select 1 from public.children where id = c);
  end if;
  for s in select * from public.cka_announcement_parents(p_id) loop
    perform public.cka_enqueue_email(s, 'announcement_new', jsonb_build_object('important', coalesce(p_important, false)), 'ann:' || p_id || ':' || s);
  end loop;
  return p_id;
end $$;

create function public.announcement_mark_read(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'parent' or not public.cka_announcement_visible(p_id) then return; end if;
  insert into public.announcement_reads (announcement_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
end $$;

-- Admin: who has opened it, and who has not.
create function public.announcement_stats(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'total', (select count(*) from public.cka_announcement_parents(p_id)),
    'read', (select count(*) from public.announcement_reads r where r.announcement_id = p_id and r.user_id in (select * from public.cka_announcement_parents(p_id))),
    'readers', coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'read_at', r.read_at) order by r.read_at)
                from public.announcement_reads r join public.profiles p on p.id = r.user_id where r.announcement_id = p_id), '[]'),
    'unread', coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'phone', p.phone) order by p.full_name)
                from public.cka_announcement_parents(p_id) u join public.profiles p on p.id = u
               where not exists (select 1 from public.announcement_reads r where r.announcement_id = p_id and r.user_id = u)), '[]')) into out;
  return out;
end $$;

create function public.announcement_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.announcements where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.notification_prefs_save(boolean, boolean, boolean, boolean), public.push_subscribe(text, text, text), public.push_unsubscribe(text),
  public.cka_announcement_visible(uuid), public.cka_announcement_parents(uuid), public.cka_announcement_file(text),
  public.announcement_post(uuid, text, text, text, text, text, uuid, uuid[], boolean, text, text, text), public.announcement_mark_read(uuid),
  public.announcement_stats(uuid), public.announcement_remove(uuid)
from public, anon, authenticated;
grant execute on function
  public.notification_prefs_save(boolean, boolean, boolean, boolean), public.push_subscribe(text, text, text), public.push_unsubscribe(text),
  public.cka_announcement_visible(uuid), public.cka_announcement_file(text),
  public.announcement_post(uuid, text, text, text, text, text, uuid, uuid[], boolean, text, text, text), public.announcement_mark_read(uuid),
  public.announcement_stats(uuid), public.announcement_remove(uuid)
to authenticated;

-- ============================================================
-- migrations/20261006121800_menu_events.sql
-- ============================================================
-- Weekly menu, daily class schedule, events and the calendar (Prompt 14, part 2).
--
-- * A menu per day. Each dish lists its allergens; a family is warned when a dish contains something their child is
--   allergic to (matched against the allergies written in the child's health record, in English or Arabic).
-- * A daily schedule per class (arrival, activities, meals, nap, pickup).
-- * Events, closures, holidays and specialist sessions. An event can need approval: parents answer yes or no, per child,
--   before a deadline; families who have not answered get a reminder; admin sees a live list.

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
create table public.menu_items (
  id          uuid primary key default gen_random_uuid(),
  menu_date   date not null,
  meal        text not null check (meal in ('breakfast', 'lunch', 'snack')),
  dish_en     text,
  dish_ar     text,
  allergens   text[] not null default '{}' check (allergens <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'wheat', 'soy', 'fish', 'shellfish', 'sesame']),
  created_by  uuid references public.profiles (id),
  unique (menu_date, meal),
  check (length(btrim(coalesce(dish_en, ''))) > 0 or length(btrim(coalesce(dish_ar, ''))) > 0)
);

create table public.schedule_items (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid references public.classes (id),              -- null = every class
  start_time  time not null,
  title_en    text,
  title_ar    text,
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0)
);

create table public.events (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null default 'event' check (kind in ('event', 'closure', 'holiday', 'session')),
  title_en          text,
  title_ar          text,
  details_en        text,
  details_ar        text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  all_day           boolean not null default false,
  place             text check (length(place) <= 200),
  audience          text not null default 'all' check (audience in ('all', 'class')),
  class_id          uuid references public.classes (id),
  cost              numeric(10, 2) check (cost >= 0),
  needs_approval    boolean not null default false,
  approval_deadline timestamptz,
  reminded_at       timestamptz,
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0),
  check ((audience = 'class') = (class_id is not null)),
  check (not needs_approval or approval_deadline is not null),
  check (ends_at is null or ends_at >= starts_at)
);
create index events_start_idx on public.events (starts_at);

create table public.event_responses (
  event_id     uuid not null references public.events (id) on delete cascade,
  child_id     uuid not null references public.children (id),
  answered_by  uuid references public.profiles (id),
  answer       text not null check (answer in ('yes', 'no')),
  answered_at  timestamptz not null default now(),
  primary key (event_id, child_id)
);

-- Is an event meant for the caller? (management: all; teacher: everyone's or their class; parent: everyone's or their child's class)
create function public.cka_event_visible(p_audience text, p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.auth_role()
    when 'admin' then true when 'manager' then true when 'owner' then true
    when 'teacher' then p_audience = 'all' or public.teaches_class(p_class)
    when 'parent' then p_audience = 'all' or exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id
                                                      where pc.parent_id = auth.uid() and c.class_id = p_class and c.active)
    else false end
$$;

alter table public.menu_items      enable row level security;
alter table public.schedule_items  enable row level security;
alter table public.events          enable row level security;
alter table public.event_responses enable row level security;
revoke all on public.menu_items, public.schedule_items, public.events, public.event_responses from anon, authenticated;
grant select on public.menu_items, public.schedule_items, public.events, public.event_responses to authenticated;
create policy menu_select  on public.menu_items      for select using (public.auth_role() is not null);
create policy sched_select on public.schedule_items  for select using (public.auth_role() is not null);
create policy events_select on public.events         for select using (public.cka_event_visible(audience, class_id));
create policy evresp_select on public.event_responses for select using (public.can_see_child(child_id));

-- ---------------------------------------------------------------------------
-- Allergen matching: the allergies are free text typed by parents, so look for common words (English and Arabic)
-- ---------------------------------------------------------------------------
create function public.cka_allergen_match(p_text text, p_allergen text) returns boolean
language sql immutable as $$
  select coalesce(p_text, '') ~* case p_allergen
    when 'peanuts'   then 'peanut|groundnut|فول سوداني|فول السوداني'
    when 'tree_nuts' then 'nut|almond|cashew|walnut|hazelnut|pistachio|pecan|مكسرات|لوز|جوز|بندق|كاجو|فستق'
    when 'milk'      then 'milk|dairy|lactose|cheese|yogh?urt|butter|cream|حليب|لبن|ألبان|البان|جبن|زبادي|لاكتوز'
    when 'eggs'      then 'egg|بيض'
    when 'wheat'     then 'wheat|gluten|flour|bread|قمح|جلوتين|غلوتين|دقيق|خبز'
    when 'soy'       then 'soy|صويا'
    when 'fish'      then 'fish|سمك|اسماك|أسماك'
    when 'shellfish' then 'shellfish|shrimp|prawn|crab|lobster|جمبري|روبيان|محار|كابوريا'
    when 'sesame'    then 'sesame|tahini|tahina|سمسم|طحينة|طحينه'
    else '^$a' end
$$;

-- The menu for a range of days. "affected" lists the children the caller may know about whose allergies match the dish:
-- a parent sees their own children, a teacher their class, management everyone.
create function public.menu_week(p_from date, p_to date)
returns table (menu_date date, meal text, dish_en text, dish_ar text, allergens text[], affected text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'Please choose up to two months'; end if;
  return query
    select m.menu_date, m.meal, m.dish_en, m.dish_ar, m.allergens,
           coalesce((select array_agg(distinct c.full_name order by c.full_name)
                       from public.children c join public.child_health h on h.child_id = c.id
                      where c.active and public.can_see_child(c.id) and public.auth_role() <> 'finance'
                        and exists (select 1 from unnest(m.allergens) a where public.cka_allergen_match(h.allergies, a))), '{}')
      from public.menu_items m where m.menu_date between p_from and p_to
     order by m.menu_date, case m.meal when 'breakfast' then 1 when 'lunch' then 2 else 3 end;
end $$;

create function public.menu_save(p_date date, p_meal text, p_en text, p_ar text, p_allergens text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_date is null or p_meal not in ('breakfast', 'lunch', 'snack') then raise exception 'Invalid request'; end if;
  if length(btrim(coalesce(p_en, ''))) = 0 and length(btrim(coalesce(p_ar, ''))) = 0 then
    delete from public.menu_items where menu_date = p_date and meal = p_meal;
    return;
  end if;
  if not (coalesce(p_allergens, '{}') <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'wheat', 'soy', 'fish', 'shellfish', 'sesame']) then raise exception 'Unknown allergen'; end if;
  insert into public.menu_items (menu_date, meal, dish_en, dish_ar, allergens, created_by)
  values (p_date, p_meal, nullif(btrim(coalesce(p_en, '')), ''), nullif(btrim(coalesce(p_ar, '')), ''), coalesce(p_allergens, '{}'), auth.uid())
  on conflict (menu_date, meal) do update set dish_en = excluded.dish_en, dish_ar = excluded.dish_ar, allergens = excluded.allergens, created_by = excluded.created_by;
end $$;

-- ---------------------------------------------------------------------------
-- Daily schedule
-- ---------------------------------------------------------------------------
create function public.schedule_save(p_id uuid, p_class uuid, p_time time, p_en text, p_ar text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_time is null or (length(btrim(coalesce(p_en, ''))) = 0 and length(btrim(coalesce(p_ar, ''))) = 0) then raise exception 'Please give a time and a title'; end if;
  if p_class is not null and not exists (select 1 from public.classes where id = p_class) then raise exception 'Not found'; end if;
  if rid is null then
    insert into public.schedule_items (class_id, start_time, title_en, title_ar) values (p_class, p_time, nullif(btrim(coalesce(p_en, '')), ''), nullif(btrim(coalesce(p_ar, '')), '')) returning id into rid;
  else
    update public.schedule_items set class_id = p_class, start_time = p_time, title_en = nullif(btrim(coalesce(p_en, '')), ''), title_ar = nullif(btrim(coalesce(p_ar, '')), '') where id = rid;
  end if;
  return rid;
end $$;

create function public.schedule_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.schedule_items where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Events and approvals
-- ---------------------------------------------------------------------------
create function public.cka_event_children(p_event uuid) returns table (child_id uuid)
language sql stable security definer set search_path = public as $$
  select c.id from public.events e join public.children c on c.active and (e.audience = 'all' or c.class_id = e.class_id) where e.id = p_event
$$;

create function public.event_save(p_id uuid, p_kind text, p_title_en text, p_title_ar text, p_details_en text, p_details_ar text, p_starts timestamptz, p_ends timestamptz,
                                  p_all_day boolean, p_place text, p_audience text, p_class uuid, p_cost numeric, p_needs_approval boolean, p_deadline timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id; s uuid; fresh boolean := false;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_kind not in ('event', 'closure', 'holiday', 'session') or p_audience not in ('all', 'class') then raise exception 'Invalid request'; end if;
  if p_audience = 'class' and not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;
  if p_starts is null then raise exception 'Please choose when it starts'; end if;
  if coalesce(p_needs_approval, false) and (p_deadline is null or p_deadline > p_starts) then raise exception 'Please choose an approval deadline before the event'; end if;
  if rid is null then
    rid := gen_random_uuid(); fresh := true;
    insert into public.events (id, kind, title_en, title_ar, details_en, details_ar, starts_at, ends_at, all_day, place, audience, class_id, cost, needs_approval, approval_deadline, created_by)
    values (rid, p_kind, nullif(btrim(coalesce(p_title_en, '')), ''), nullif(btrim(coalesce(p_title_ar, '')), ''), nullif(btrim(coalesce(p_details_en, '')), ''), nullif(btrim(coalesce(p_details_ar, '')), ''),
            p_starts, p_ends, coalesce(p_all_day, false), nullif(btrim(coalesce(p_place, '')), ''), p_audience, case when p_audience = 'class' then p_class end, p_cost,
            coalesce(p_needs_approval, false), case when coalesce(p_needs_approval, false) then p_deadline end, auth.uid());
  else
    update public.events set kind = p_kind, title_en = nullif(btrim(coalesce(p_title_en, '')), ''), title_ar = nullif(btrim(coalesce(p_title_ar, '')), ''),
           details_en = nullif(btrim(coalesce(p_details_en, '')), ''), details_ar = nullif(btrim(coalesce(p_details_ar, '')), ''), starts_at = p_starts, ends_at = p_ends,
           all_day = coalesce(p_all_day, false), place = nullif(btrim(coalesce(p_place, '')), ''), audience = p_audience, class_id = case when p_audience = 'class' then p_class end,
           cost = p_cost, needs_approval = coalesce(p_needs_approval, false), approval_deadline = case when coalesce(p_needs_approval, false) then p_deadline end
     where id = rid;
    if not found then raise exception 'Not found'; end if;
  end if;
  -- families are told about a new event, closure or holiday (sessions are only shown in the calendar)
  if fresh and p_kind <> 'session' then
    for s in select distinct pc.parent_id from public.cka_event_children(rid) k join public.parent_children pc on pc.child_id = k.child_id
              join public.profiles p on p.id = pc.parent_id and p.active loop
      perform public.cka_enqueue_email(s, 'event_new', jsonb_build_object('needs_approval', coalesce(p_needs_approval, false)), 'evnew:' || rid || ':' || s);
    end loop;
  end if;
  return rid;
end $$;

create function public.event_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.events where id = p_id;
end $$;

-- A parent answers yes or no for one child, until the deadline.
create function public.event_respond(p_event uuid, p_child uuid, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.events;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_answer not in ('yes', 'no') then raise exception 'Invalid request'; end if;
  select * into e from public.events where id = p_event;
  if e.id is null or not e.needs_approval then raise exception 'Not found'; end if;
  if not exists (select 1 from public.cka_event_children(p_event) k where k.child_id = p_child) then raise exception 'This event is not for your child'; end if;
  if public.cka_now() > e.approval_deadline then raise exception 'deadline_passed'; end if;
  insert into public.event_responses (event_id, child_id, answered_by, answer) values (p_event, p_child, auth.uid(), p_answer)
  on conflict (event_id, child_id) do update set answer = excluded.answer, answered_by = excluded.answered_by, answered_at = now();
end $$;

-- Admin: the live list of answers and missing answers.
create function public.event_responses_summary(p_event uuid)
returns table (child_id uuid, child_name text, class_name text, answer text, answered_by_name text, answered_at timestamptz, parents text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, coalesce(cl.name, ''), r.answer, p.full_name, r.answered_at,
         coalesce((select string_agg(pp.full_name, ', ' order by pp.full_name) from public.parent_children pc join public.profiles pp on pp.id = pc.parent_id where pc.child_id = c.id), '')
    from public.cka_event_children(p_event) k
    join public.children c on c.id = k.child_id
    left join public.classes cl on cl.id = c.class_id
    left join public.event_responses r on r.event_id = p_event and r.child_id = c.id
    left join public.profiles p on p.id = r.answered_by
   where public.is_management()
   order by (r.answer is null) desc, cl.name, c.full_name
$$;

-- ---------------------------------------------------------------------------
-- The scheduler (server only): reminders for unread important announcements and unanswered approvals
-- ---------------------------------------------------------------------------
create function public.cka_run_content_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; e record; s uuid; ann int := 0; ev int := 0; sent int := 0;
begin
  for a in select id from public.announcements where important and reminded_at is null and created_at <= p_now - interval '24 hours' loop
    for s in select * from public.cka_announcement_parents(a.id) u
              where not exists (select 1 from public.announcement_reads r where r.announcement_id = a.id and r.user_id = u) loop
      perform public.cka_enqueue_email(s, 'announcement_reminder', '{}'::jsonb, 'annrem:' || a.id || ':' || s);
      sent := sent + 1;
    end loop;
    update public.announcements set reminded_at = p_now where id = a.id;
    ann := ann + 1;
  end loop;
  for e in select id from public.events where needs_approval and reminded_at is null and approval_deadline > p_now and approval_deadline <= p_now + interval '24 hours' loop
    for s in select distinct pc.parent_id from public.cka_event_children(e.id) k join public.parent_children pc on pc.child_id = k.child_id
              join public.profiles p on p.id = pc.parent_id and p.active
              where not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = k.child_id) loop
      perform public.cka_enqueue_email(s, 'event_reminder', '{}'::jsonb, 'evrem:' || e.id || ':' || s);
      sent := sent + 1;
    end loop;
    update public.events set reminded_at = p_now where id = e.id;
    ev := ev + 1;
  end loop;
  return jsonb_build_object('announcements', ann, 'events', ev, 'emails', sent);
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_event_visible(text, uuid), public.cka_allergen_match(text, text), public.menu_week(date, date), public.menu_save(date, text, text, text, text[]),
  public.schedule_save(uuid, uuid, time, text, text), public.schedule_delete(uuid), public.cka_event_children(uuid),
  public.event_save(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, text, uuid, numeric, boolean, timestamptz),
  public.event_delete(uuid), public.event_respond(uuid, uuid, text), public.event_responses_summary(uuid), public.cka_run_content_check(timestamptz)
from public, anon, authenticated;
grant execute on function
  public.cka_event_visible(text, uuid), public.menu_week(date, date), public.menu_save(date, text, text, text, text[]),
  public.schedule_save(uuid, uuid, time, text, text), public.schedule_delete(uuid),
  public.event_save(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, text, uuid, numeric, boolean, timestamptz),
  public.event_delete(uuid), public.event_respond(uuid, uuid, text), public.event_responses_summary(uuid)
to authenticated;
grant execute on function public.cka_run_content_check(timestamptz) to service_role;

-- ============================================================
-- migrations/20261006121900_media.sql
-- ============================================================
-- Class photos and short videos (Prompt 15).
--
-- * Teachers upload to a class album (for a day or an event) and TAG the children who appear in each photo or video.
-- * A photo cannot be saved if it is tagged with a child whose parents did not agree to class photos.
-- * A parent sees only the photos and videos in which their own child is tagged, and can download them.
-- * Files live in a private bucket; they are only ever opened through short-lived links.
-- * Admin can remove anything. Items older than the retention period are archived (hidden, kept) or deleted, on a
--   schedule admin sets. Only admin or owner may mark an item "OK to post" on social media, and only if every child in
--   it has social media consent.

create table public.media_items (
  id                uuid primary key default gen_random_uuid(),
  class_id          uuid not null references public.classes (id),
  album_date        date not null,
  event_id          uuid references public.events (id) on delete set null,
  kind              text not null check (kind in ('photo', 'video')),
  storage_path      text not null unique,
  file_name         text,
  mime_type         text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm')),
  size_bytes        integer not null check (size_bytes > 0 and size_bytes <= 52428800),
  duration_seconds  integer check (duration_seconds between 1 and 60),
  uploaded_by       uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  ok_to_post        boolean not null default false,
  posted_marked_by  uuid references public.profiles (id),
  removed           boolean not null default false,
  removed_by        uuid references public.profiles (id),
  removed_at        timestamptz,
  archived          boolean not null default false,
  check ((kind = 'video') = (mime_type like 'video/%')),
  check (kind = 'video' or duration_seconds is null)
);
create index media_items_class_date_idx on public.media_items (class_id, album_date desc);

create table public.media_tags (
  media_id  uuid not null references public.media_items (id) on delete cascade,
  child_id  uuid not null references public.children (id),
  primary key (media_id, child_id)
);
create index media_tags_child_idx on public.media_tags (child_id);

-- One row: how long to keep items, and what happens then.
create table public.media_settings (
  id               boolean primary key default true check (id),
  retention_months integer check (retention_months between 1 and 120),      -- null = keep for ever
  action           text not null default 'delete' check (action in ('delete', 'archive')),
  updated_by       uuid references public.profiles (id)
);
insert into public.media_settings (id, retention_months) values (true, 12);

-- Who may see an item: management everything; a teacher their own class's (not removed); a parent only items that are
-- not removed or archived and in which one of their own children is tagged.
create function public.cka_media_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.media_items m where m.id = p_id and (
    public.is_management()
    or (public.auth_role() = 'teacher' and not m.removed and public.teaches_class(m.class_id))
    or (public.auth_role() = 'parent' and not m.removed and not m.archived
        and exists (select 1 from public.media_tags t where t.media_id = m.id and public.can_see_child(t.child_id)))))
$$;

alter table public.media_items    enable row level security;
alter table public.media_tags     enable row level security;
alter table public.media_settings enable row level security;
revoke all on public.media_items, public.media_tags, public.media_settings from anon, authenticated;
grant select on public.media_items, public.media_tags, public.media_settings to authenticated;
create policy media_select    on public.media_items    for select using (public.cka_media_visible(id));
-- a parent never learns which other children appear in a photo: only their own tags are readable
create policy media_tag_select on public.media_tags    for select using (public.cka_media_visible(media_id) and (public.auth_role() <> 'parent' or public.can_see_child(child_id)));
create policy media_set_select on public.media_settings for select using (public.is_management());

-- ---------------------------------------------------------------------------
-- Private storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('media', 'media', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];

-- Files are stored as  <class id>/<random>.<ext>
create function public.cka_media_class_of(p_path text) returns uuid
language sql immutable as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ((storage.foldername(p_path))[1])::uuid end
$$;
create function public.cka_media_upload_ok(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cka_media_class_of(p_path) is not null and (public.is_management() or public.teaches_class(public.cka_media_class_of(p_path))), false)
$$;
create function public.cka_media_file(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.media_items m where m.storage_path = p_path and public.cka_media_visible(m.id))
$$;
create policy media_file_upload on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.cka_media_upload_ok(name));
create policy media_file_read   on storage.objects for select to authenticated using (bucket_id = 'media' and (public.cka_media_file(name) or public.cka_media_upload_ok(name)));
-- a file that was never registered (for example the photo was blocked) can be taken back by whoever may upload to that class
create policy media_file_undo   on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.cka_media_upload_ok(name) and not exists (select 1 from public.media_items m where m.storage_path = name));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- Which of these children's parents did NOT agree to class photos? (so the teacher is warned before uploading)
create function public.media_consent_check(p_children uuid[]) returns table (child_id uuid, child_name text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name
    from public.children c left join public.child_consents k on k.child_id = c.id
   where c.id = any (p_children) and coalesce(k.photos_class, false) = false
     and public.auth_role() in ('admin', 'manager', 'owner', 'teacher') and public.can_see_child(c.id)
   order by c.full_name
$$;

create function public.cka_media_names(p_children uuid[], p_social boolean) returns text
language sql stable security definer set search_path = public as $$
  select string_agg(c.full_name, ', ' order by c.full_name)
    from public.children c left join public.child_consents k on k.child_id = c.id
   where c.id = any (p_children) and coalesce(case when p_social then k.photos_social else k.photos_class end, false) = false
$$;

create function public.media_add(p_id uuid, p_class uuid, p_event uuid, p_date date, p_kind text, p_path text, p_name text, p_mime text, p_size int, p_duration int, p_children uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare names text; c uuid;
begin
  if not (public.is_management() or public.teaches_class(p_class)) then raise exception 'Not allowed'; end if;
  if p_id is null or p_path is null or p_path not like p_class::text || '/%' or p_path like '%..%' then raise exception 'Invalid request'; end if;
  if p_kind not in ('photo', 'video') or (p_kind = 'video' and (p_duration is null or p_duration < 1)) then raise exception 'Invalid request'; end if;
  if p_kind = 'video' and p_duration > 60 then raise exception 'video_too_long'; end if;
  if p_children is null or cardinality(p_children) < 1 or cardinality(p_children) > 60 then raise exception 'tag_at_least_one'; end if;
  if p_date is null or p_date > public.cka_today() or p_date < public.cka_today() - 60 then raise exception 'Please choose a date in the last 60 days'; end if;
  if p_event is not null and not exists (select 1 from public.events where id = p_event) then raise exception 'Not found'; end if;
  foreach c in array p_children loop
    if not exists (select 1 from public.children where id = c and active) or not public.can_see_child(c) then raise exception 'Not allowed'; end if;
  end loop;
  names := public.cka_media_names(p_children, false);
  if names is not null then raise exception 'no_photo_consent: %', names; end if;
  insert into public.media_items (id, class_id, album_date, event_id, kind, storage_path, file_name, mime_type, size_bytes, duration_seconds, uploaded_by)
  values (p_id, p_class, p_date, p_event, p_kind, p_path, left(p_name, 200), p_mime, p_size, case when p_kind = 'video' then p_duration end, auth.uid());
  insert into public.media_tags (media_id, child_id) select p_id, x from unnest(p_children) x;
end $$;

-- Correct who is in a photo.
create function public.media_set_tags(p_id uuid, p_children uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare m public.media_items; names text; c uuid;
begin
  select * into m from public.media_items where id = p_id;
  if m.id is null or not (public.is_management() or public.teaches_class(m.class_id)) then raise exception 'Not allowed'; end if;
  if p_children is null or cardinality(p_children) < 1 or cardinality(p_children) > 60 then raise exception 'tag_at_least_one'; end if;
  foreach c in array p_children loop
    if not exists (select 1 from public.children where id = c and active) or not public.can_see_child(c) then raise exception 'Not allowed'; end if;
  end loop;
  names := public.cka_media_names(p_children, false);
  if names is not null then raise exception 'no_photo_consent: %', names; end if;
  if m.ok_to_post then
    names := public.cka_media_names(p_children, true);
    if names is not null then raise exception 'no_social_consent: %', names; end if;
  end if;
  delete from public.media_tags where media_id = p_id;
  insert into public.media_tags (media_id, child_id) select p_id, x from unnest(p_children) x;
end $$;

create function public.media_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  update public.media_items set removed = true, removed_by = auth.uid(), removed_at = now(), ok_to_post = false where id = p_id and not removed;
end $$;

-- Only admin or the owner may mark an item "OK to post", and only if every child in it agreed to social media.
create function public.media_mark_post(p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare names text; kids uuid[];
begin
  if not coalesce(public.auth_role() in ('admin', 'owner'), false) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.media_items where id = p_id and not removed) then raise exception 'Not found'; end if;
  if coalesce(p_ok, false) then
    select array_agg(child_id) into kids from public.media_tags where media_id = p_id;
    names := public.cka_media_names(kids, true);
    if names is not null then raise exception 'no_social_consent: %', names; end if;
  end if;
  update public.media_items set ok_to_post = coalesce(p_ok, false), posted_marked_by = case when coalesce(p_ok, false) then auth.uid() end where id = p_id;
end $$;

create function public.media_settings_save(p_months int, p_action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_action not in ('delete', 'archive') or (p_months is not null and p_months not between 1 and 120) then raise exception 'Invalid request'; end if;
  update public.media_settings set retention_months = p_months, action = p_action, updated_by = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Retention (server only). Removed items are purged after 30 days; old items are archived or deleted as set.
-- ---------------------------------------------------------------------------
create function public.cka_media_expired(p_now timestamptz default now()) returns table (id uuid, storage_path text, action text)
language sql stable security definer set search_path = public as $$
  select m.id, m.storage_path, 'delete'::text from public.media_items m where m.removed and m.removed_at <= p_now - interval '30 days'
  union all
  select m.id, m.storage_path, s.action
    from public.media_items m cross join public.media_settings s
   where not m.removed and not m.archived and s.retention_months is not null
     and m.album_date < ((p_now at time zone 'Africa/Cairo')::date - (s.retention_months || ' months')::interval)::date
$$;

create function public.cka_media_apply(p_ids uuid[], p_action text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_action = 'archive' then
    update public.media_items set archived = true, ok_to_post = false where id = any (p_ids) and not removed;
  elsif p_action = 'delete' then
    delete from public.media_items where id = any (p_ids);
  else raise exception 'Invalid request'; end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_media_visible(uuid), public.cka_media_class_of(text), public.cka_media_upload_ok(text), public.cka_media_file(text), public.media_consent_check(uuid[]),
  public.cka_media_names(uuid[], boolean), public.media_add(uuid, uuid, uuid, date, text, text, text, text, int, int, uuid[]), public.media_set_tags(uuid, uuid[]),
  public.media_remove(uuid), public.media_mark_post(uuid, boolean), public.media_settings_save(int, text), public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text)
from public, anon, authenticated;
grant execute on function
  public.cka_media_visible(uuid), public.cka_media_upload_ok(text), public.cka_media_file(text), public.media_consent_check(uuid[]),
  public.media_add(uuid, uuid, uuid, date, text, text, text, text, int, int, uuid[]), public.media_set_tags(uuid, uuid[]),
  public.media_remove(uuid), public.media_mark_post(uuid, boolean), public.media_settings_save(int, text)
to authenticated;
grant execute on function public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text) to service_role;

-- ============================================================
-- migrations/20261006122000_admin_area.sql
-- ============================================================
-- The admin area (Prompt 16): children, classes, staff roles, academy settings and "today at a glance".
--
-- * New staff job titles. Assistants and co-teachers work like teachers (they see only the classes they are given);
--   the two finance roles share ONE database role, "finance", that can open the attendance and overtime reports and
--   nothing else: never health details, never HR data, never cases.
-- * Admin moves children between classes and withdraws them (history is kept and parent access is switched off).
--   Every move and withdrawal is recorded with who did it and when, like every change to health, consent or pickup lists.
-- * Academy settings: phone, WhatsApp, email, address, and the closing time after which pickups count as overtime.

-- ---------------------------------------------------------------------------
-- Roles and titles
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('parent', 'teacher', 'admin', 'manager', 'owner', 'finance'));
alter table public.profiles add column job_title text
  check (job_title in ('teacher', 'co_teacher', 'assistant', 'admin', 'manager', 'owner', 'finance_assistant', 'finance_manager'));

alter table public.staff_classes add column class_role text not null default 'teacher' check (class_role in ('teacher', 'co_teacher', 'assistant'));
alter table public.classes add column capacity integer check (capacity between 1 and 100);
alter table public.child_change_log drop constraint child_change_log_kind_check;
alter table public.child_change_log add constraint child_change_log_kind_check check (kind in ('created', 'health', 'pickup', 'consent', 'contact', 'class', 'withdrawn', 'reinstated'));

-- ---------------------------------------------------------------------------
-- Academy settings (one row)
-- ---------------------------------------------------------------------------
create table public.academy_settings (
  id             boolean primary key default true check (id),
  phone          text check (length(phone) <= 40),
  whatsapp       text check (whatsapp ~ '^[0-9]{8,15}$'),               -- digits only, with the country code, for wa.me links
  email          text check (length(email) <= 254),
  address_en     text check (length(address_en) <= 300),
  address_ar     text check (length(address_ar) <= 300),
  overtime_close time not null default '18:00',
  updated_by     uuid references public.profiles (id)
);
insert into public.academy_settings (id, phone, email) values (true, '01063344389', 'Cutekidsacademyy@gmail.com');
alter table public.academy_settings enable row level security;
revoke all on public.academy_settings from anon, authenticated;
grant select on public.academy_settings to authenticated;
create policy academy_settings_select on public.academy_settings for select using (public.auth_role() is not null);

create function public.academy_settings_save(p_phone text, p_whatsapp text, p_email text, p_address_en text, p_address_ar text, p_overtime_close time) returns void
language plpgsql security definer set search_path = public as $$
declare wa text := nullif(regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g'), '');
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if (wa is not null and wa !~ '^[0-9]{8,15}$') or btrim(coalesce(p_whatsapp, '')) ~ '[^0-9+() -]' then raise exception 'Please check the WhatsApp number (digits with the country code, for example 201063344389)'; end if;
  if p_overtime_close is null or p_overtime_close < time '12:00' or p_overtime_close > time '22:00' then raise exception 'Please choose a closing time between 12:00 and 22:00'; end if;
  update public.academy_settings set phone = nullif(btrim(coalesce(p_phone, '')), ''), whatsapp = wa, email = nullif(btrim(coalesce(p_email, '')), ''),
         address_en = nullif(btrim(coalesce(p_address_en, '')), ''), address_ar = nullif(btrim(coalesce(p_address_ar, '')), ''), overtime_close = p_overtime_close, updated_by = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Today at a glance
-- ---------------------------------------------------------------------------
create function public.admin_home() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare day date := public.cka_today(); l time := (public.cka_now() at time zone 'Africa/Cairo')::time; out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'date', day,
    'children', (select count(*) from public.children where active),
    'present', (select count(*) from public.attendance where att_date = day),
    'absent_reported', (select count(*) from public.attendance_notices n where n.notice_date = day and n.kind = 'absence'
                          and not exists (select 1 from public.attendance a where a.child_id = n.child_id and a.att_date = day)),
    'not_arrived', case when public.cka_is_work_day(day) and l >= time '09:30' and l < time '18:00' then
                     (select count(*) from public.children c where c.active and c.class_id is not null
                        and not exists (select 1 from public.attendance a where a.child_id = c.id and a.att_date = day)
                        and not exists (select 1 from public.attendance_notices n where n.child_id = c.id and n.notice_date = day)) else 0 end,
    'reports_sent', (select count(*) from public.daily_reports r where r.report_date = day and r.status = 'sent'),
    'reports_ready', (select count(*) from public.daily_reports r where r.report_date = day and r.status = 'draft' and public.cka_report_has_content(r)),
    'unread_important', (select count(*) from public.announcements a where a.important and a.created_at > public.cka_now() - interval '14 days'
                           and exists (select 1 from public.cka_announcement_parents(a.id) u where not exists (select 1 from public.announcement_reads r where r.announcement_id = a.id and r.user_id = u))),
    'events_waiting', (select count(*) from public.events e where e.needs_approval and e.approval_deadline > public.cka_now()
                         and exists (select 1 from public.cka_event_children(e.id) k where not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = k.child_id))),
    'cases_open', (select count(*) from public.submissions s where s.status in ('received', 'acknowledged', 'in_progress')),
    'cases_critical', (select count(*) from public.submissions s where s.status in ('received', 'acknowledged', 'in_progress') and s.urgency = 'critical'),
    'cases_overdue', (select count(*) from public.submissions s where (s.status = 'received' and s.acknowledge_by < public.cka_now()) or (s.status in ('acknowledged', 'in_progress') and s.resolve_by < public.cka_now())),
    'applications_new', (select count(*) from public.registration_applications where status in ('new', 'missing_documents', 'tour_booked'))
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Children
-- ---------------------------------------------------------------------------
create function public.cka_parent_access(p_parent uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when not p.active then 'off' when u.last_sign_in_at is null then 'invited' else 'active' end
    from public.profiles p left join auth.users u on u.id = p.id where p.id = p_parent
$$;

create function public.admin_children()
returns table (child_id uuid, child_name text, date_of_birth date, class_id uuid, class_name text, active boolean, has_allergy boolean, parents jsonb)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, c.date_of_birth, c.class_id, cl.name, c.active,
         coalesce(nullif(btrim(h.allergies), '') is not null, false),
         coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'phone', p.phone, 'access', public.cka_parent_access(p.id)) order by p.full_name)
                     from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = c.id), '[]')
    from public.children c left join public.classes cl on cl.id = c.class_id left join public.child_health h on h.child_id = c.id
   where public.is_management()
   order by c.active desc, c.full_name
$$;

create function public.admin_child_profile(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'child', jsonb_build_object('id', c.id, 'name', c.full_name, 'date_of_birth', c.date_of_birth, 'active', c.active, 'class_id', c.class_id, 'class_name', cl.name, 'enrolled_since', c.created_at),
    'parents', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'phone', p.phone, 'email', u.email, 'access', public.cka_parent_access(p.id), 'language', p.language) order by p.full_name)
                from public.parent_children pc join public.profiles p on p.id = pc.parent_id left join auth.users u on u.id = p.id where pc.child_id = c.id), '[]'),
    'pickups', coalesce((select jsonb_agg(jsonb_build_object('name', k.full_name, 'relationship', k.relationship, 'phone', k.phone, 'has_id_photo', k.id_photo_path is not null) order by k.full_name)
                from public.child_pickups k where k.child_id = c.id and k.active), '[]'),
    'health', (select to_jsonb(h) - 'child_id' - 'updated_by' from public.child_health h where h.child_id = c.id),
    'consents', (select to_jsonb(k) - 'child_id' - 'updated_by' from public.child_consents k where k.child_id = c.id),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'file_name', d.file_name, 'path', d.storage_path)) from public.child_documents d where d.child_id = c.id), '[]'),
    'log', coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'summary', g.summary, 'by', g.changed_by_name, 'at', g.created_at) order by g.created_at desc)
                from (select * from public.child_change_log where child_id = c.id order by created_at desc limit 40) g), '[]')
  ) into out from public.children c left join public.classes cl on cl.id = c.class_id where c.id = p_child;
  return out;
end $$;

create function public.child_move_class(p_child uuid, p_class uuid) returns void
language plpgsql security definer set search_path = public as $$
declare oldc text; newc text;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select name into newc from public.classes where id = p_class;
  if newc is null then raise exception 'Choose a class'; end if;
  select coalesce(cl.name, '-') into oldc from public.children c left join public.classes cl on cl.id = c.class_id where c.id = p_child and c.active;
  if oldc is null then raise exception 'Not found'; end if;
  if oldc = newc then return; end if;
  update public.children set class_id = p_class where id = p_child;
  perform public.cka_log_child_change(p_child, 'class', 'Moved from ' || oldc || ' to ' || newc, oldc, newc);
end $$;

-- Withdraw: the child is switched off (everything is kept) and parents who have no other child at the academy lose access.
create function public.child_withdraw(p_child uuid, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare why text := btrim(coalesce(p_reason, '')); n int;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(why) < 3 then raise exception 'Please write the reason'; end if;
  update public.children set active = false where id = p_child and active;
  if not found then raise exception 'Not found'; end if;
  update public.profiles p set active = false
   where p.role = 'parent' and p.active and p.id in (select parent_id from public.parent_children where child_id = p_child)
     and not exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id and c.active where pc.parent_id = p.id);
  get diagnostics n = row_count;
  perform public.cka_log_child_change(p_child, 'withdrawn', 'Withdrawn: ' || why, null, null);
  return n;
end $$;

create function public.child_reinstate(p_child uuid, p_class uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;
  update public.children set active = true, class_id = p_class where id = p_child and not active;
  if not found then raise exception 'Not found'; end if;
  update public.profiles set active = true where role = 'parent' and id in (select parent_id from public.parent_children where child_id = p_child);
  perform public.cka_log_child_change(p_child, 'reinstated', 'Re-enrolled', null, null);
end $$;

-- ---------------------------------------------------------------------------
-- Classes and who works in them
-- ---------------------------------------------------------------------------
create function public.admin_classes()
returns table (class_id uuid, name text, age_group text, capacity int, head_teacher_id uuid, head_teacher_name text, enrolled int, present_today int, staff jsonb)
language sql stable security definer set search_path = public as $$
  select cl.id, cl.name, cl.age_group, cl.capacity, cl.head_teacher_id, h.full_name,
         (select count(*)::int from public.children c where c.class_id = cl.id and c.active),
         (select count(*)::int from public.children c join public.attendance a on a.child_id = c.id and a.att_date = public.cka_today() where c.class_id = cl.id),
         coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'class_role', sc.class_role, 'job_title', p.job_title, 'active', p.active) order by p.full_name)
                     from public.staff_classes sc join public.profiles p on p.id = sc.staff_id where sc.class_id = cl.id), '[]')
    from public.classes cl left join public.profiles h on h.id = cl.head_teacher_id
   where public.is_management()
   order by cl.name
$$;

create function public.class_save(p_id uuid, p_name text, p_age_group text, p_capacity int) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(btrim(coalesce(p_age_group, ''))) < 1 then raise exception 'Please give the class a name and an age range'; end if;
  if p_capacity is not null and p_capacity not between 1 and 100 then raise exception 'Please check the capacity'; end if;
  if rid is null then insert into public.classes (name, age_group, capacity) values (btrim(p_name), btrim(p_age_group), p_capacity) returning id into rid;
  else update public.classes set name = btrim(p_name), age_group = btrim(p_age_group), capacity = p_capacity where id = rid; if not found then raise exception 'Not found'; end if; end if;
  return rid;
end $$;

-- p_role: head (the class's head teacher), teacher, co_teacher or assistant. Only teaching-type staff can be given a class.
create function public.class_staff_set(p_class uuid, p_staff uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_role not in ('head', 'teacher', 'co_teacher', 'assistant') then raise exception 'Invalid request'; end if;
  if not exists (select 1 from public.classes where id = p_class) then raise exception 'Not found'; end if;
  if not exists (select 1 from public.profiles where id = p_staff and role = 'teacher' and active) then raise exception 'Only teaching staff can be given a class'; end if;
  insert into public.staff_classes (staff_id, class_id, class_role) values (p_staff, p_class, case when p_role = 'head' then 'teacher' else p_role end)
  on conflict (staff_id, class_id) do update set class_role = excluded.class_role;
  if p_role = 'head' then update public.classes set head_teacher_id = p_staff where id = p_class; end if;
end $$;

create function public.class_staff_remove(p_class uuid, p_staff uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.staff_classes where class_id = p_class and staff_id = p_staff;
  update public.classes set head_teacher_id = null where id = p_class and head_teacher_id = p_staff;
end $$;

-- A staff member's job title (shown in the lists). Only manager or owner; the owner's and manager's titles stay as they are.
create function public.staff_job_title_save(p_staff uuid, p_title text) returns void
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  select role into r from public.profiles where id = p_staff;
  if r is null or r in ('parent', 'owner', 'manager') then raise exception 'Not allowed'; end if;
  if not ((r = 'teacher' and p_title in ('teacher', 'co_teacher', 'assistant')) or (r = 'finance' and p_title in ('finance_assistant', 'finance_manager')) or (r = 'admin' and p_title = 'admin')) then
    raise exception 'That title does not fit this role';
  end if;
  update public.profiles set job_title = p_title where id = p_staff;
end $$;

-- Replaced with small changes: the overtime closing time is now a setting; the finance role may open the attendance and overtime report.
create or replace function public.door_check_out(p_child uuid, p_pickup uuid default null, p_name text default null, p_relationship text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  day date := public.cka_today(); t timestamptz := public.cka_now();
  a public.attendance; pk public.child_pickups; ot int; is_off boolean := false; nm text; rel text; note text := nullif(btrim(coalesce(p_note, '')), ''); s uuid;
begin
  if not public.cka_door_allowed(p_child) then raise exception 'Not allowed'; end if;
  select * into a from public.attendance where child_id = p_child and att_date = day for update;
  if a.id is null then raise exception 'This child has not been checked in today'; end if;
  if a.checked_out_at is not null then raise exception 'Already checked out'; end if;

  if p_pickup is not null then
    select * into pk from public.child_pickups where id = p_pickup and child_id = p_child and active;
    if pk.id is null then raise exception 'That person is not on this child''s pickup list'; end if;
    nm := pk.full_name; rel := pk.relationship;
  else
    nm := btrim(coalesce(p_name, '')); rel := btrim(coalesce(p_relationship, ''));
    if length(nm) < 2 or length(rel) < 2 then raise exception 'off_list_needs_details'; end if;
    if note is null or length(note) < 3 then raise exception 'off_list_needs_parent_approval'; end if;
    is_off := true;
  end if;

  ot := greatest(0, floor(extract(epoch from (t - ((day + (select overtime_close from public.academy_settings)) at time zone 'Africa/Cairo'))) / 60))::int;
  update public.attendance
     set checked_out_at = t, checked_out_by = auth.uid(), collector_pickup_id = pk.id, collector_name = nm, collector_relationship = rel,
         off_list = is_off, off_list_note = case when is_off then note end, overtime_minutes = ot
   where id = a.id;
  perform public.cka_att_log(p_child, day, case when is_off then 'check_out_off_list' else 'check_out' end, nm || ' (' || rel || ')' || coalesce(': ' || note, ''));

  if is_off then
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
      perform public.cka_enqueue_email(s, 'pickup_off_list_parent', jsonb_build_object('child_id', p_child), 'offlist:' || a.id || ':' || s);
    end loop;
    for s in select * from public.cka_class_staff_and_admins(p_child) loop
      perform public.cka_enqueue_email(s, 'pickup_off_list_staff', jsonb_build_object('child_id', p_child), 'offlist:' || a.id || ':' || s);
    end loop;
  end if;
  return jsonb_build_object('checked_out_at', t, 'overtime_minutes', ot, 'off_list', is_off);
end $$;

create or replace function public.attendance_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cutoff date; out jsonb;
begin
  if not (public.is_management() or coalesce(public.auth_role() = 'finance', false)) then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Please choose a period of up to one year'; end if;
  -- days still in progress are not counted as "not reported": only completed days (today counts after closing time)
  cutoff := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then public.cka_today() else public.cka_today() - 1 end;
  with kids as (
    select c.id, c.full_name, c.class_id, coalesce(cl.name, '') as class_name, (c.created_at at time zone 'Africa/Cairo')::date as since
      from public.children c left join public.classes cl on cl.id = c.class_id where c.active
  ), days as (
    select k.id as child_id, g::date as d from kids k, generate_series(p_from, least(p_to, cutoff), interval '1 day') g
     where public.cka_is_work_day(g::date) and g::date >= k.since
  ), per as (
    select k.id as child_id, k.full_name, k.class_id, k.class_name,
           (select count(*) from days x where x.child_id = k.id)::int as school_days,
           (select count(*) from days x join public.attendance a on a.child_id = x.child_id and a.att_date = x.d where x.child_id = k.id)::int as present_days,
           (select count(*) from days x join public.attendance_notices n on n.child_id = x.child_id and n.notice_date = x.d and n.kind = 'absence'
              where x.child_id = k.id and not exists (select 1 from public.attendance a where a.child_id = x.child_id and a.att_date = x.d))::int as absent_reported,
           (select count(*) from public.attendance_notices n where n.child_id = k.id and n.kind = 'late' and n.notice_date between p_from and p_to)::int as late_notices,
           (select coalesce(sum(a.overtime_minutes), 0) from public.attendance a where a.child_id = k.id and a.att_date between p_from and p_to)::int as overtime_minutes,
           (select count(*) from public.attendance a where a.child_id = k.id and a.att_date between p_from and p_to and a.overtime_minutes > 0)::int as overtime_days
      from kids k
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'by_child', coalesce((select jsonb_agg(jsonb_build_object('child_id', child_id, 'child_name', full_name, 'class_name', class_name, 'school_days', school_days,
          'present_days', present_days, 'absent_reported', absent_reported, 'not_reported', greatest(0, school_days - present_days - absent_reported),
          'late_notices', late_notices, 'overtime_minutes', overtime_minutes) order by class_name, full_name) from per), '[]'),
    'by_class', coalesce((select jsonb_agg(x order by x ->> 'class_name') from (
        select jsonb_build_object('class_name', class_name, 'children', count(*), 'school_days', sum(school_days), 'present_days', sum(present_days),
               'absent_reported', sum(absent_reported), 'not_reported', sum(greatest(0, school_days - present_days - absent_reported)),
               'late_notices', sum(late_notices), 'overtime_minutes', sum(overtime_minutes)) as x
          from per group by class_name) q), '[]'),
    'overtime', coalesce((select jsonb_agg(jsonb_build_object('child_id', child_id, 'child_name', full_name, 'class_name', class_name, 'days', overtime_days, 'minutes', overtime_minutes,
          'parents', coalesce((select string_agg(p.full_name, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = per.child_id), ''))
          order by overtime_minutes desc, full_name) from per where overtime_minutes > 0), '[]')
  ) into out;
  return out;
end $$;

-- Fix for projects that already ran the daily-reports migration: an account that was switched off could call report_send (it sent nothing, but it should be refused).
create or replace function public.report_send(p_children uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); r record; n int := 0;
begin
  if not coalesce(public.auth_role() in ('admin', 'manager', 'owner', 'teacher'), false) then raise exception 'Not allowed'; end if;
  for r in select * from public.daily_reports d where d.report_date = day and d.status = 'draft' and public.cka_report_has_content(d)
              and (p_children is null or d.child_id = any (p_children)) and public.cka_door_allowed(d.child_id) loop
    perform public.cka_report_send_one(r.id, auth.uid());
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.academy_settings_save(text, text, text, text, text, time), public.admin_home(), public.cka_parent_access(uuid), public.admin_children(), public.admin_child_profile(uuid),
  public.child_move_class(uuid, uuid), public.child_withdraw(uuid, text), public.child_reinstate(uuid, uuid), public.admin_classes(), public.class_save(uuid, text, text, int),
  public.class_staff_set(uuid, uuid, text), public.class_staff_remove(uuid, uuid), public.staff_job_title_save(uuid, text)
from public, anon, authenticated;
grant execute on function
  public.academy_settings_save(text, text, text, text, text, time), public.admin_home(), public.admin_children(), public.admin_child_profile(uuid),
  public.child_move_class(uuid, uuid), public.child_withdraw(uuid, text), public.child_reinstate(uuid, uuid), public.admin_classes(), public.class_save(uuid, text, text, int),
  public.class_staff_set(uuid, uuid, text), public.class_staff_remove(uuid, uuid), public.staff_job_title_save(uuid, text)
to authenticated;

-- ============================================================
-- migrations/20261006122100_questions.sql
-- ============================================================
-- Questions and missing items (Prompt 17, with Prompt 21).
--
-- A parent can now ask a question (topic: fees, schedule, food, my child's day, other) or report a missing item, in
-- addition to complaints and safety concerns. Both become portal cases with the "can wait" promise unless the parent
-- picks "urgent", land in the staff queue, and are emailed to the academy's inbox and to the admins. Replies from
-- staff reach the parent in the portal and by email, exactly like any other case.

alter table public.submissions drop constraint submissions_type_check;
alter table public.submissions add constraint submissions_type_check check (type in ('complaint', 'safety_concern', 'question', 'missing_item'));
alter table public.submissions add column topic text check (topic in ('fees', 'schedule', 'food', 'my_childs_day', 'other'));

drop policy submissions_parent_insert on public.submissions;
create policy submissions_parent_insert on public.submissions for insert
  with check (public.auth_role() = 'parent' and parent_id = auth.uid() and public.can_see_child(child_id)
              and type in ('complaint', 'safety_concern', 'question', 'missing_item'));

-- Parents may not pick Critical for a question or a missing item either (the trigger already refused it for complaints).
create or replace function public.cka_submission_before_insert() returns trigger
language plpgsql as $$
declare d record;
begin
  -- The client never decides these; the database does.
  new.created_at := now();
  new.updated_at := now();
  new.status := 'received';
  new.acknowledged_at := null;
  new.resolved_at := null;
  new.parent_satisfied := null;

  if public.auth_role() = 'parent' then
    new.parent_id := auth.uid();
    new.assigned_to := null;
    if new.urgency = 'critical' and new.type in ('complaint', 'question', 'missing_item') then
      raise exception 'Parents choose Urgent or Can wait; Critical is set automatically for safety concerns';
    end if;
  end if;

  if new.type = 'safety_concern' then
    new.urgency := 'critical';
    new.escalation_level := 3;
  elsif new.about_staff_member is not null then
    new.escalation_level := 3;      -- complaint about a named staff member goes straight to the manager
  else
    new.escalation_level := 1;
  end if;

  select * into d from public.cka_deadlines(new.urgency, new.created_at);
  new.acknowledge_by := d.acknowledge_by;
  new.resolve_by := d.resolve_by;
  return new;
end $$;

-- Tell the academy about a new question or missing item: the inbox address (if set) and every admin.
create function public.cka_notify_question_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; u uuid; payload jsonb;
begin
  payload := jsonb_build_object('id', new.id, 'ref_no', new.ref_no, 'title', new.title, 'urgency', new.urgency, 'type', new.type, 'topic', new.topic,
    'parent_name', (select full_name from public.profiles where id = new.parent_id), 'child_name', (select full_name from public.children where id = new.child_id),
    'text', left(new.description, 1500));
  select email into a from public.academy_settings;
  if a is not null and public.cka_is_email(a) then perform public.cka_enqueue_email_address(a, 'en', 'question_new', payload, 'qnew:' || new.id || ':inbox'); end if;
  for u in select id from public.profiles where role = 'admin' and active loop
    perform public.cka_enqueue_email(u, 'question_new', payload, 'qnew:' || new.id || ':' || u);
  end loop;
  return new;
end $$;
create trigger submissions_after_insert_question after insert on public.submissions
  for each row when (new.type in ('question', 'missing_item')) execute function public.cka_notify_question_insert();

-- This month at a glance, for one of the parent's own children: days attended, days absent (told us / not told us), late pickups.
create function public.parent_month_summary(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := public.cka_today(); first date := date_trunc('month', public.cka_today())::date; since date; last_day date; att int; rep int; unrep int; late int; days int;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  select greatest(first, (created_at at time zone 'Africa/Cairo')::date) into since from public.children where id = p_child;
  last_day := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then today else today - 1 end;
  select count(*) into att from public.attendance where child_id = p_child and att_date between first and today;
  select count(*) into late from public.attendance where child_id = p_child and att_date between first and today and overtime_minutes > 0;
  select count(*) into days from generate_series(since, last_day, interval '1 day') g where public.cka_is_work_day(g::date);
  select count(*) into rep from generate_series(since, last_day, interval '1 day') g
   where public.cka_is_work_day(g::date) and not exists (select 1 from public.attendance a where a.child_id = p_child and a.att_date = g::date)
     and exists (select 1 from public.attendance_notices n where n.child_id = p_child and n.notice_date = g::date and n.kind = 'absence');
  unrep := greatest(0, days - (select count(*) from public.attendance a where a.child_id = p_child and a.att_date between since and last_day) - rep);
  return jsonb_build_object('attended', att, 'absent_reported', rep, 'absent_unreported', unrep, 'late_pickups', late);
end $$;

revoke all on function public.cka_notify_question_insert(), public.parent_month_summary(uuid) from public, anon, authenticated;
grant execute on function public.parent_month_summary(uuid) to authenticated;

-- ============================================================
-- migrations/20261006122200_absences_approvals.sql
-- ============================================================
-- Absence tracker and 3-day follow-up (Prompt 18 as changed by Prompt 21), approval reminders and call list (Prompt 19),
-- messages from the academy, and turning an email into a portal case (Prompt 17).
--
-- * An absence is a school day (Sunday to Thursday, not a closure or holiday in the calendar) on which the child was not
--   checked in. It is "reported" when a parent (or admin, recording what a parent told them) said so, with a reason.
-- * Each morning at 10:00, any child absent 3 or more school days in a row (and not here today) gets a check-in task for
--   admin, due that day. Admin sends a caring message (portal + email) and records the outcome. If it is not sent by 18:00
--   it escalates to the manager and owner. "Considering leaving" alerts the owner at once. No reply after 2 more school
--   days: a second reminder task, then a phone-call task.
-- * Event approvals: a reminder 24 hours after the request, another the day before the deadline (never more than one a
--   day, none once answered); on the deadline day unanswered families join admin's call list; after the deadline the
--   child is "no answer" (treated as not approved).

-- ---------------------------------------------------------------------------
-- School days
-- ---------------------------------------------------------------------------
create function public.cka_is_school_day(p_date date, p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.cka_is_work_day(p_date) and not exists (
    select 1 from public.events e
     where e.kind in ('closure', 'holiday') and (e.audience = 'all' or e.class_id = p_class)
       and p_date between (e.starts_at at time zone 'Africa/Cairo')::date and (coalesce(e.ends_at, e.starts_at) at time zone 'Africa/Cairo')::date)
$$;

alter table public.attendance_notices add column parent_reported boolean not null default true;

-- Admin records an absence (for example a parent phoned), saying whether a parent reported it and why.
create function public.absence_add(p_child uuid, p_date date, p_parent_reported boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare cls uuid; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select class_id into cls from public.children where id = p_child and active;
  if not found then raise exception 'Not found'; end if;
  if p_date is null or p_date > public.cka_today() then raise exception 'Please choose today or an earlier day'; end if;
  if not public.cka_is_school_day(p_date, cls) then raise exception 'That day is not a school day'; end if;
  if exists (select 1 from public.attendance where child_id = p_child and att_date = p_date) then raise exception 'This child was checked in that day'; end if;
  if coalesce(p_parent_reported, false) and (why is null or length(why) < 2) then raise exception 'Please write the reason the parent gave'; end if;
  insert into public.attendance_notices (child_id, notice_date, kind, reason, reported_by, reported_by_role, parent_reported)
  values (p_child, p_date, 'absence', coalesce(why, 'Recorded by admin: no report from the parent'), auth.uid(), 'admin', coalesce(p_parent_reported, false))
  on conflict (child_id, notice_date) do update set kind = 'absence', reason = excluded.reason, reported_by = excluded.reported_by, reported_by_role = 'admin',
         parent_reported = excluded.parent_reported, reported_at = now();
  perform public.cka_att_log(p_child, p_date, 'absence_recorded', why);
end $$;

-- ---------------------------------------------------------------------------
-- The tracker
-- ---------------------------------------------------------------------------
create function public.cka_absence_streak(p_child uuid, p_upto date) returns table (days int, start_on date)
language plpgsql stable security definer set search_path = public as $$
declare d date := p_upto; n int := 0; first_day date; cls uuid; since date; guard int := 0;
begin
  select class_id, (created_at at time zone 'Africa/Cairo')::date into cls, since from public.children where id = p_child;
  while d >= since and guard < 120 loop
    guard := guard + 1;
    if public.cka_is_school_day(d, cls) then
      if exists (select 1 from public.attendance where child_id = p_child and att_date = d) then exit; end if;
      n := n + 1; first_day := d;
    end if;
    d := d - 1;
  end loop;
  return query select n, first_day;
end $$;

create function public.absence_tracker(p_from date, p_to date)
returns table (child_id uuid, child_name text, class_name text, absent_days int, reported_days int, not_reported_days int, streak int, last_attended date, last_reason text)
language plpgsql stable security definer set search_path = public as $$
declare k record; last_day date;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Please choose a period of up to one year'; end if;
  last_day := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then public.cka_today() else public.cka_today() - 1 end;
  for k in select c.id, c.full_name, c.class_id, coalesce(cl.name, '') as cname, (c.created_at at time zone 'Africa/Cairo')::date as since
             from public.children c left join public.classes cl on cl.id = c.class_id where c.active order by cl.name nulls last, c.full_name loop
    child_id := k.id; child_name := k.full_name; class_name := k.cname;
    select count(*)::int, count(*) filter (where n.id is not null and n.parent_reported)::int, count(*) filter (where n.id is null or not n.parent_reported)::int
      into absent_days, reported_days, not_reported_days
      from generate_series(greatest(p_from, k.since)::timestamp, least(p_to, last_day)::timestamp, interval '1 day') g
      left join public.attendance_notices n on n.child_id = k.id and n.notice_date = g::date and n.kind = 'absence'
     where public.cka_is_school_day(g::date, k.class_id) and not exists (select 1 from public.attendance a where a.child_id = k.id and a.att_date = g::date);
    select s.days into streak from public.cka_absence_streak(k.id, last_day) s;
    select max(a.att_date) into last_attended from public.attendance a where a.child_id = k.id and a.att_date <= public.cka_today();
    select n.reason into last_reason from public.attendance_notices n where n.child_id = k.id and n.kind = 'absence' and n.notice_date <= public.cka_today() order by n.notice_date desc limit 1;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Messages from the academy to a parent (shown in the portal; an email says there is one)
-- ---------------------------------------------------------------------------
create table public.parent_messages (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.profiles (id),
  child_id    uuid references public.children (id),
  kind        text not null check (kind in ('followup', 'birthday', 'academy')),
  body        text not null check (length(body) between 1 and 2000),
  sent_by     uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index parent_messages_parent_idx on public.parent_messages (parent_id, created_at desc);
alter table public.parent_messages enable row level security;
revoke all on public.parent_messages from anon, authenticated;
grant select on public.parent_messages to authenticated;
create policy pm_select on public.parent_messages for select using (parent_id = auth.uid() and public.auth_role() = 'parent' or public.is_management());

create function public.parent_message_read(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'parent' then return; end if;
  update public.parent_messages set read_at = now() where id = p_id and parent_id = auth.uid() and read_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- Follow-up tasks
-- ---------------------------------------------------------------------------
create table public.absence_followups (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  kind            text not null check (kind in ('check_in', 'reminder', 'call')),
  streak_start    date not null,
  streak_days     integer not null,
  due_date        date not null,
  created_at      timestamptz not null default now(),
  message         text,
  message_sent_at timestamptz,
  message_sent_by uuid references public.profiles (id),
  outcome         text check (outcome in ('parent_replied', 'returning', 'considering_leaving', 'no_reply')),
  return_date     date,
  outcome_note    text,
  outcome_at      timestamptz,
  outcome_by      uuid references public.profiles (id),
  escalated_at    timestamptz,
  closed_at       timestamptz,
  closed_reason   text,
  unique (child_id, streak_start, kind)
);
alter table public.absence_followups enable row level security;
revoke all on public.absence_followups from anon, authenticated;
grant select on public.absence_followups to authenticated;
create policy followups_select on public.absence_followups for select using (public.is_management());

create function public.absence_followup_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb; today date := public.cka_today(); late boolean := (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00';
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'child_id', c.id, 'child_name', c.full_name, 'class_name', coalesce(cl.name, ''), 'streak_days', f.streak_days, 'streak_start', f.streak_start,
      'due_date', f.due_date, 'overdue', (f.closed_at is null and f.message_sent_at is null and (f.due_date < today or (f.due_date = today and late))),
      'message_sent_at', f.message_sent_at, 'message', f.message, 'outcome', f.outcome, 'return_date', f.return_date, 'escalated_at', f.escalated_at, 'closed_at', f.closed_at,
      'reasons', coalesce((select jsonb_agg(jsonb_build_object('date', n.notice_date, 'reason', n.reason, 'reported', n.parent_reported) order by n.notice_date)
                             from public.attendance_notices n where n.child_id = c.id and n.kind = 'absence' and n.notice_date >= f.streak_start and n.notice_date <= today), '[]'),
      'parents', coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'phone', p.phone, 'language', p.language) order by p.full_name)
                             from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = c.id), '[]'))
      order by (f.closed_at is not null), f.due_date, f.created_at), '[]')
    into out
    from public.absence_followups f join public.children c on c.id = f.child_id left join public.classes cl on cl.id = c.class_id
   where f.closed_at is null or f.closed_at > public.cka_now() - interval '14 days';
  return out;
end $$;

-- Admin sends the check-in (portal message + an email telling the parent there is one).
create function public.followup_send(p_id uuid, p_message text) returns int
language plpgsql security definer set search_path = public as $$
declare f public.absence_followups; msg text := btrim(coalesce(p_message, '')); s uuid; n int := 0;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select * into f from public.absence_followups where id = p_id for update;
  if f.id is null then raise exception 'Not found'; end if;
  if f.closed_at is not null then raise exception 'This task is closed'; end if;
  if length(msg) < 10 then raise exception 'Please write the message'; end if;
  for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = f.child_id loop
    insert into public.parent_messages (parent_id, child_id, kind, body, sent_by) values (s, f.child_id, 'followup', left(msg, 2000), auth.uid());
    perform public.cka_enqueue_email(s, 'academy_message', '{}'::jsonb, 'fmsg:' || f.id || ':' || s || ':' || extract(epoch from public.cka_now())::bigint);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'This child has no parent with access'; end if;
  update public.absence_followups set message = left(msg, 2000), message_sent_at = coalesce(message_sent_at, public.cka_now()), message_sent_by = coalesce(message_sent_by, auth.uid()) where id = p_id;
  perform public.cka_att_log(f.child_id, public.cka_today(), 'followup_sent', f.kind);
  return n;
end $$;

create function public.followup_outcome(p_id uuid, p_outcome text, p_return date, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.absence_followups; o uuid;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_outcome not in ('parent_replied', 'returning', 'considering_leaving', 'no_reply') then raise exception 'Invalid request'; end if;
  select * into f from public.absence_followups where id = p_id for update;
  if f.id is null then raise exception 'Not found'; end if;
  if f.closed_at is not null then raise exception 'This task is closed'; end if;
  if f.message_sent_at is null then raise exception 'Send the check-in message first'; end if;
  if p_outcome = 'returning' and (p_return is null or p_return < public.cka_today() - 1) then raise exception 'Please give the date the child will return'; end if;
  update public.absence_followups set outcome = p_outcome, return_date = case when p_outcome = 'returning' then p_return end, outcome_note = nullif(btrim(coalesce(p_note, '')), ''),
         outcome_at = public.cka_now(), outcome_by = auth.uid(), closed_at = case when p_outcome = 'no_reply' then null else public.cka_now() end,
         closed_reason = case when p_outcome = 'no_reply' then null else p_outcome end where id = p_id;
  if p_outcome = 'considering_leaving' then
    for o in select id from public.profiles where role in ('owner', 'manager') and active loop
      perform public.cka_enqueue_email(o, 'followup_leaving', jsonb_build_object('child_id', f.child_id), 'leaving:' || f.id || ':' || o);
    end loop;
  end if;
end $$;

-- Numbers for the owner: follow-ups this period, how many were sent on time, and how they ended.
create function public.absence_followup_stats(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'created', count(*), 'sent', count(*) filter (where message_sent_at is not null),
    'on_time', count(*) filter (where message_sent_at is not null and (message_sent_at at time zone 'Africa/Cairo')::date <= due_date and (message_sent_at at time zone 'Africa/Cairo')::time < time '18:00'),
    'escalated', count(*) filter (where escalated_at is not null), 'open', count(*) filter (where closed_at is null),
    'parent_replied', count(*) filter (where outcome = 'parent_replied'), 'returning', count(*) filter (where outcome = 'returning'),
    'considering_leaving', count(*) filter (where outcome = 'considering_leaving'), 'no_reply', count(*) filter (where outcome = 'no_reply')) into out
    from public.absence_followups where created_at::date between p_from and p_to;
  return out;
end $$;

-- The 10:00 check, the 18:00 escalation and the second and third steps (server only; the scheduler runs it every 15 minutes).
create function public.cka_run_absence_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; day date := l::date; k record; st record; fu record; made int := 0; escalated int := 0; next_made int := 0; closed int := 0; ins int; adm uuid; own uuid;
begin
  if not public.cka_is_work_day(day) then return jsonb_build_object('checked', false); end if;
  -- 1. 10:00: new check-in tasks
  if l::time >= time '10:00' then
    for k in select c.id from public.children c where c.active and c.class_id is not null and public.cka_is_school_day(day, c.class_id)
                and not exists (select 1 from public.attendance att where att.child_id = c.id and att.att_date = day) loop
      select * into st from public.cka_absence_streak(k.id, day - 1);
      if st.days >= 3 then
        insert into public.absence_followups (child_id, kind, streak_start, streak_days, due_date, created_at) values (k.id, 'check_in', st.start_on, st.days, day, p_now) on conflict do nothing;
        get diagnostics ins = row_count; made := made + ins;
      end if;
    end loop;
    if made > 0 then
      for adm in select id from public.profiles where role = 'admin' and active loop
        perform public.cka_enqueue_email(adm, 'absence_task', jsonb_build_object('count', made), 'abstask:' || day || ':' || adm || ':' || (extract(epoch from p_now)::bigint / 900));
      end loop;
    end if;
  end if;
  -- 2. a child who came back closes the task
  update public.absence_followups x set closed_at = p_now, closed_reason = 'returned'
   where x.closed_at is null and exists (select 1 from public.attendance att where att.child_id = x.child_id and att.att_date >= (x.created_at at time zone 'Africa/Cairo')::date);
  get diagnostics closed = row_count;
  -- 3. second and third steps: no reply after 2 more school days
  for fu in select * from public.absence_followups x where x.closed_at is null and x.message_sent_at is not null and x.kind in ('check_in', 'reminder')
              and (x.outcome is null or x.outcome = 'no_reply') loop
    if (select count(*) from generate_series(((fu.message_sent_at at time zone 'Africa/Cairo')::date + 1)::timestamp, (day - 1)::timestamp, interval '1 day') g
         where public.cka_is_school_day(g::date, (select class_id from public.children where id = fu.child_id))) >= 2 then
      insert into public.absence_followups (child_id, kind, streak_start, streak_days, due_date, created_at)
      values (fu.child_id, case fu.kind when 'check_in' then 'reminder' else 'call' end, fu.streak_start, fu.streak_days, day, p_now) on conflict do nothing;
      get diagnostics ins = row_count;
      if ins > 0 then
        update public.absence_followups set closed_at = p_now, closed_reason = 'next_step' where id = fu.id;
        next_made := next_made + 1;
      end if;
    end if;
  end loop;
  -- 4. 18:00: tasks still without a message go up to the manager and owner
  if l::time >= time '18:00' then
    for fu in select id from public.absence_followups where closed_at is null and message_sent_at is null and due_date <= day and escalated_at is null loop
      update public.absence_followups set escalated_at = p_now where id = fu.id;
      for own in select id from public.profiles where role in ('manager', 'owner') and active loop
        perform public.cka_enqueue_email(own, 'absence_escalated', jsonb_build_object('task', fu.id), 'absesc:' || fu.id || ':' || own);
      end loop;
      escalated := escalated + 1;
    end loop;
  end if;
  return jsonb_build_object('checked', true, 'created', made, 'next_steps', next_made, 'closed', closed, 'escalated', escalated);
end $$;

-- ---------------------------------------------------------------------------
-- Approval reminders and the call list
-- ---------------------------------------------------------------------------
create table public.approval_reminders (
  event_id  uuid not null references public.events (id) on delete cascade,
  parent_id uuid not null references public.profiles (id),
  kind      text not null check (kind in ('after_24h', 'day_before')),
  sent_at   timestamptz not null default now(),
  primary key (event_id, parent_id, kind)
);
create table public.approval_calls (
  event_id  uuid not null references public.events (id) on delete cascade,
  child_id  uuid not null references public.children (id),
  added_at  timestamptz not null default now(),
  called_at timestamptz,
  called_by uuid references public.profiles (id),
  note      text,
  primary key (event_id, child_id)
);
alter table public.approval_reminders enable row level security;
alter table public.approval_calls     enable row level security;
revoke all on public.approval_reminders, public.approval_calls from anon, authenticated;
grant select on public.approval_reminders, public.approval_calls to authenticated;
create policy appr_rem_select on public.approval_reminders for select using (public.is_management());
create policy appr_call_select on public.approval_calls for select using (public.is_management());

create function public.approval_call_log(p_event uuid, p_child uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_note, ''))) < 2 then raise exception 'Please write what the parent said'; end if;
  update public.approval_calls set called_at = public.cka_now(), called_by = auth.uid(), note = btrim(p_note) where event_id = p_event and child_id = p_child;
  if not found then raise exception 'Not found'; end if;
end $$;

-- The list of families to phone today (deadline day, still no answer).
create function public.approval_call_list() returns table (event_id uuid, event_title text, child_id uuid, child_name text, class_name text, parents text, phones text, called_at timestamptz, note text)
language sql stable security definer set search_path = public as $$
  select e.id, coalesce(nullif(e.title_en, ''), e.title_ar), c.id, c.full_name, coalesce(cl.name, ''),
         coalesce((select string_agg(p.full_name, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = c.id), ''),
         coalesce((select string_agg(p.phone, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = c.id and p.phone is not null), ''),
         k.called_at, k.note
    from public.approval_calls k join public.events e on e.id = k.event_id join public.children c on c.id = k.child_id left join public.classes cl on cl.id = c.class_id
   where public.is_management() and c.active and e.approval_deadline > public.cka_now() - interval '1 day'
     and not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = c.id)
   order by (k.called_at is not null), e.approval_deadline, c.full_name
$$;

-- Per child: yes, no, waiting, or "no answer" once the deadline has passed (treated as not approved), plus the reminders sent.
drop function public.event_responses_summary(uuid);
create function public.event_responses_summary(p_event uuid)
returns table (child_id uuid, child_name text, class_name text, answer text, answered_by_name text, answered_at timestamptz, parents text, status text, reminders int, last_reminder timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, coalesce(cl.name, ''), r.answer, p.full_name, r.answered_at,
         coalesce((select string_agg(pp.full_name, ', ' order by pp.full_name) from public.parent_children pc join public.profiles pp on pp.id = pc.parent_id where pc.child_id = c.id), ''),
         case when r.answer is not null then r.answer when e.approval_deadline < public.cka_now() then 'no_answer' else 'waiting' end,
         (select count(*)::int from public.approval_reminders ar join public.parent_children pc on pc.parent_id = ar.parent_id where ar.event_id = e.id and pc.child_id = c.id),
         (select max(ar.sent_at) from public.approval_reminders ar join public.parent_children pc on pc.parent_id = ar.parent_id where ar.event_id = e.id and pc.child_id = c.id)
    from public.events e
    join public.cka_event_children(e.id) k on true
    join public.children c on c.id = k.child_id
    left join public.classes cl on cl.id = c.class_id
    left join public.event_responses r on r.event_id = e.id and r.child_id = c.id
    left join public.profiles p on p.id = r.answered_by
   where e.id = p_event and public.is_management()
   order by (r.answer is null) desc, cl.name, c.full_name
$$;

create or replace function public.cka_run_content_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; e record; s uuid; ann int := 0; ev int := 0; calls int := 0; sent int := 0; ins int; today date := (p_now at time zone 'Africa/Cairo')::date; dl date; rkind text;
begin
  for a in select id from public.announcements where important and reminded_at is null and created_at <= p_now - interval '24 hours' loop
    for s in select * from public.cka_announcement_parents(a.id) u
              where not exists (select 1 from public.announcement_reads r where r.announcement_id = a.id and r.user_id = u) loop
      perform public.cka_enqueue_email(s, 'announcement_reminder', '{}'::jsonb, 'annrem:' || a.id || ':' || s);
      sent := sent + 1;
    end loop;
    update public.announcements set reminded_at = p_now where id = a.id;
    ann := ann + 1;
  end loop;

  for e in select id, created_at, approval_deadline from public.events where needs_approval and approval_deadline > p_now loop
    dl := (e.approval_deadline at time zone 'Africa/Cairo')::date;
    -- the deadline day: families with no answer join the call list
    if today = dl then
      insert into public.approval_calls (event_id, child_id) select e.id, k.child_id from public.cka_event_children(e.id) k
       where not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = k.child_id) on conflict do nothing;
      get diagnostics ins = row_count; calls := calls + ins;
    end if;
    -- reminders: 24 hours after the request, and the day before the deadline; never more than one a day; none once answered
    rkind := case when today = dl - 1 then 'day_before' when e.created_at <= p_now - interval '24 hours' and today < dl then 'after_24h' end;
    continue when rkind is null;
    ins := 0;
    for s in select distinct pc.parent_id from public.cka_event_children(e.id) k join public.parent_children pc on pc.child_id = k.child_id
              join public.profiles p on p.id = pc.parent_id and p.active
              where not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = k.child_id)
                and not exists (select 1 from public.approval_reminders ar where ar.event_id = e.id and ar.parent_id = pc.parent_id and (ar.kind = rkind or (ar.sent_at at time zone 'Africa/Cairo')::date = today)) loop
      insert into public.approval_reminders (event_id, parent_id, kind, sent_at) values (e.id, s, rkind, p_now) on conflict do nothing;
      perform public.cka_enqueue_email(s, 'event_reminder', '{}'::jsonb, 'evrem:' || e.id || ':' || s || ':' || today);
      sent := sent + 1; ins := ins + 1;
    end loop;
    if ins > 0 then ev := ev + 1; end if;
  end loop;
  return jsonb_build_object('announcements', ann, 'events', ev, 'emails', sent, 'calls_added', calls);
end $$;

-- ---------------------------------------------------------------------------
-- An email that reached the academy's inbox becomes a portal case in one click
-- ---------------------------------------------------------------------------
create function public.admin_parent_search(p_q text) returns table (parent_id uuid, parent_name text, phone text, email text, children jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.phone, u.email,
         coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.full_name) order by c.full_name) from public.parent_children pc join public.children c on c.id = pc.child_id and c.active where pc.parent_id = p.id), '[]')
    from public.profiles p left join auth.users u on u.id = p.id
   where public.is_management() and p.role = 'parent' and p.active and length(btrim(coalesce(p_q, ''))) >= 2
     and (p.full_name ilike '%' || btrim(p_q) || '%' or coalesce(u.email, '') ilike '%' || btrim(p_q) || '%' or coalesce(p.phone, '') like '%' || btrim(p_q) || '%'
          or exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id where pc.parent_id = p.id and c.full_name ilike '%' || btrim(p_q) || '%'))
   order by p.full_name limit 20
$$;

create function public.case_from_email(p_parent uuid, p_child uuid, p_title text, p_description text, p_urgency text, p_sender text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := gen_random_uuid(); who text := nullif(btrim(coalesce(p_sender, '')), '');
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_urgency not in ('urgent', 'can_wait') then raise exception 'Choose Urgent or Can wait'; end if;
  if length(btrim(coalesce(p_title, ''))) < 3 or length(btrim(coalesce(p_description, ''))) < 3 then raise exception 'Please give a title and the message'; end if;
  if not exists (select 1 from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active and p.role = 'parent' where pc.parent_id = p_parent and pc.child_id = p_child) then raise exception 'That parent is not linked to that child'; end if;
  insert into public.submissions (id, parent_id, child_id, type, topic, title, description, urgency)
  values (rid, p_parent, p_child, 'question', 'other', left(btrim(p_title), 150), 'By email' || coalesce(' from ' || who, '') || E':\n' || btrim(p_description), p_urgency);
  return rid;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_is_school_day(date, uuid), public.absence_add(uuid, date, boolean, text), public.cka_absence_streak(uuid, date), public.absence_tracker(date, date), public.parent_message_read(uuid),
  public.absence_followup_list(), public.followup_send(uuid, text), public.followup_outcome(uuid, text, date, text), public.absence_followup_stats(date, date), public.cka_run_absence_check(timestamptz),
  public.approval_call_log(uuid, uuid, text), public.approval_call_list(), public.event_responses_summary(uuid), public.cka_run_content_check(timestamptz),
  public.admin_parent_search(text), public.case_from_email(uuid, uuid, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.absence_add(uuid, date, boolean, text), public.absence_tracker(date, date), public.parent_message_read(uuid), public.absence_followup_list(), public.followup_send(uuid, text),
  public.followup_outcome(uuid, text, date, text), public.absence_followup_stats(date, date), public.approval_call_log(uuid, uuid, text), public.approval_call_list(), public.event_responses_summary(uuid),
  public.admin_parent_search(text), public.case_from_email(uuid, uuid, text, text, text, text)
to authenticated;
grant execute on function public.cka_run_content_check(timestamptz), public.cka_run_absence_check(timestamptz) to service_role;

-- ============================================================
-- migrations/20261006122300_payments.sql
-- ============================================================
-- Payments: fee plans, monthly charges, InstaPay payments confirmed by finance, late fees, receipts (Prompt 20).
--
-- Who sees money: the family (their own children only), the finance role, and the owner. Never teachers, never other families.
-- (Admin and manager can read the settings, such as the InstaPay address, to help a parent, but see no amounts.)
-- InstaPay does not tell the system when someone has paid. The parent enters the transaction reference (and may attach a
-- screenshot); finance matches it against the bank statement and confirms or rejects it. A confirmed payment gets a numbered receipt.
-- Late fees are OFF until the owner switches them on (after the fee policy states the amount and grace period).

create table public.payment_settings (
  id              boolean primary key default true check (id),
  due_day         integer not null default 1 check (due_day between 1 and 28),
  grace_days      integer not null default 5 check (grace_days between 0 and 28),
  late_fees_on    boolean not null default false,
  late_fee_kind   text not null default 'fixed' check (late_fee_kind in ('fixed', 'percent')),
  late_fee_value  numeric(10, 2) not null default 0 check (late_fee_value >= 0),
  reminder_days   integer[] not null default '{25,1,5}',
  overtime_rate   numeric(10, 2) not null default 0 check (overtime_rate >= 0),     -- EGP for each started 15 minutes
  instapay_ipa    text check (length(instapay_ipa) <= 100),
  instapay_link   text check (instapay_link ~ '^https://' and length(instapay_link) <= 500),
  bank_details    text check (length(bank_details) <= 600),
  updated_by      uuid references public.profiles (id)
);
insert into public.payment_settings (id) values (true);

create table public.fee_plans (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  programme       text not null check (programme in ('nursery', 'preschool', 'after_school', 'camp')),
  monthly_amount  numeric(10, 2) not null check (monthly_amount >= 0),
  starts_on       date not null,
  ends_on         date,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index fee_plans_child_idx on public.fee_plans (child_id, starts_on desc);

create table public.charges (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  month           date not null check (month = date_trunc('month', month)::date),
  kind            text not null check (kind in ('tuition', 'overtime', 'event', 'transport', 'late_fee', 'other')),
  description     text not null check (length(btrim(description)) between 2 and 200),
  amount          numeric(10, 2) not null check (amount > 0),
  source_ref      text unique,
  removed         boolean not null default false,
  waived          boolean not null default false,
  waived_by       uuid references public.profiles (id),
  waived_reason   text,
  waived_at       timestamptz,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index charges_child_month_idx on public.charges (child_id, month);

create sequence public.payment_receipt_seq;
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  month           date not null check (month = date_trunc('month', month)::date),
  amount          numeric(10, 2) not null check (amount > 0),
  method          text not null check (method in ('instapay', 'cash', 'bank_transfer')),
  reference       text check (length(btrim(reference)) between 4 and 60),
  screenshot_path text,
  status          text not null default 'waiting' check (status in ('waiting', 'confirmed', 'rejected')),
  submitted_by    uuid references public.profiles (id),
  submitted_at    timestamptz not null default now(),
  decided_by      uuid references public.profiles (id),
  decided_at      timestamptz,
  reject_reason   text,
  receipt_no      bigint unique
);
create unique index payments_reference_uq on public.payments (lower(btrim(reference))) where status <> 'rejected' and reference is not null;
create index payments_child_month_idx on public.payments (child_id, month);

create table public.payment_log (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid references public.children (id),
  action      text not null,
  note        text,
  actor_id    uuid references public.profiles (id),
  actor_name  text,
  created_at  timestamptz not null default now()
);

-- Who may see a child's money: the finance role, the owner, and that child's own parents.
create function public.cka_pay_access(p_child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() in ('finance', 'owner') or (public.auth_role() = 'parent' and public.can_see_child(p_child)), false)
$$;
create function public.cka_pay_staff() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.auth_role() in ('finance', 'owner'), false) $$;

alter table public.payment_settings enable row level security;
alter table public.fee_plans        enable row level security;
alter table public.charges          enable row level security;
alter table public.payments         enable row level security;
alter table public.payment_log      enable row level security;
revoke all on public.payment_settings, public.fee_plans, public.charges, public.payments, public.payment_log from anon, authenticated;
grant select on public.payment_settings, public.fee_plans, public.charges, public.payments, public.payment_log to authenticated;
create policy pay_settings_select on public.payment_settings for select using (public.auth_role() in ('parent', 'finance', 'owner', 'admin', 'manager'));
create policy fee_plans_select    on public.fee_plans        for select using (public.cka_pay_access(child_id));
create policy charges_select      on public.charges          for select using (public.cka_pay_access(child_id) and not removed);
create policy payments_select     on public.payments         for select using (public.cka_pay_access(child_id));
create policy pay_log_select      on public.payment_log      for select using (public.cka_pay_staff());

-- Screenshots of transfers: private; the family can add to their own child's folder; finance, owner and the family can read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('payments', 'payments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
create function public.cka_pay_file_ok(p_path text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (case when p_write then coalesce(public.auth_role() = 'parent' and public.can_see_child(((storage.foldername(p_path))[1])::uuid), false)
                         else public.cka_pay_access(((storage.foldername(p_path))[1])::uuid) end) else false end
$$;
create policy pay_file_read   on storage.objects for select to authenticated using (bucket_id = 'payments' and public.cka_pay_file_ok(name, false));
create policy pay_file_upload on storage.objects for insert to authenticated with check (bucket_id = 'payments' and public.cka_pay_file_ok(name, true));

create function public.cka_pay_log(p_child uuid, p_action text, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into public.payment_log (child_id, action, note, actor_id, actor_name) values (p_child, p_action, p_note, auth.uid(), public.cka_actor_name())
$$;

-- ---------------------------------------------------------------------------
-- Settings and fee plans
-- ---------------------------------------------------------------------------
create function public.payment_settings_save(p_due_day int, p_grace int, p_late_on boolean, p_late_kind text, p_late_value numeric, p_reminder_days int[], p_overtime_rate numeric,
                                             p_ipa text, p_link text, p_bank text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'owner' then raise exception 'Only the owner can change the payment settings'; end if;
  if p_due_day not between 1 and 28 or p_grace not between 0 and 28 or p_late_kind not in ('fixed', 'percent') or coalesce(p_late_value, 0) < 0 or coalesce(p_overtime_rate, 0) < 0 then raise exception 'Please check the numbers'; end if;
  if p_late_kind = 'percent' and p_late_value > 100 then raise exception 'A percentage cannot be more than 100'; end if;
  if p_reminder_days is null or exists (select 1 from unnest(p_reminder_days) d where d not between 1 and 28) or cardinality(p_reminder_days) > 6 then raise exception 'Reminder days must be days of the month (1 to 28)'; end if;
  if nullif(btrim(coalesce(p_link, '')), '') is not null and p_link !~ '^https://' then raise exception 'The payment link must start with https://'; end if;
  update public.payment_settings set due_day = p_due_day, grace_days = p_grace, late_fees_on = coalesce(p_late_on, false), late_fee_kind = p_late_kind, late_fee_value = coalesce(p_late_value, 0),
         reminder_days = p_reminder_days, overtime_rate = coalesce(p_overtime_rate, 0), instapay_ipa = nullif(btrim(coalesce(p_ipa, '')), ''), instapay_link = nullif(btrim(coalesce(p_link, '')), ''),
         bank_details = nullif(btrim(coalesce(p_bank, '')), ''), updated_by = auth.uid();
  perform public.cka_pay_log(null, 'settings_changed', null);
end $$;

create function public.fee_plan_save(p_child uuid, p_programme text, p_amount numeric, p_starts date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_programme not in ('nursery', 'preschool', 'after_school', 'camp') or p_amount is null or p_amount < 0 or p_starts is null then raise exception 'Please check the plan'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  update public.fee_plans set ends_on = p_starts - 1 where child_id = p_child and ends_on is null and starts_on < p_starts;
  delete from public.fee_plans where child_id = p_child and starts_on = p_starts;
  insert into public.fee_plans (child_id, programme, monthly_amount, starts_on, created_by) values (p_child, p_programme, p_amount, p_starts, auth.uid());
  perform public.cka_pay_log(p_child, 'fee_plan', p_programme || ' ' || p_amount || ' from ' || p_starts);
end $$;

-- ---------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------
create function public.charge_add(p_child uuid, p_month date, p_kind text, p_description text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_kind not in ('tuition', 'transport', 'event', 'other') then raise exception 'Choose the kind of charge'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 or length(btrim(coalesce(p_description, ''))) < 2 or p_month is null then raise exception 'Please check the charge'; end if;
  if not exists (select 1 from public.children where id = p_child) then raise exception 'Not found'; end if;
  insert into public.charges (child_id, month, kind, description, amount, created_by) values (p_child, date_trunc('month', p_month)::date, p_kind, btrim(p_description), p_amount, auth.uid()) returning id into rid;
  perform public.cka_pay_log(p_child, 'charge_added', p_kind || ' ' || p_amount);
  return rid;
end $$;

create function public.charge_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.charges;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  select * into c from public.charges where id = p_id and not removed;
  if c.id is null then raise exception 'Not found'; end if;
  if c.kind = 'late_fee' then raise exception 'A late fee can only be waived by the owner'; end if;
  update public.charges set removed = true where id = p_id;
  perform public.cka_pay_log(c.child_id, 'charge_removed', c.kind || ' ' || c.amount);
end $$;

create function public.late_fee_waive(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.charges;
begin
  if public.auth_role() <> 'owner' then raise exception 'Only the owner can waive a late fee'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write the reason'; end if;
  select * into c from public.charges where id = p_id and kind = 'late_fee' and not removed and not waived;
  if c.id is null then raise exception 'Not found'; end if;
  update public.charges set waived = true, waived_by = auth.uid(), waived_reason = btrim(p_reason), waived_at = now() where id = p_id;
  perform public.cka_pay_log(c.child_id, 'late_fee_waived', btrim(p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Balances (the parent sees their own children's; finance and the owner see everyone's)
-- ---------------------------------------------------------------------------
create function public.cka_balances(p_child uuid default null)
returns table (child_id uuid, month date, charges numeric, paid numeric, waiting numeric, balance numeric, due_date date, grace_end date, overdue boolean)
language sql stable security definer set search_path = public as $$
  with m as (
    select c.child_id, c.month from public.charges c where not c.removed
    union select p.child_id, p.month from public.payments p
  ), s as (select due_day, grace_days from public.payment_settings)
  select m.child_id, m.month,
         coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0),
         coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0),
         coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'waiting'), 0),
         coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0)
           - coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0),
         (m.month + (s.due_day - 1))::date, (m.month + (s.due_day - 1) + s.grace_days)::date,
         (public.cka_today() > (m.month + (s.due_day - 1) + s.grace_days)::date
            and coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0)
              - coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0) > 0)
    from m cross join s
   where (p_child is null or m.child_id = p_child)
   order by m.month desc
$$;

create function public.payment_balances(p_child uuid default null)
returns table (child_id uuid, month date, charges numeric, paid numeric, waiting numeric, balance numeric, due_date date, grace_end date, overdue boolean)
language sql stable security definer set search_path = public as $$
  select * from public.cka_balances(p_child) b where public.cka_pay_access(b.child_id)
$$;

-- Finance and the owner: every family for one month.
create function public.payments_month(p_month date)
returns table (child_id uuid, child_name text, class_name text, parents text, programme text, charges numeric, paid numeric, waiting numeric, balance numeric, status text)
language sql stable security definer set search_path = public as $$
  with mm as (select date_trunc('month', coalesce(p_month, public.cka_today()))::date as m)
  select c.id, c.full_name, coalesce(cl.name, ''),
         coalesce((select string_agg(p.full_name, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = c.id), ''),
         (select fp.programme from public.fee_plans fp where fp.child_id = c.id and fp.starts_on <= (select m from mm) and (fp.ends_on is null or fp.ends_on >= (select m from mm)) order by fp.starts_on desc limit 1),
         b.charges, b.paid, b.waiting, b.balance,
         case when b.charges = 0 and b.paid = 0 and b.waiting = 0 then 'none' when b.balance <= 0 then 'paid' when b.waiting >= b.balance then 'waiting'
              when public.cka_today() > (select m from mm) + (s.due_day - 1) + s.grace_days then 'overdue' else 'due' end
    from public.children c
    left join public.classes cl on cl.id = c.class_id
    cross join public.payment_settings s
    left join lateral (select coalesce(x.charges, 0) as charges, coalesce(x.paid, 0) as paid, coalesce(x.waiting, 0) as waiting, coalesce(x.balance, 0) as balance
                         from (select 1) d left join (select * from public.payment_balances(c.id) pb where pb.month = (select m from mm)) x on true) b on true
   where public.cka_pay_staff() and c.active
   order by c.full_name
$$;

create function public.payments_list(p_month date)
returns table (id uuid, child_id uuid, child_name text, month date, amount numeric, method text, reference text, screenshot_path text, status text, submitted_by_name text, submitted_at timestamptz, decided_at timestamptz, reject_reason text, receipt_no bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.child_id, c.full_name, p.month, p.amount, p.method, p.reference, p.screenshot_path, p.status, sb.full_name, p.submitted_at, p.decided_at, p.reject_reason, p.receipt_no
    from public.payments p join public.children c on c.id = p.child_id left join public.profiles sb on sb.id = p.submitted_by
   where public.cka_pay_staff() and (p_month is null or p.month = date_trunc('month', p_month)::date)
   order by (p.status = 'waiting') desc, p.submitted_at desc
$$;

-- ---------------------------------------------------------------------------
-- Paying
-- ---------------------------------------------------------------------------
create function public.payment_submit(p_child uuid, p_month date, p_amount numeric, p_reference text, p_screenshot text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid; ref text := btrim(coalesce(p_reference, '')); mo date := date_trunc('month', p_month)::date; f uuid;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Please check the amount'; end if;
  if length(ref) < 4 or length(ref) > 60 then raise exception 'Please enter the transaction reference from your bank app'; end if;
  if mo < date_trunc('month', public.cka_today())::date - interval '12 months' or mo > date_trunc('month', public.cka_today())::date + interval '1 month' then raise exception 'Please choose a recent month'; end if;
  if p_screenshot is not null and (p_screenshot not like p_child::text || '/%' or p_screenshot like '%..%') then raise exception 'Invalid file'; end if;
  if (select count(*) from public.payments where child_id = p_child and status = 'waiting') >= 5 then raise exception 'You already have payments waiting for confirmation'; end if;
  if exists (select 1 from public.payments where lower(btrim(reference)) = lower(ref) and status <> 'rejected') then raise exception 'reference_used'; end if;
  insert into public.payments (child_id, month, amount, method, reference, screenshot_path, submitted_by) values (p_child, mo, p_amount, 'instapay', ref, nullif(p_screenshot, ''), auth.uid()) returning id into rid;
  for f in select id from public.profiles where role in ('finance', 'owner') and active loop
    perform public.cka_enqueue_email(f, 'payment_waiting', '{}'::jsonb, 'paywait:' || rid || ':' || f);
  end loop;
  return rid;
end $$;

create function public.cka_pay_notify_parents(p_child uuid, p_template text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
    perform public.cka_enqueue_email(s, p_template, '{}'::jsonb, p_key || ':' || s);
  end loop;
end $$;

create function public.payment_confirm(p_id uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare p public.payments; n bigint;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  select * into p from public.payments where id = p_id for update;
  if p.id is null then raise exception 'Not found'; end if;
  if p.status <> 'waiting' then raise exception 'This payment has already been decided'; end if;
  n := nextval('public.payment_receipt_seq');
  update public.payments set status = 'confirmed', decided_by = auth.uid(), decided_at = now(), receipt_no = n where id = p_id;
  perform public.cka_pay_log(p.child_id, 'payment_confirmed', 'receipt ' || n || ' ' || p.amount);
  perform public.cka_pay_notify_parents(p.child_id, 'payment_confirmed', 'payok:' || p_id);
  return n;
end $$;

create function public.payment_reject(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.payments;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write the reason'; end if;
  select * into p from public.payments where id = p_id for update;
  if p.id is null then raise exception 'Not found'; end if;
  if p.status <> 'waiting' then raise exception 'This payment has already been decided'; end if;
  update public.payments set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reject_reason = btrim(p_reason) where id = p_id;
  perform public.cka_pay_log(p.child_id, 'payment_rejected', btrim(p_reason));
  perform public.cka_pay_notify_parents(p.child_id, 'payment_rejected', 'payno:' || p_id);
end $$;

-- Cash or a bank transfer received at the office: recorded and confirmed at once.
create function public.payment_record(p_child uuid, p_month date, p_amount numeric, p_method text, p_reference text) returns bigint
language plpgsql security definer set search_path = public as $$
declare rid uuid; n bigint; ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_method not in ('cash', 'bank_transfer') or p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_month is null then raise exception 'Please check the payment'; end if;
  if ref is not null and length(ref) < 4 then raise exception 'The reference is too short'; end if;
  if not exists (select 1 from public.children where id = p_child) then raise exception 'Not found'; end if;
  n := nextval('public.payment_receipt_seq');
  insert into public.payments (child_id, month, amount, method, reference, status, submitted_by, decided_by, decided_at, receipt_no)
  values (p_child, date_trunc('month', p_month)::date, p_amount, p_method, ref, 'confirmed', auth.uid(), auth.uid(), now(), n) returning id into rid;
  perform public.cka_pay_log(p_child, 'payment_recorded', p_method || ' ' || p_amount || ' receipt ' || n);
  perform public.cka_pay_notify_parents(p_child, 'payment_confirmed', 'payok:' || rid);
  return n;
end $$;

create function public.payment_receipt(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  select jsonb_build_object('receipt_no', p.receipt_no, 'child_name', c.full_name, 'month', p.month, 'amount', p.amount, 'method', p.method, 'reference', p.reference, 'confirmed_at', p.decided_at,
         'parents', coalesce((select string_agg(pp.full_name, ', ' order by pp.full_name) from public.parent_children pc join public.profiles pp on pp.id = pc.parent_id where pc.child_id = c.id), ''),
         'academy', (select jsonb_build_object('phone', phone, 'email', email, 'address_en', address_en, 'address_ar', address_ar) from public.academy_settings)) into out
    from public.payments p join public.children c on c.id = p.child_id where p.id = p_id and p.status = 'confirmed' and public.cka_pay_access(p.child_id);
  return out;
end $$;

-- The owner's view: expected against collected, overdue families, and the late fees added and waived.
create function public.payments_owner_summary(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare mo date := date_trunc('month', coalesce(p_month, public.cka_today()))::date; out jsonb;
begin
  if public.auth_role() <> 'owner' then raise exception 'Not allowed'; end if;
  select jsonb_build_object('month', mo,
    'expected', coalesce((select sum(amount) from public.charges where month = mo and not removed and not waived), 0),
    'collected', coalesce((select sum(amount) from public.payments where month = mo and status = 'confirmed'), 0),
    'waiting', coalesce((select sum(amount) from public.payments where month = mo and status = 'waiting'), 0),
    'overdue_families', (select count(*) from public.payments_month(mo) where status = 'overdue'),
    'late_fees_added', coalesce((select sum(amount) from public.charges where month = mo and kind = 'late_fee' and not removed), 0),
    'late_fees_waived', coalesce((select sum(amount) from public.charges where month = mo and kind = 'late_fee' and waived), 0)) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- The monthly routine (server only): tuition, overtime, reminders and late fees
-- ---------------------------------------------------------------------------
create function public.cka_run_billing(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; today date := l::date; cur date := date_trunc('month', l)::date; nxt date := (date_trunc('month', l) + interval '1 month')::date; prev date := (date_trunc('month', l) - interval '1 month')::date;
        s public.payment_settings; k record; mo date; ins int; tuition int := 0; ot int := 0; rem int := 0; lf int := 0; par uuid; amt numeric; minutes int;
begin
  select * into s from public.payment_settings;
  -- 1. tuition: this month, and next month from the 25th on (so families see what is coming)
  foreach mo in array case when extract(day from today) >= 25 then array[cur, nxt] else array[cur] end loop
    insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
    select fp.child_id, mo, 'tuition', 'Tuition', fp.monthly_amount, 'tuition:' || fp.child_id || ':' || to_char(mo, 'YYYY-MM'), p_now
      from public.fee_plans fp join public.children c on c.id = fp.child_id and c.active
     where fp.monthly_amount > 0 and fp.starts_on <= (mo + interval '1 month' - interval '1 day')::date and (fp.ends_on is null or fp.ends_on >= mo)
       and fp.id = (select f2.id from public.fee_plans f2 where f2.child_id = fp.child_id and f2.starts_on <= (mo + interval '1 month' - interval '1 day')::date and (f2.ends_on is null or f2.ends_on >= mo) order by f2.starts_on desc limit 1)
    on conflict (source_ref) do nothing;
    get diagnostics ins = row_count; tuition := tuition + ins;
  end loop;
  -- 2. overtime of last month, billed with this month (each started quarter of an hour at the set rate)
  if s.overtime_rate > 0 then
    for k in select a.child_id, sum(a.overtime_minutes)::int as m from public.attendance a join public.children c on c.id = a.child_id and c.active
              where a.att_date >= prev and a.att_date < cur and a.overtime_minutes > 0 group by a.child_id loop
      amt := ceil(k.m / 15.0) * s.overtime_rate;
      insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
      values (k.child_id, cur, 'overtime', 'Overtime in ' || to_char(prev, 'FMMonth') || ' (' || k.m || ' min)', amt, 'overtime:' || k.child_id || ':' || to_char(prev, 'YYYY-MM'), p_now) on conflict (source_ref) do nothing;
      get diagnostics ins = row_count; ot := ot + ins;
    end loop;
  end if;
  -- 3. reminders on the chosen days of the month, from 9:00: families with something to pay
  if extract(day from today)::int = any (s.reminder_days) and l::time >= time '09:00' then
    for par in select distinct pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active
                where exists (select 1 from public.cka_balances(pc.child_id) b where b.balance > 0 and b.waiting < b.balance)
                   or exists (select 1 from public.charges ch where ch.child_id = pc.child_id and ch.month = nxt and not ch.removed and extract(day from today) >= 25) loop
      perform public.cka_enqueue_email(par, 'payment_reminder', '{}'::jsonb, 'payrem:' || today || ':' || par);
      rem := rem + 1;
    end loop;
  end if;
  -- 4. the day after the grace period: the late fee goes onto unpaid balances (only when the owner has switched late fees on)
  if s.late_fees_on and today > (cur + (s.due_day - 1) + s.grace_days)::date then
    for k in select b.child_id, b.balance, b.waiting from public.cka_balances(null) b where b.month = cur and b.balance > 0 and b.waiting < b.balance loop
      amt := case s.late_fee_kind when 'fixed' then s.late_fee_value else round(k.balance * s.late_fee_value / 100, 2) end;
      continue when amt is null or amt <= 0;
      insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
      values (k.child_id, cur, 'late_fee', 'Late fee', amt, 'late:' || k.child_id || ':' || to_char(cur, 'YYYY-MM'), p_now) on conflict (source_ref) do nothing;
      get diagnostics ins = row_count;
      if ins > 0 then lf := lf + 1; perform public.cka_pay_notify_parents(k.child_id, 'late_fee_added', 'latefee:' || k.child_id || ':' || to_char(cur, 'YYYY-MM')); end if;
    end loop;
  end if;
  return jsonb_build_object('tuition', tuition, 'overtime', ot, 'reminders', rem, 'late_fees', lf);
end $$;

-- ---------------------------------------------------------------------------
-- An event with a cost becomes a charge when a parent says yes (and disappears if they change their mind)
-- ---------------------------------------------------------------------------
create or replace function public.event_respond(p_event uuid, p_child uuid, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.events;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_answer not in ('yes', 'no') then raise exception 'Invalid request'; end if;
  select * into e from public.events where id = p_event;
  if e.id is null or not e.needs_approval then raise exception 'Not found'; end if;
  if not exists (select 1 from public.cka_event_children(p_event) k where k.child_id = p_child) then raise exception 'This event is not for your child'; end if;
  if public.cka_now() > e.approval_deadline then raise exception 'deadline_passed'; end if;
  insert into public.event_responses (event_id, child_id, answered_by, answer) values (p_event, p_child, auth.uid(), p_answer)
  on conflict (event_id, child_id) do update set answer = excluded.answer, answered_by = excluded.answered_by, answered_at = now();
  if p_answer = 'yes' and e.cost is not null and e.cost > 0 then
    insert into public.charges (child_id, month, kind, description, amount, source_ref)
    values (p_child, date_trunc('month', e.starts_at at time zone 'Africa/Cairo')::date, 'event', left(coalesce(nullif(btrim(e.title_en), ''), e.title_ar, 'Event'), 190), e.cost, 'event:' || e.id || ':' || p_child)
    on conflict (source_ref) do update set removed = false;
  elsif p_answer = 'no' then
    update public.charges set removed = true where source_ref = 'event:' || e.id || ':' || p_child;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_pay_access(uuid), public.cka_pay_staff(), public.cka_pay_file_ok(text, boolean), public.cka_pay_log(uuid, text, text), public.cka_balances(uuid), public.payment_settings_save(int, int, boolean, text, numeric, int[], numeric, text, text, text),
  public.fee_plan_save(uuid, text, numeric, date), public.charge_add(uuid, date, text, text, numeric), public.charge_remove(uuid), public.late_fee_waive(uuid, text), public.payment_balances(uuid),
  public.payments_month(date), public.payments_list(date), public.payment_submit(uuid, date, numeric, text, text), public.cka_pay_notify_parents(uuid, text, text), public.payment_confirm(uuid),
  public.payment_reject(uuid, text), public.payment_record(uuid, date, numeric, text, text), public.payment_receipt(uuid), public.payments_owner_summary(date), public.cka_run_billing(timestamptz),
  public.event_respond(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.cka_pay_access(uuid), public.cka_pay_staff(), public.cka_pay_file_ok(text, boolean), public.payment_settings_save(int, int, boolean, text, numeric, int[], numeric, text, text, text),
  public.fee_plan_save(uuid, text, numeric, date), public.charge_add(uuid, date, text, text, numeric), public.charge_remove(uuid), public.late_fee_waive(uuid, text), public.payment_balances(uuid),
  public.payments_month(date), public.payments_list(date), public.payment_submit(uuid, date, numeric, text, text), public.payment_confirm(uuid),
  public.payment_reject(uuid, text), public.payment_record(uuid, date, numeric, text, text), public.payment_receipt(uuid), public.payments_owner_summary(date), public.event_respond(uuid, uuid, text)
to authenticated;
grant execute on function public.cka_run_billing(timestamptz) to service_role;

-- ============================================================
-- migrations/20261006122400_birthdays_transport.sql
-- ============================================================
-- Birthdays and transport (Prompt 21).
--
-- Birthdays: a list by month; an automatic message to both parents at 8:00 am on the birthday (editable in English and Arabic,
-- on/off switch, "send now"); and the data for a public birthday wall that shows first name, initial and age only for
-- children whose parents agreed (the consent is part of registration and can be withdrawn at any time).
-- Transport: routes with driver, the staff member riding the bus, stops and times, and the children on each route; morning and
-- afternoon status per child; "bus 10 minutes away" and "dropped off" notifications; a monthly transport fee as a charge.

-- ---------------------------------------------------------------------------
-- Birthdays
-- ---------------------------------------------------------------------------
create table public.birthday_settings (
  id           boolean primary key default true check (id),
  enabled      boolean not null default true,
  template_en  text not null default 'Happy birthday, {child}! Everyone at Cute Kids Academy wishes {child} a wonderful day full of joy.' check (length(template_en) between 5 and 600),
  template_ar  text not null default 'عيد ميلاد سعيد يا {child}! يتمنى لك كل من في كيوت كيدز أكاديمي يوماً رائعاً مليئاً بالفرح.' check (length(template_ar) between 5 and 600),
  updated_by   uuid references public.profiles (id)
);
insert into public.birthday_settings (id) values (true);

create table public.birthday_sent (
  child_id  uuid not null references public.children (id),
  year      integer not null,
  sent_at   timestamptz not null default now(),
  kind      text not null check (kind in ('auto', 'manual')),
  primary key (child_id, year)
);
alter table public.birthday_settings enable row level security;
alter table public.birthday_sent     enable row level security;
revoke all on public.birthday_settings, public.birthday_sent from anon, authenticated;
grant select on public.birthday_settings, public.birthday_sent to authenticated;
create policy bday_settings_select on public.birthday_settings for select using (public.is_management());
create policy bday_sent_select     on public.birthday_sent     for select using (public.is_management());

create function public.birthday_settings_save(p_enabled boolean, p_en text, p_ar text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_en, ''))) < 5 or length(btrim(coalesce(p_ar, ''))) < 5 then raise exception 'Please write the message in both languages'; end if;
  update public.birthday_settings set enabled = coalesce(p_enabled, true), template_en = btrim(p_en), template_ar = btrim(p_ar), updated_by = auth.uid();
end $$;

-- Every active child with their birthday, for the list by month (management only).
create function public.birthdays_list()
returns table (child_id uuid, child_name text, class_name text, date_of_birth date, month int, day int, turning int, sent_this_year boolean, on_wall boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, coalesce(cl.name, ''), c.date_of_birth, extract(month from c.date_of_birth)::int, extract(day from c.date_of_birth)::int,
         (extract(year from public.cka_today()) - extract(year from c.date_of_birth))::int,
         exists (select 1 from public.birthday_sent b where b.child_id = c.id and b.year = extract(year from public.cka_today())::int),
         coalesce((select k.birthday_wall from public.child_consents k where k.child_id = c.id), false)
    from public.children c left join public.classes cl on cl.id = c.class_id
   where public.is_management() and c.active
   order by extract(month from c.date_of_birth), extract(day from c.date_of_birth), c.full_name
$$;

-- The message to both parents (portal + an email saying there is one). Used by the 8:00 am routine and "send now".
create function public.cka_birthday_send(p_child uuid, p_kind text) returns int
language plpgsql security definer set search_path = public as $$
declare c public.children; st public.birthday_settings; par record; n int := 0; first_name text; body text; yr int := extract(year from public.cka_today())::int;
begin
  select * into c from public.children where id = p_child and active;
  if c.id is null then return 0; end if;
  select * into st from public.birthday_settings;
  first_name := split_part(btrim(c.full_name), ' ', 1);
  for par in select pc.parent_id, p.language from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
    body := replace(case when par.language = 'ar' then st.template_ar else st.template_en end, '{child}', first_name);
    insert into public.parent_messages (parent_id, child_id, kind, body, sent_by) values (par.parent_id, p_child, 'birthday', left(body, 2000), auth.uid());
    perform public.cka_enqueue_email(par.parent_id, 'birthday_message', '{}'::jsonb, 'bday:' || p_child || ':' || yr || ':' || par.parent_id || case when p_kind = 'manual' then ':' || extract(epoch from public.cka_now())::bigint else '' end);
    n := n + 1;
  end loop;
  insert into public.birthday_sent (child_id, year, kind) values (p_child, yr, p_kind) on conflict (child_id, year) do update set sent_at = now(), kind = excluded.kind;
  return n;
end $$;

create function public.birthday_send_now(p_child uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  return public.cka_birthday_send(p_child, 'manual');
end $$;

-- 8:00 am on the day (server only). A 29 February birthday is celebrated on 28 February in other years.
create function public.cka_run_birthdays(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; today date := l::date; k record; sent int := 0; kids int := 0; st public.birthday_settings;
begin
  select * into st from public.birthday_settings;
  if not st.enabled or l::time < time '08:00' then return jsonb_build_object('checked', false, 'children', 0, 'messages', 0); end if;
  for k in select c.id from public.children c
            where c.active and (
                  (extract(month from c.date_of_birth) = extract(month from today) and extract(day from c.date_of_birth) = extract(day from today))
               or (extract(month from c.date_of_birth) = 2 and extract(day from c.date_of_birth) = 29 and extract(month from today) = 2 and extract(day from today) = 28
                   and (extract(year from today)::int % 4 <> 0 or (extract(year from today)::int % 100 = 0 and extract(year from today)::int % 400 <> 0))))
              and not exists (select 1 from public.birthday_sent b where b.child_id = c.id and b.year = extract(year from today)::int) loop
    sent := sent + public.cka_birthday_send(k.id, 'auto'); kids := kids + 1;
  end loop;
  return jsonb_build_object('checked', true, 'children', kids, 'messages', sent);
end $$;

-- The public birthday wall (served by a small public page through the server key): first name, initial and age, this month, only with consent.
create function public.birthday_wall() returns table (first_name text, initial text, day int, turning int, is_today boolean)
language sql stable security definer set search_path = public as $$
  select split_part(btrim(c.full_name), ' ', 1),
         case when position(' ' in btrim(c.full_name)) > 0 then upper(left((regexp_split_to_array(btrim(c.full_name), '\s+'))[array_length(regexp_split_to_array(btrim(c.full_name), '\s+'), 1)], 1)) else '' end,
         extract(day from c.date_of_birth)::int,
         (extract(year from public.cka_today()) - extract(year from c.date_of_birth))::int,
         extract(day from c.date_of_birth) = extract(day from public.cka_today())
    from public.children c join public.child_consents k on k.child_id = c.id and k.birthday_wall
   where c.active and extract(month from c.date_of_birth) = extract(month from public.cka_today())
   order by extract(day from c.date_of_birth), 1
$$;

-- ---------------------------------------------------------------------------
-- Transport
-- ---------------------------------------------------------------------------
create table public.bus_routes (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 2 and 80),
  driver_name   text check (length(driver_name) <= 80),
  driver_phone  text check (length(driver_phone) <= 40),
  rider_id      uuid references public.profiles (id),                -- the staff member who rides the bus
  rider_name    text check (length(rider_name) <= 80),
  monthly_fee   numeric(10, 2) not null default 0 check (monthly_fee >= 0),
  active        boolean not null default true
);
create table public.route_stops (
  id              uuid primary key default gen_random_uuid(),
  route_id        uuid not null references public.bus_routes (id) on delete cascade,
  position        integer not null check (position between 1 and 40),
  name            text not null check (length(btrim(name)) between 1 and 100),
  morning_time    time,
  afternoon_time  time,
  unique (route_id, position)
);
create table public.route_children (
  child_id  uuid primary key references public.children (id),
  route_id  uuid not null references public.bus_routes (id) on delete cascade,
  stop_id   uuid references public.route_stops (id) on delete set null
);
create table public.transport_status (
  child_id     uuid not null references public.children (id),
  status_date  date not null,
  session      text not null check (session in ('morning', 'afternoon')),
  status       text not null check (status in ('on_board', 'absent', 'dropped_off')),
  updated_by   uuid references public.profiles (id),
  updated_at   timestamptz not null default now(),
  primary key (child_id, status_date, session)
);

-- The staff who may run a route: management, and the person riding that bus.
create function public.cka_route_staff(p_route uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_management() or exists (select 1 from public.bus_routes r where r.id = p_route and r.rider_id = auth.uid() and public.auth_role() in ('teacher', 'admin')), false)
$$;

alter table public.bus_routes       enable row level security;
alter table public.route_stops      enable row level security;
alter table public.route_children   enable row level security;
alter table public.transport_status enable row level security;
revoke all on public.bus_routes, public.route_stops, public.route_children, public.transport_status from anon, authenticated;
grant select on public.bus_routes, public.route_stops, public.route_children, public.transport_status to authenticated;
create policy routes_select  on public.bus_routes       for select using (public.cka_route_staff(id));
create policy stops_select   on public.route_stops      for select using (public.cka_route_staff(route_id));
create policy rchild_select  on public.route_children   for select using (public.cka_route_staff(route_id));
create policy tstatus_select on public.transport_status  for select using (public.is_management() or public.cka_route_staff((select route_id from public.route_children rc where rc.child_id = transport_status.child_id))
                                                                         or (public.auth_role() = 'parent' and public.can_see_child(child_id)));

create function public.route_save(p_id uuid, p_name text, p_driver text, p_driver_phone text, p_rider uuid, p_rider_name text, p_fee numeric, p_active boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or coalesce(p_fee, 0) < 0 then raise exception 'Please check the route'; end if;
  if p_rider is not null and not exists (select 1 from public.profiles where id = p_rider and active and role in ('teacher', 'admin')) then raise exception 'The rider must be a teacher or admin account'; end if;
  if rid is null then
    insert into public.bus_routes (name, driver_name, driver_phone, rider_id, rider_name, monthly_fee, active) values (btrim(p_name), nullif(btrim(coalesce(p_driver, '')), ''), nullif(btrim(coalesce(p_driver_phone, '')), ''), p_rider, nullif(btrim(coalesce(p_rider_name, '')), ''), coalesce(p_fee, 0), coalesce(p_active, true)) returning id into rid;
  else
    update public.bus_routes set name = btrim(p_name), driver_name = nullif(btrim(coalesce(p_driver, '')), ''), driver_phone = nullif(btrim(coalesce(p_driver_phone, '')), ''), rider_id = p_rider, rider_name = nullif(btrim(coalesce(p_rider_name, '')), ''),
           monthly_fee = coalesce(p_fee, 0), active = coalesce(p_active, true) where id = rid;
    if not found then raise exception 'Not found'; end if;
  end if;
  return rid;
end $$;

create function public.stop_save(p_id uuid, p_route uuid, p_position int, p_name text, p_morning time, p_afternoon time) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.bus_routes where id = p_route) then raise exception 'Not found'; end if;
  if rid is null then
    insert into public.route_stops (route_id, position, name, morning_time, afternoon_time) values (p_route, p_position, btrim(p_name), p_morning, p_afternoon) returning id into rid;
  else
    update public.route_stops set position = p_position, name = btrim(p_name), morning_time = p_morning, afternoon_time = p_afternoon where id = rid and route_id = p_route;
    if not found then raise exception 'Not found'; end if;
  end if;
  return rid;
end $$;

create function public.stop_delete(p_stop uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.route_stops where id = p_stop;
end $$;

create function public.route_child_set(p_route uuid, p_child uuid, p_stop uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.children where id = p_child and active) or not exists (select 1 from public.bus_routes where id = p_route) then raise exception 'Not found'; end if;
  if p_stop is not null and not exists (select 1 from public.route_stops where id = p_stop and route_id = p_route) then raise exception 'That stop is not on this route'; end if;
  insert into public.route_children (child_id, route_id, stop_id) values (p_child, p_route, p_stop) on conflict (child_id) do update set route_id = excluded.route_id, stop_id = excluded.stop_id;
end $$;

create function public.route_child_remove(p_child uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.route_children where child_id = p_child;
end $$;

-- The bus run: every stop with its children and today's status, for one session.
create function public.transport_run(p_route uuid, p_session text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.cka_route_staff(p_route) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') then raise exception 'Invalid request'; end if;
  select jsonb_build_object('route', jsonb_build_object('id', r.id, 'name', r.name, 'driver_name', r.driver_name, 'driver_phone', r.driver_phone, 'rider_name', coalesce(rp.full_name, r.rider_name)),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'name', s.name, 'time', case when p_session = 'morning' then s.morning_time else s.afternoon_time end,
        'children', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'name', c.full_name, 'status', ts.status) order by c.full_name)
                                from public.route_children rc join public.children c on c.id = rc.child_id and c.active
                                left join public.transport_status ts on ts.child_id = c.id and ts.status_date = public.cka_today() and ts.session = p_session
                               where rc.stop_id = s.id), '[]')) order by s.position) from public.route_stops s where s.route_id = r.id), '[]'),
    'unassigned', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'name', c.full_name, 'status', ts.status) order by c.full_name)
                              from public.route_children rc join public.children c on c.id = rc.child_id and c.active
                              left join public.transport_status ts on ts.child_id = c.id and ts.status_date = public.cka_today() and ts.session = p_session
                             where rc.route_id = r.id and rc.stop_id is null), '[]')) into out
    from public.bus_routes r left join public.profiles rp on rp.id = r.rider_id where r.id = p_route;
  return out;
end $$;

create function public.transport_set_status(p_child uuid, p_session text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare rt uuid; s uuid;
begin
  select route_id into rt from public.route_children where child_id = p_child;
  if rt is null or not public.cka_route_staff(rt) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') or p_status not in ('on_board', 'absent', 'dropped_off') then raise exception 'Invalid request'; end if;
  insert into public.transport_status (child_id, status_date, session, status, updated_by) values (p_child, public.cka_today(), p_session, p_status, auth.uid())
  on conflict (child_id, status_date, session) do update set status = excluded.status, updated_by = excluded.updated_by, updated_at = now();
  if p_status = 'dropped_off' then
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
      perform public.cka_enqueue_email(s, 'bus_dropped_off', '{}'::jsonb, 'busdrop:' || p_child || ':' || public.cka_today() || ':' || p_session || ':' || s);
    end loop;
  end if;
end $$;

-- "The bus is 10 minutes away" for one stop: tells the parents of the children there who have not been dropped off or marked absent.
create function public.transport_near(p_route uuid, p_session text, p_stop uuid) returns int
language plpgsql security definer set search_path = public as $$
declare k record; s uuid; n int := 0;
begin
  if not public.cka_route_staff(p_route) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') or not exists (select 1 from public.route_stops where id = p_stop and route_id = p_route) then raise exception 'Invalid request'; end if;
  for k in select rc.child_id from public.route_children rc join public.children c on c.id = rc.child_id and c.active
            where rc.route_id = p_route and rc.stop_id = p_stop
              and not exists (select 1 from public.transport_status ts where ts.child_id = rc.child_id and ts.status_date = public.cka_today() and ts.session = p_session and ts.status in ('absent', 'dropped_off')) loop
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = k.child_id loop
      perform public.cka_enqueue_email(s, 'bus_near', '{}'::jsonb, 'busnear:' || p_stop || ':' || public.cka_today() || ':' || p_session || ':' || s);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- What a parent sees for each of their children: the route, driver, stop and times, and today's status.
create function public.parent_transport() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if public.auth_role() <> 'parent' then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('child_id', c.id, 'child_name', c.full_name, 'route', r.name, 'driver_name', r.driver_name, 'driver_phone', r.driver_phone,
         'stop', s.name, 'morning_time', s.morning_time, 'afternoon_time', s.afternoon_time,
         'morning_status', (select status from public.transport_status t where t.child_id = c.id and t.status_date = public.cka_today() and t.session = 'morning'),
         'afternoon_status', (select status from public.transport_status t where t.child_id = c.id and t.status_date = public.cka_today() and t.session = 'afternoon')) order by c.full_name), '[]') into out
    from public.parent_children pc join public.children c on c.id = pc.child_id and c.active
    join public.route_children rc on rc.child_id = c.id join public.bus_routes r on r.id = rc.route_id and r.active left join public.route_stops s on s.id = rc.stop_id
   where pc.parent_id = auth.uid();
  return out;
end $$;

-- The transport fee, once a month, as a charge in Payments (server only).
create function public.cka_run_transport_billing(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare cur date := date_trunc('month', p_now at time zone 'Africa/Cairo')::date; n int;
begin
  insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
  select rc.child_id, cur, 'transport', 'Transport: ' || r.name, r.monthly_fee, 'transport:' || rc.child_id || ':' || to_char(cur, 'YYYY-MM'), p_now
    from public.route_children rc join public.bus_routes r on r.id = rc.route_id and r.active and r.monthly_fee > 0 join public.children c on c.id = rc.child_id and c.active
  on conflict (source_ref) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.birthday_settings_save(boolean, text, text), public.birthdays_list(), public.cka_birthday_send(uuid, text), public.birthday_send_now(uuid), public.cka_run_birthdays(timestamptz), public.birthday_wall(),
  public.cka_route_staff(uuid), public.route_save(uuid, text, text, text, uuid, text, numeric, boolean), public.stop_save(uuid, uuid, int, text, time, time), public.stop_delete(uuid),
  public.route_child_set(uuid, uuid, uuid), public.route_child_remove(uuid), public.transport_run(uuid, text), public.transport_set_status(uuid, text, text), public.transport_near(uuid, text, uuid),
  public.parent_transport(), public.cka_run_transport_billing(timestamptz)
from public, anon, authenticated;
grant execute on function
  public.birthday_settings_save(boolean, text, text), public.birthdays_list(), public.birthday_send_now(uuid), public.cka_route_staff(uuid), public.route_save(uuid, text, text, text, uuid, text, numeric, boolean),
  public.stop_save(uuid, uuid, int, text, time, time), public.stop_delete(uuid), public.route_child_set(uuid, uuid, uuid), public.route_child_remove(uuid), public.transport_run(uuid, text),
  public.transport_set_status(uuid, text, text), public.transport_near(uuid, text, uuid), public.parent_transport()
to authenticated;
grant execute on function public.cka_run_birthdays(timestamptz), public.cka_run_transport_billing(timestamptz), public.birthday_wall() to service_role;

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
    'birthday_settings_save', 'birthdays_list', 'birthday_send_now', 'cka_route_staff', 'route_save', 'stop_save', 'stop_delete', 'route_child_set', 'route_child_remove', 'transport_run', 'transport_set_status', 'transport_near', 'parent_transport',
    'cka_pay_access', 'cka_pay_staff', 'cka_pay_file_ok', 'payment_settings_save', 'fee_plan_save', 'charge_add', 'charge_remove', 'late_fee_waive', 'payment_balances', 'payments_month', 'payments_list', 'payment_submit', 'payment_confirm', 'payment_reject', 'payment_record', 'payment_receipt', 'payments_owner_summary',
    'absence_add', 'absence_tracker', 'parent_message_read', 'absence_followup_list', 'followup_send', 'followup_outcome', 'absence_followup_stats', 'approval_call_log', 'approval_call_list', 'admin_parent_search', 'case_from_email',
    'parent_month_summary', 'academy_settings_save', 'admin_home', 'admin_children', 'admin_child_profile', 'child_move_class', 'child_withdraw', 'child_reinstate', 'admin_classes', 'class_save', 'class_staff_set', 'class_staff_remove', 'staff_job_title_save',
    'cka_media_visible', 'cka_media_upload_ok', 'cka_media_file', 'media_consent_check', 'media_add', 'media_set_tags', 'media_remove', 'media_mark_post', 'media_settings_save',
    'notification_prefs_save', 'push_subscribe', 'push_unsubscribe', 'cka_announcement_visible', 'cka_announcement_file', 'announcement_post', 'announcement_mark_read', 'announcement_stats', 'announcement_remove', 'cka_event_visible', 'menu_week', 'menu_save', 'schedule_save', 'schedule_delete', 'event_save', 'event_delete', 'event_respond', 'event_responses_summary',
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
  if to_regprocedure('public.cka_run_birthdays(timestamptz)') is not null then
    revoke all on function public.cka_run_birthdays(timestamptz), public.cka_run_transport_billing(timestamptz), public.birthday_wall() from public, anon, authenticated;
    grant execute on function public.cka_run_birthdays(timestamptz), public.cka_run_transport_billing(timestamptz), public.birthday_wall() to service_role;
  end if;
  if to_regprocedure('public.cka_run_billing(timestamptz)') is not null then
    revoke all on function public.cka_run_billing(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_billing(timestamptz) to service_role;
  end if;
  if to_regprocedure('public.cka_run_absence_check(timestamptz)') is not null then
    revoke all on function public.cka_run_absence_check(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_absence_check(timestamptz) to service_role;
  end if;
  if to_regprocedure('public.cka_media_expired(timestamptz)') is not null then
    revoke all on function public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text) from public, anon, authenticated;
    grant execute on function public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text) to service_role;
  end if;
  if to_regprocedure('public.cka_run_content_check(timestamptz)') is not null then
    revoke all on function public.cka_run_content_check(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_content_check(timestamptz) to service_role;
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
