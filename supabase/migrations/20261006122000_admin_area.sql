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
