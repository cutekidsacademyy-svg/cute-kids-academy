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
