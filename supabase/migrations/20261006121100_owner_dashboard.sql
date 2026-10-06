-- The owner's private dashboard (Prompt 9b): staff attendance, HR log, staff concerns,
-- repeated mistakes, confirmed investigation faults, editable thresholds, and one function that
-- returns every dashboard number for a period.
--
-- PRIVACY: every table here is readable ONLY by an active user whose role is 'owner' (enforced by
-- row-level security, not by hiding a menu). Not the manager, not admin, not teachers, not parents.
--   * Admin/manager can RECORD attendance, but cannot read it back (record_staff_attendance()).
--   * Any staff member can raise a concern; if they choose "anonymous", NO name is stored anywhere
--     (raised_by stays empty, the time is rounded to the day, and a constraint forbids a name).
--   * Only CONFIRMED faults count against a staff member. An open investigation never does.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.staff_attendance (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references public.profiles (id),
  att_date     date not null,
  status       text not null check (status in ('present', 'absent', 'leave')),
  minutes_late int  not null default 0 check (minutes_late between 0 and 600),
  reason       text,
  recorded_by  uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  unique (staff_id, att_date)
);

create table public.hr_log (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references public.profiles (id),
  entry_type      text not null check (entry_type in ('verbal_reminder', 'written_warning', 'final_warning', 'leave', 'contract', 'appraisal', 'praise')),
  entry_date      date not null default current_date,
  note            text,
  follow_up_date  date,
  needs_decision  boolean not null default false,     -- waiting for the owner to decide
  decided_by      uuid references public.profiles (id),
  decided_at      timestamptz,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index hr_log_staff_idx on public.hr_log (staff_id, entry_date desc);

create table public.staff_complaints (
  id          uuid primary key default gen_random_uuid(),
  raised_by   uuid references public.profiles (id),
  category    text not null check (category in ('supplies', 'workload', 'conduct', 'facilities', 'pay', 'other')),
  description text not null check (length(btrim(description)) > 0),
  status      text not null default 'open' check (status in ('open', 'in_review', 'resolved')),
  anonymous   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint anonymous_has_no_name check (not anonymous or raised_by is null)
);

-- The fixed (but editable) list of mistake types. "Critical" ones are highlighted on the dashboard.
create table public.mistake_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  critical   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.mistake_categories (name, critical) values
  ('Report without a personal note', false),
  ('Cleaning log not signed', false),
  ('Phone in class', false),
  ('Allergy check missed', true);

create table public.mistakes (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid references public.profiles (id),      -- optional
  category_id   uuid not null references public.mistake_categories (id),
  mistake_date  date not null default current_date,
  source        text not null check (source in ('spot_check', 'investigation', 'complaint')),
  confirmed     boolean not null default false,
  note          text,
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now()
);
create index mistakes_staff_idx on public.mistakes (staff_id, mistake_date);

-- A person is linked to an investigation ONLY when its findings confirm responsibility.
create table public.investigation_faults (
  investigation_id uuid primary key references public.investigations (id),
  staff_id         uuid not null references public.profiles (id),
  confirmed        boolean not null default false,
  decided_by       uuid references public.profiles (id),
  decided_at       timestamptz not null default now()
);

create table public.owner_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
-- Thresholds for the Good / Watch / Action needed status, per 30 days (scaled to the period shown).
insert into public.owner_settings (key, value) values ('thresholds', jsonb_build_object(
  'absence_days',     jsonb_build_object('watch', 3,  'action', 6),
  'late_minutes',     jsonb_build_object('watch', 60, 'action', 180),
  'confirmed_faults', jsonb_build_object('watch', 1,  'action', 3),
  'complaints',       jsonb_build_object('watch', 2,  'action', 4)));

-- ---------------------------------------------------------------------------
-- Row-level security: owner only, everywhere
-- ---------------------------------------------------------------------------
alter table public.staff_attendance    enable row level security;
alter table public.hr_log              enable row level security;
alter table public.staff_complaints    enable row level security;
alter table public.mistake_categories  enable row level security;
alter table public.mistakes            enable row level security;
alter table public.investigation_faults enable row level security;
alter table public.owner_settings      enable row level security;

revoke all on public.staff_attendance, public.hr_log, public.staff_complaints, public.mistake_categories,
              public.mistakes, public.investigation_faults, public.owner_settings from anon, authenticated;
grant select on public.staff_attendance, public.hr_log, public.staff_complaints, public.mistake_categories,
                public.mistakes, public.investigation_faults, public.owner_settings to authenticated;
grant insert, update on public.hr_log, public.mistakes, public.mistake_categories, public.owner_settings to authenticated;
grant update (status) on public.staff_complaints to authenticated;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.auth_role() = 'owner', false) $$;
revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

create policy owner_attendance_select on public.staff_attendance for select using (public.is_owner());
create policy owner_hr_select  on public.hr_log for select using (public.is_owner());
create policy owner_hr_insert  on public.hr_log for insert with check (public.is_owner());
create policy owner_hr_update  on public.hr_log for update using (public.is_owner()) with check (public.is_owner());
create policy owner_sc_select  on public.staff_complaints for select using (public.is_owner());
create policy owner_sc_update  on public.staff_complaints for update using (public.is_owner()) with check (public.is_owner());
create policy owner_mc_select  on public.mistake_categories for select using (public.is_owner());
create policy owner_mc_insert  on public.mistake_categories for insert with check (public.is_owner());
create policy owner_mc_update  on public.mistake_categories for update using (public.is_owner()) with check (public.is_owner());
create policy owner_m_select   on public.mistakes for select using (public.is_owner());
create policy owner_m_insert   on public.mistakes for insert with check (public.is_owner());
create policy owner_m_update   on public.mistakes for update using (public.is_owner()) with check (public.is_owner());
create policy owner_if_select  on public.investigation_faults for select using (public.is_owner());
create policy owner_os_select  on public.owner_settings for select using (public.is_owner());
create policy owner_os_insert  on public.owner_settings for insert with check (public.is_owner());
create policy owner_os_update  on public.owner_settings for update using (public.is_owner()) with check (public.is_owner());

-- Who wrote an HR entry or mistake is recorded by the database, not claimed by the browser.
create function public.cka_stamp_creator() returns trigger
language plpgsql as $$
begin new.created_by := auth.uid(); return new; end $$;
create trigger hr_log_stamp before insert on public.hr_log for each row execute function public.cka_stamp_creator();
create trigger mistakes_stamp before insert on public.mistakes for each row execute function public.cka_stamp_creator();

-- Deciding an HR item records who and when (the owner).
create function public.cka_hr_decide() returns trigger
language plpgsql as $$
begin
  if old.decided_at is null and new.decided_at is not null then new.decided_by := auth.uid(); end if;
  if new.staff_id is distinct from old.staff_id or new.entry_type is distinct from old.entry_type or new.entry_date is distinct from old.entry_date then
    raise exception 'An HR entry cannot be re-assigned; add a new entry instead';
  end if;
  return new;
end $$;
create trigger hr_log_decide before update on public.hr_log for each row execute function public.cka_hr_decide();

-- ---------------------------------------------------------------------------
-- Recording things (callable by people who cannot read the tables)
-- ---------------------------------------------------------------------------
-- Admin, manager or owner records one person's attendance for a day (replaces an earlier entry).
create function public.record_staff_attendance(p_staff uuid, p_date date, p_status text, p_minutes_late int default 0, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_status not in ('present', 'absent', 'leave') then raise exception 'Invalid status'; end if;
  if p_date is null or p_date > (now() at time zone 'Africa/Cairo')::date then raise exception 'The date cannot be in the future'; end if;
  if p_date < (now() at time zone 'Africa/Cairo')::date - 60 then raise exception 'That date is too far in the past'; end if;
  if not exists (select 1 from public.profiles where id = p_staff and role in ('teacher', 'admin', 'manager', 'owner') and active) then
    raise exception 'Choose an active staff member';
  end if;
  insert into public.staff_attendance (staff_id, att_date, status, minutes_late, reason, recorded_by)
  values (p_staff, p_date, p_status, case when p_status = 'present' then coalesce(p_minutes_late, 0) else 0 end, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (staff_id, att_date) do update
    set status = excluded.status, minutes_late = excluded.minutes_late, reason = excluded.reason, recorded_by = excluded.recorded_by;
end $$;

-- The attendance sheet for one day: the staff list for everyone allowed to record, and the saved
-- values only for the owner.
create function public.staff_attendance_day(p_date date)
returns table (staff_id uuid, full_name text, role text, status text, minutes_late int, reason text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role,
         case when public.is_owner() then a.status end,
         case when public.is_owner() then a.minutes_late end,
         case when public.is_owner() then a.reason end
  from public.profiles p
  left join public.staff_attendance a on a.staff_id = p.id and a.att_date = p_date
  where public.is_management() and p.active and p.role in ('teacher', 'admin', 'manager')
  order by p.full_name
$$;

-- Any staff member raises a concern. Anonymous means NOTHING identifying is stored.
create function public.submit_staff_complaint(p_category text, p_description text, p_anonymous boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() not in ('teacher', 'admin', 'manager', 'owner') then raise exception 'Not allowed'; end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null then raise exception 'Please describe the concern'; end if;
  if coalesce(p_anonymous, false) then
    insert into public.staff_complaints (raised_by, category, description, anonymous, created_at)
    values (null, p_category, btrim(p_description), true, date_trunc('day', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo');
  else
    insert into public.staff_complaints (raised_by, category, description, anonymous) values (auth.uid(), p_category, btrim(p_description), false);
  end if;
end $$;

-- Manager or owner: say that an investigation's findings confirm (or do not confirm) a person's responsibility.
create function public.confirm_investigation_fault(p_investigation uuid, p_staff uuid, p_confirmed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.investigations;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  select * into inv from public.investigations where id = p_investigation;
  if inv.id is null then raise exception 'Not found'; end if;
  if not exists (select 1 from public.investigation_steps where investigation_id = p_investigation and step = 'findings') then
    raise exception 'Responsibility can only be confirmed once the findings have been written';
  end if;
  if inv.status = 'closed' and not public.is_owner() then raise exception 'This investigation is closed'; end if;
  if not exists (select 1 from public.profiles where id = p_staff and role in ('teacher', 'admin', 'manager') and active) then
    raise exception 'Choose an active staff member';
  end if;
  insert into public.investigation_faults (investigation_id, staff_id, confirmed, decided_by, decided_at)
  values (p_investigation, p_staff, coalesce(p_confirmed, false), auth.uid(), now())
  on conflict (investigation_id) do update
    set staff_id = excluded.staff_id, confirmed = excluded.confirmed, decided_by = excluded.decided_by, decided_at = excluded.decided_at;
end $$;

-- What an investigation currently says about responsibility (manager/owner).
create function public.investigation_fault(p_investigation uuid)
returns table (staff_id uuid, staff_name text, confirmed boolean)
language sql stable security definer set search_path = public as $$
  select f.staff_id, p.full_name, f.confirmed
  from public.investigation_faults f join public.profiles p on p.id = f.staff_id
  where f.investigation_id = p_investigation and public.is_manager_or_owner()
$$;

-- ---------------------------------------------------------------------------
-- Dashboard numbers
-- ---------------------------------------------------------------------------
-- A "happy comment": a compliment, or a comment left with high scores (average 4 or more).
create function public.cka_is_happy(r public.ratings) returns boolean
language sql immutable as $$
  select r.compliment_staff_id is not null
      or nullif(btrim(coalesce(r.compliment_text, '')), '') is not null
      or (nullif(btrim(coalesce(r.comment, '')), '') is not null
          and (r.care_score + r.communication_score + r.daily_reports_score) >= 12)
$$;

-- Thresholds are written per 30 days; for a longer or shorter period they are scaled (never below 1).
create function public.cka_threshold(p_th jsonb, p_metric text, p_level text, p_days int) returns int
language sql immutable as $$
  select greatest(1, ceil(coalesce((p_th -> p_metric ->> p_level)::numeric,
    case p_metric || '.' || p_level
      when 'absence_days.watch' then 3 when 'absence_days.action' then 6
      when 'late_minutes.watch' then 60 when 'late_minutes.action' then 180
      when 'confirmed_faults.watch' then 1 when 'confirmed_faults.action' then 3
      when 'complaints.watch' then 2 else 4 end) * p_days / 30.0))::int
$$;

create function public.owner_dashboard(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  n int; pf date; pt date;
  f timestamptz; t timestamptz; pfts timestamptz;
  th jsonb; wk0 date; out jsonb;
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid period'; end if;
  if p_to - p_from > 800 then raise exception 'The period is too long'; end if;

  n := p_to - p_from + 1;
  pf := p_from - n; pt := p_from - 1;                                  -- the period just before, same length
  f := p_from::timestamp at time zone 'Africa/Cairo';
  t := (p_to + 1)::timestamp at time zone 'Africa/Cairo';
  pfts := pf::timestamp at time zone 'Africa/Cairo';
  th := coalesce((select value from public.owner_settings where key = 'thresholds'), '{}'::jsonb);
  wk0 := p_to - extract(dow from p_to)::int;                           -- Sunday of the week containing p_to

  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', n, 'previous_from', pf, 'previous_to', pt),
    'thresholds', jsonb_build_object(
        'absence_days', jsonb_build_object('watch', public.cka_threshold(th, 'absence_days', 'watch', 30), 'action', public.cka_threshold(th, 'absence_days', 'action', 30)),
        'late_minutes', jsonb_build_object('watch', public.cka_threshold(th, 'late_minutes', 'watch', 30), 'action', public.cka_threshold(th, 'late_minutes', 'action', 30)),
        'confirmed_faults', jsonb_build_object('watch', public.cka_threshold(th, 'confirmed_faults', 'watch', 30), 'action', public.cka_threshold(th, 'confirmed_faults', 'action', 30)),
        'complaints', jsonb_build_object('watch', public.cka_threshold(th, 'complaints', 'watch', 30), 'action', public.cka_threshold(th, 'complaints', 'action', 30))),

    -- 1. the six tiles, each with the previous period beside it
    'tiles', jsonb_build_object(
      'accidents', jsonb_build_object(
         'value', (select count(*) from public.incidents where occurred_at >= f and occurred_at < t),
         'previous', (select count(*) from public.incidents where occurred_at >= pfts and occurred_at < f)),
      'complaints', jsonb_build_object(
         'value', (select count(*) from public.submissions where type = 'complaint' and created_at >= f and created_at < t),
         'previous', (select count(*) from public.submissions where type = 'complaint' and created_at >= pfts and created_at < f)),
      'happy_comments', jsonb_build_object(
         'value', (select count(*) from public.ratings r where public.cka_is_happy(r) and r.created_at >= f and r.created_at < t),
         'previous', (select count(*) from public.ratings r where public.cka_is_happy(r) and r.created_at >= pfts and r.created_at < f)),
      'absence_days', jsonb_build_object(
         'value', (select count(*) from public.staff_attendance where status = 'absent' and att_date between p_from and p_to),
         'previous', (select count(*) from public.staff_attendance where status = 'absent' and att_date between pf and pt)),
      'late_minutes', jsonb_build_object(
         'value', (select coalesce(sum(minutes_late), 0) from public.staff_attendance where att_date between p_from and p_to),
         'previous', (select coalesce(sum(minutes_late), 0) from public.staff_attendance where att_date between pf and pt)),
      'open_hr', jsonb_build_object(
         'value', (select count(*) from public.hr_log where needs_decision and decided_at is null),
         'opened', (select count(*) from public.hr_log where needs_decision and created_at >= f and created_at < t),
         'previous_opened', (select count(*) from public.hr_log where needs_decision and created_at >= pfts and created_at < f))),

    -- 2 and 3. last 8 weeks (Sunday to Saturday) ending with the week that contains the end of the period
    'weekly', coalesce((select jsonb_agg(jsonb_build_object(
          'week_start', w,
          'accidents', (select count(*) from public.incidents i where (i.occurred_at at time zone 'Africa/Cairo')::date between w and w + 6),
          'complaints', (select count(*) from public.submissions s where s.type = 'complaint' and (s.created_at at time zone 'Africa/Cairo')::date between w and w + 6),
          'happy_comments', (select count(*) from public.ratings r where public.cka_is_happy(r) and (r.created_at at time zone 'Africa/Cairo')::date between w and w + 6)
        ) order by w) from (select gs::date as w from generate_series((wk0 - 49)::timestamp, wk0::timestamp, interval '7 days') as gs) as g), '[]'),

    -- 4. latest accident notes
    'latest_accidents', coalesce((select jsonb_agg(x order by (x ->> 'occurred_at') desc) from (
          select jsonb_build_object('id', i.id, 'occurred_at', i.occurred_at, 'child', c.full_name, 'class', cl.name, 'location', i.location,
                 'severity', i.severity, 'note', left(i.what_happened, 200), 'parent_read', i.parent_signed_at is not null,
                 'investigation', (select v.status from public.investigations v where v.incident_id = i.id)) as x
            from public.incidents i join public.children c on c.id = i.child_id left join public.classes cl on cl.id = c.class_id
           where i.occurred_at >= f and i.occurred_at < t order by i.occurred_at desc limit 10) q), '[]'),

    -- 5. repeated mistakes (confirmed only)
    'mistakes', coalesce((select jsonb_agg(jsonb_build_object('category', name, 'critical', critical, 'count', cnt) order by cnt desc, critical desc, name)
          from (select c.name, c.critical, count(*) as cnt from public.mistakes m join public.mistake_categories c on c.id = m.category_id
                 where m.confirmed and m.mistake_date between p_from and p_to group by 1, 2) q), '[]'),

    -- 6. the staff table
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.full_name, 'role', s.role, 'absence_days', s.absence_days, 'late_minutes', s.late_minutes,
          'class_accidents', s.class_accidents, 'confirmed_faults', s.confirmed_faults, 'complaints_about', s.complaints_about,
          'status', case
             when s.absence_days >= public.cka_threshold(th, 'absence_days', 'action', n) or s.late_minutes >= public.cka_threshold(th, 'late_minutes', 'action', n)
               or s.confirmed_faults >= public.cka_threshold(th, 'confirmed_faults', 'action', n) or s.complaints_about >= public.cka_threshold(th, 'complaints', 'action', n) then 'action'
             when s.absence_days >= public.cka_threshold(th, 'absence_days', 'watch', n) or s.late_minutes >= public.cka_threshold(th, 'late_minutes', 'watch', n)
               or s.confirmed_faults >= public.cka_threshold(th, 'confirmed_faults', 'watch', n) or s.complaints_about >= public.cka_threshold(th, 'complaints', 'watch', n) then 'watch'
             else 'good' end) order by s.full_name)
        from (select p.id, p.full_name, p.role,
                (select count(*) from public.staff_attendance a where a.staff_id = p.id and a.status = 'absent' and a.att_date between p_from and p_to)::int as absence_days,
                (select coalesce(sum(a.minutes_late), 0) from public.staff_attendance a where a.staff_id = p.id and a.att_date between p_from and p_to)::int as late_minutes,
                (select count(*) from public.incidents i join public.children c on c.id = i.child_id
                  where i.occurred_at >= f and i.occurred_at < t
                    and (c.class_id in (select sc.class_id from public.staff_classes sc where sc.staff_id = p.id)
                         or c.class_id in (select cl.id from public.classes cl where cl.head_teacher_id = p.id)))::int as class_accidents,
                ((select count(*) from public.investigation_faults ff join public.investigations iv on iv.id = ff.investigation_id
                   where ff.staff_id = p.id and ff.confirmed and iv.opened_at >= f and iv.opened_at < t)
                 + (select count(*) from public.mistakes m where m.staff_id = p.id and m.confirmed and m.mistake_date between p_from and p_to))::int as confirmed_faults,
                (select count(*) from public.submissions sb where sb.about_staff_member = p.id and sb.created_at >= f and sb.created_at < t)::int as complaints_about
              from public.profiles p where p.active and p.role in ('teacher', 'admin', 'manager')) s), '[]'),

    -- 7. HR log: items waiting for the owner first, then newest
    'hr_log', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('id', h.id, 'staff', p.full_name, 'staff_id', h.staff_id, 'type', h.entry_type, 'date', h.entry_date, 'note', h.note,
                 'follow_up_date', h.follow_up_date, 'awaiting', (h.needs_decision and h.decided_at is null), 'decided_at', h.decided_at,
                 'decided_by', d.full_name) as x
            from public.hr_log h join public.profiles p on p.id = h.staff_id left join public.profiles d on d.id = h.decided_by
           order by (h.needs_decision and h.decided_at is null) desc, h.entry_date desc, h.created_at desc limit 100) q), '[]'),

    -- 8. concerns raised by staff
    'staff_concerns', jsonb_build_object(
      'by_category_status', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'status', status, 'count', cnt) order by category, status)
            from (select category, status, count(*) cnt from public.staff_complaints where created_at >= f and created_at < t group by 1, 2) q), '[]'),
      'recent', coalesce((select jsonb_agg(x) from (
            select jsonb_build_object('id', c.id, 'category', c.category, 'status', c.status, 'description', c.description, 'anonymous', c.anonymous,
                   'raised_by', case when c.anonymous then null else p.full_name end, 'date', (c.created_at at time zone 'Africa/Cairo')::date) as x
              from public.staff_complaints c left join public.profiles p on p.id = c.raised_by
             order by (c.status = 'resolved'), c.created_at desc limit 50) q), '[]')),

    -- 9. feedback per family
    'families', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('parent', p.full_name, 'complaints', f2.complaints, 'happy', f2.happy,
                 'latest_at', f2.latest_at, 'latest_message', f2.latest_message) as x
            from public.profiles p
            join lateral (select
                 (select count(*) from public.submissions s where s.parent_id = p.id and s.type = 'complaint' and s.created_at >= f and s.created_at < t)::int as complaints,
                 (select count(*) from public.ratings r where r.parent_id = p.id and public.cka_is_happy(r) and r.created_at >= f and r.created_at < t)::int as happy,
                 (select u.at_ from (select s.created_at as at_, s.title || ': ' || left(s.description, 160) as msg from public.submissions s where s.parent_id = p.id
                                     union all
                                     select r.created_at, coalesce(nullif(btrim(r.compliment_text), ''), nullif(btrim(r.comment), '')) from public.ratings r where r.parent_id = p.id) u
                   where u.msg is not null order by u.at_ desc limit 1) as latest_at,
                 (select u.msg from (select s.created_at as at_, s.title || ': ' || left(s.description, 160) as msg from public.submissions s where s.parent_id = p.id
                                     union all
                                     select r.created_at, coalesce(nullif(btrim(r.compliment_text), ''), nullif(btrim(r.comment), '')) from public.ratings r where r.parent_id = p.id) u
                   where u.msg is not null order by u.at_ desc limit 1) as latest_message) f2 on true
           where p.role = 'parent' and (f2.complaints > 0 or f2.happy > 0)
           order by f2.complaints + f2.happy desc, p.full_name limit 50) q), '[]')
  ) into out;
  return out;
end $$;

revoke all on function
  public.record_staff_attendance(uuid, date, text, int, text), public.staff_attendance_day(date),
  public.submit_staff_complaint(text, text, boolean), public.confirm_investigation_fault(uuid, uuid, boolean),
  public.investigation_fault(uuid), public.cka_is_happy(public.ratings), public.cka_threshold(jsonb, text, text, int),
  public.owner_dashboard(date, date)
from public;
grant execute on function
  public.record_staff_attendance(uuid, date, text, int, text), public.staff_attendance_day(date),
  public.submit_staff_complaint(text, text, boolean), public.confirm_investigation_fault(uuid, uuid, boolean),
  public.investigation_fault(uuid), public.owner_dashboard(date, date)
to authenticated;
