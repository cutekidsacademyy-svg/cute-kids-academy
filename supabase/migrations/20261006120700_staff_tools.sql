-- Staff dashboard support (Prompt 6): the work queue, case details, and the actions staff take
-- on a case. Every action goes through a function so the rules (who may act, reasons required,
-- timeline entry written) cannot be skipped from the browser.

-- ---------------------------------------------------------------------------
-- Teachers never see a complaint that names a staff member (it goes to the manager).
-- This is stricter than "except complaints about themselves": a teacher should not
-- read a complaint about a colleague either.
-- ---------------------------------------------------------------------------
create or replace function public.staff_can_see_submission(p_submission uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.is_management() then exists (select 1 from public.submissions s where s.id = p_submission)
    when public.auth_role() = 'teacher' then exists (
      select 1 from public.submissions s
      where s.id = p_submission
        and s.about_staff_member is null
        and public.can_see_child(s.child_id))
    else false
  end
$$;

-- ---------------------------------------------------------------------------
-- Who handles a case at each escalation level
--   level 2: the head teacher of the child's class (never the person complained about)
--   level 3: an active manager      level 4: an active owner
-- ---------------------------------------------------------------------------
create function public.cka_level_assignee(p_level int, p_child uuid, p_subject uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case
    when p_level = 2 then (
      select cl.head_teacher_id from public.children c join public.classes cl on cl.id = c.class_id
      join public.profiles h on h.id = cl.head_teacher_id and h.active
      where c.id = p_child and cl.head_teacher_id is distinct from p_subject)
    when p_level = 3 then (select p.id from public.profiles p where p.role = 'manager' and p.active
                           and p.id is distinct from p_subject order by p.created_at limit 1)
    when p_level = 4 then (select p.id from public.profiles p where p.role = 'owner' and p.active
                           and p.id is distinct from p_subject order by p.created_at limit 1)
  end
$$;
revoke all on function public.cka_level_assignee(int, uuid, uuid) from public;

-- New cases that start at level 3 (safety concerns, complaints about staff) go straight to a manager.
create function public.cka_submission_autoassign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is null and new.escalation_level >= 3 then
    new.assigned_to := public.cka_level_assignee(new.escalation_level, new.child_id, new.about_staff_member);
  end if;
  return new;
end $$;
create trigger submissions_before_insert_assign before insert on public.submissions
  for each row execute function public.cka_submission_autoassign();

create or replace function public.cka_submission_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, new_value, visible_to_parent)
  values (new.id, new.parent_id, public.cka_person_name(new.parent_id), 'created', 'Submission received', new.urgency, true);
  if new.assigned_to is not null then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, new_value, visible_to_parent)
    values (new.id, null, null, 'assigned', 'Assigned to ' || public.cka_person_name(new.assigned_to), new.assigned_to::text, true);
  end if;
  return new;
end $$;

-- A serious accident opens a safety investigation, assigned to a manager (Prompt 21).
create function public.cka_incident_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.severity = 'serious' then
    insert into public.investigations (incident_id, submission_id, assigned_to)
    values (new.id, new.submission_id, public.cka_level_assignee(3, new.child_id, null))
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger incidents_after_insert after insert on public.incidents
  for each row execute function public.cka_incident_after_insert();

-- ---------------------------------------------------------------------------
-- Reading: queue, one case, staff list, ratings
-- ---------------------------------------------------------------------------
create function public.staff_queue(p_include_done boolean default true)
returns table (
  id uuid, ref_no bigint, type text, title text, urgency text, status text, escalation_level smallint,
  created_at timestamptz, acknowledge_by timestamptz, resolve_by timestamptz,
  acknowledged_at timestamptz, resolved_at timestamptz, next_due timestamptz,
  child_id uuid, child_name text, class_id uuid, class_name text, parent_name text,
  assigned_to uuid, assignee_name text, about_staff_name text
)
language sql stable security definer set search_path = public as $$
  select q.* from (
    select s.id, s.ref_no, s.type, s.title, s.urgency, s.status, s.escalation_level,
           s.created_at, s.acknowledge_by, s.resolve_by, s.acknowledged_at, s.resolved_at,
           case when s.status = 'received' then s.acknowledge_by
                when s.status in ('acknowledged', 'in_progress') then s.resolve_by end as next_due,
           s.child_id, c.full_name, c.class_id, cl.name, pp.full_name,
           s.assigned_to, a.full_name,
           case when public.is_management() then ab.full_name end
    from public.submissions s
    join public.children c on c.id = s.child_id
    left join public.classes cl on cl.id = c.class_id
    join public.profiles pp on pp.id = s.parent_id
    left join public.profiles a on a.id = s.assigned_to
    left join public.profiles ab on ab.id = s.about_staff_member
    where public.auth_role() in ('teacher', 'admin', 'manager', 'owner')
      and public.staff_can_see_submission(s.id)
      and (p_include_done or s.status not in ('resolved', 'closed'))
  ) q
  order by (case when q.status in ('resolved', 'closed') then 1 else 0 end), q.next_due nulls last, q.created_at
$$;

create function public.staff_case(p_id uuid)
returns table (
  id uuid, ref_no bigint, type text, title text, description text, urgency text, status text,
  escalation_level smallint, created_at timestamptz, acknowledge_by timestamptz, resolve_by timestamptz,
  acknowledged_at timestamptz, resolved_at timestamptz, parent_satisfied boolean,
  child_id uuid, child_name text, class_name text, parent_name text, parent_phone text,
  assigned_to uuid, assignee_name text, about_staff_name text, has_investigation boolean
)
language sql stable security definer set search_path = public as $$
  select s.id, s.ref_no, s.type, s.title, s.description, s.urgency, s.status, s.escalation_level,
         s.created_at, s.acknowledge_by, s.resolve_by, s.acknowledged_at, s.resolved_at, s.parent_satisfied,
         s.child_id, c.full_name, cl.name, pp.full_name, pp.phone,
         s.assigned_to, a.full_name,
         case when public.is_management() then ab.full_name end,
         public.is_management() and exists (select 1 from public.investigations i where i.submission_id = s.id)
  from public.submissions s
  join public.children c on c.id = s.child_id
  left join public.classes cl on cl.id = c.class_id
  join public.profiles pp on pp.id = s.parent_id
  left join public.profiles a on a.id = s.assigned_to
  left join public.profiles ab on ab.id = s.about_staff_member
  where s.id = p_id and public.staff_can_see_submission(s.id)
$$;

-- Active staff (names and roles) for assigning cases.
create function public.staff_list()
returns table (id uuid, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role from public.profiles p
  where public.auth_role() in ('teacher', 'admin', 'manager', 'owner')
    and p.active and p.role in ('teacher', 'admin', 'manager', 'owner')
  order by p.full_name
$$;

-- Ratings and compliments: manager and owner only.
create function public.staff_ratings()
returns table (
  id uuid, month date, class_name text, child_name text, care_score smallint, communication_score smallint,
  daily_reports_score smallint, comment text, compliment_staff_name text, compliment_text text, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select r.id, r.month, cl.name, c.full_name, r.care_score, r.communication_score, r.daily_reports_score,
         r.comment, st.full_name, r.compliment_text, r.created_at
  from public.ratings r
  join public.children c on c.id = r.child_id
  left join public.classes cl on cl.id = r.class_id
  left join public.profiles st on st.id = r.compliment_staff_id
  where public.is_manager_or_owner()
  order by r.created_at desc
$$;

-- ---------------------------------------------------------------------------
-- Actions (each writes a timeline entry through the submission triggers)
-- ---------------------------------------------------------------------------
create function public.cka_require_staff_case(p_submission uuid) returns public.submissions
language plpgsql stable security definer set search_path = public as $$
declare s public.submissions;
begin
  if public.auth_role() not in ('teacher', 'admin', 'manager', 'owner') or not public.staff_can_see_submission(p_submission) then
    raise exception 'Not allowed';
  end if;
  select * into s from public.submissions where id = p_submission;
  return s;
end $$;

-- Acknowledge: records the time and sends the parent a message (visible on their timeline).
create function public.staff_acknowledge(p_submission uuid, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions := public.cka_require_staff_case(p_submission);
begin
  if s.status <> 'received' then raise exception 'This case has already been acknowledged'; end if;
  perform set_config('app.change_reason', coalesce(nullif(btrim(p_message), ''), ''), true);
  update public.submissions set status = 'acknowledged' where id = p_submission;
end $$;

create function public.staff_mark_in_progress(p_submission uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions := public.cka_require_staff_case(p_submission);
begin
  if s.status not in ('received', 'acknowledged') then raise exception 'Only a new or acknowledged case can be started'; end if;
  update public.submissions set status = 'in_progress' where id = p_submission;
end $$;

create function public.staff_assign(p_submission uuid, p_staff uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions := public.cka_require_staff_case(p_submission);
begin
  if s.status in ('resolved', 'closed') then raise exception 'This case is finished'; end if;
  if not exists (select 1 from public.profiles where id = p_staff and active and role in ('teacher', 'admin', 'manager', 'owner')) then
    raise exception 'Choose an active staff member';
  end if;
  if p_staff = s.about_staff_member then raise exception 'A complaint cannot be assigned to the person it is about'; end if;
  update public.submissions set assigned_to = p_staff where id = p_submission;
end $$;

-- Escalate one level, with a reason, and hand it to the person for that level.
create function public.staff_escalate(p_submission uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions := public.cka_require_staff_case(p_submission); nxt int; who uuid;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required'; end if;
  if s.status in ('resolved', 'closed') then raise exception 'This case is finished'; end if;
  if s.escalation_level >= 4 then raise exception 'Already at the highest level'; end if;
  nxt := s.escalation_level + 1;
  who := public.cka_level_assignee(nxt, s.child_id, s.about_staff_member);
  perform set_config('app.change_reason', p_reason, true);
  update public.submissions set escalation_level = nxt, assigned_to = coalesce(who, s.assigned_to) where id = p_submission;
end $$;

-- Resolve with a message for the parent.
create function public.staff_resolve(p_submission uuid, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions := public.cka_require_staff_case(p_submission);
begin
  if nullif(btrim(coalesce(p_message, '')), '') is null then raise exception 'A message for the parent is required'; end if;
  if s.status in ('resolved', 'closed') then raise exception 'This case is already finished'; end if;
  perform set_config('app.change_reason', p_message, true);
  update public.submissions set status = 'resolved' where id = p_submission;
end $$;

-- Grants: callable by logged-in users; each function checks the role itself.
revoke all on function
  public.staff_queue(boolean), public.staff_case(uuid), public.staff_list(), public.staff_ratings(),
  public.cka_require_staff_case(uuid), public.staff_acknowledge(uuid, text), public.staff_mark_in_progress(uuid),
  public.staff_assign(uuid, uuid), public.staff_escalate(uuid, text), public.staff_resolve(uuid, text)
from public;
grant execute on function
  public.staff_queue(boolean), public.staff_case(uuid), public.staff_list(), public.staff_ratings(),
  public.staff_acknowledge(uuid, text), public.staff_mark_in_progress(uuid),
  public.staff_assign(uuid, uuid), public.staff_escalate(uuid, text), public.staff_resolve(uuid, text)
to authenticated;
