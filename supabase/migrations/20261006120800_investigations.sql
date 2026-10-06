-- Investigation workflow (Prompt 7).
--   * A safety concern opens an investigation automatically, assigned to a manager.
--   * Findings for the parent are WRITTEN as a draft (manager/owner only) and only become visible
--     to the parent when the "findings" step is completed, so a half-written draft never leaks.
--   * A warning function spots other children's names in the findings before they are published.
--   * Manager/owner list and detail functions, including how long each investigation took.

-- ---------------------------------------------------------------------------
-- Draft findings live with the internal (manager/owner-only) data
-- ---------------------------------------------------------------------------
alter table public.investigation_internal add column findings_draft text;

-- Edits go through save_investigation() (below), not direct table updates.
revoke update on public.investigations, public.investigation_internal from authenticated;
grant update (assigned_to) on public.investigations to authenticated;

-- ---------------------------------------------------------------------------
-- "Opened" step: record the manager/owner who opened it, or nobody (the system) when it
-- opened automatically from a parent's submission or a teacher's accident report.
-- ---------------------------------------------------------------------------
create or replace function public.cka_investigation_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.investigation_steps (investigation_id, step, completed_by)
  values (new.id, 'opened', case when public.auth_role() in ('manager', 'owner') then auth.uid() end);
  insert into public.investigation_internal (investigation_id) values (new.id);
  return new;
end $$;

-- A safety concern opens an investigation, assigned to a manager.
create function public.cka_submission_open_investigation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'safety_concern' then
    insert into public.investigations (submission_id, assigned_to)
    values (new.id, public.cka_level_assignee(3, new.child_id, new.about_staff_member))
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger submissions_after_insert_investigation after insert on public.submissions
  for each row execute function public.cka_submission_open_investigation();

-- ---------------------------------------------------------------------------
-- Steps: in order, never skipped. "Findings" needs something to publish; "closed" needs the
-- published findings AND the actions taken. Completing "findings" publishes the draft.
-- ---------------------------------------------------------------------------
create or replace function public.cka_step_before_insert() returns trigger
language plpgsql as $$
declare
  order_ text[] := array['opened', 'parent_called', 'facts_gathered', 'findings', 'actions_taken', 'parent_informed', 'closed'];
  idx int := array_position(order_, new.step);
  done int := (select count(*) from public.investigation_steps where investigation_id = new.investigation_id);
begin
  if idx is distinct from done + 1 then
    raise exception 'Investigation steps cannot be skipped: next step is %', order_[done + 1];
  end if;
  -- Credit the manager/owner completing the step. A step recorded while a parent or teacher is
  -- logged in (the automatic "opened" step) is credited to the system, never to them.
  new.completed_by := case when public.auth_role() in ('manager', 'owner') then auth.uid() else new.completed_by end;
  new.completed_at := now();

  if new.step = 'findings' and
     coalesce(nullif(btrim((select findings_draft from public.investigation_internal where investigation_id = new.investigation_id)), ''),
              nullif(btrim((select findings_for_parent from public.investigations where id = new.investigation_id)), '')) is null then
    raise exception 'Write the findings for the parent before completing the findings step';
  end if;
  if new.step = 'closed' then
    if coalesce(btrim((select findings_for_parent from public.investigations where id = new.investigation_id)), '') = ''
       or coalesce(btrim((select actions_taken from public.investigation_internal where investigation_id = new.investigation_id)), '') = '' then
      raise exception 'Closing requires findings for the parent and actions taken';
    end if;
  end if;
  return new;
end $$;

create or replace function public.cka_step_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare sub uuid;
begin
  if new.step = 'findings' then
    update public.investigations i
       set findings_for_parent = coalesce(
             nullif(btrim((select d.findings_draft from public.investigation_internal d where d.investigation_id = i.id)), ''),
             i.findings_for_parent)
     where i.id = new.investigation_id;
  end if;
  if new.step = 'closed' then
    update public.investigations set status = 'closed', closed_at = now() where id = new.investigation_id;
  end if;
  select submission_id into sub from public.investigations where id = new.investigation_id;
  if sub is not null then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, new_value, visible_to_parent)
    values (sub, new.completed_by, public.cka_person_name(new.completed_by), 'investigation_step', null, new.step, true);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Writing the investigation (manager / owner)
-- ---------------------------------------------------------------------------
create function public.save_investigation(p_id uuid, p_findings text, p_internal text, p_statements text, p_actions text)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.investigations; published boolean;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  select * into inv from public.investigations where id = p_id;
  if inv.id is null then raise exception 'Not found'; end if;
  if inv.status = 'closed' then raise exception 'This investigation is closed and can no longer be changed'; end if;
  published := exists (select 1 from public.investigation_steps where investigation_id = p_id and step = 'findings');
  if published and nullif(btrim(coalesce(p_findings, '')), '') is null then
    raise exception 'The findings for the parent have been shared, so they cannot be left empty';
  end if;
  update public.investigation_internal
     set findings_draft = p_findings, internal_findings = p_internal, staff_statements = p_statements, actions_taken = p_actions
   where investigation_id = p_id;
  if published then
    update public.investigations set findings_for_parent = p_findings where id = p_id;   -- keep the shared text in step
  end if;
end $$;

-- Names of OTHER children found in a text. The family's own children are excluded.
-- Matches the full name or the first name (3+ letters) as a whole word; a "(seed)" test suffix is ignored.
create function public.investigation_name_warnings(p_id uuid, p_text text) returns setof text
language plpgsql stable security definer set search_path = public as $$
declare norm text;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  norm := ' ' || regexp_replace(lower(coalesce(p_text, '')), '[\s.,;:!?"''()\[\]{}/\\-]+|[،؛؟]+', ' ', 'g') || ' ';
  return query
  with inv as (
    select coalesce(s.child_id, n.child_id) as case_child
    from public.investigations i
    left join public.submissions s on s.id = i.submission_id
    left join public.incidents n on n.id = i.incident_id
    where i.id = p_id),
  own as (
    select inv.case_child as child_id from inv
    union
    select pc2.child_id from inv
      join public.parent_children pc on pc.child_id = inv.case_child
      join public.parent_children pc2 on pc2.parent_id = pc.parent_id),
  cand as (
    select btrim(regexp_replace(c.full_name, '\s*\(seed\)\s*$', '', 'i')) as clean
    from public.children c where c.id not in (select child_id from own))
  select distinct cand.clean from cand
  where position(' ' || lower(cand.clean) || ' ' in norm) > 0
     or (length(split_part(cand.clean, ' ', 1)) >= 3
         and position(' ' || lower(split_part(cand.clean, ' ', 1)) || ' ' in norm) > 0)
  order by 1;
end $$;

-- ---------------------------------------------------------------------------
-- Reading (manager / owner)
-- ---------------------------------------------------------------------------
create function public.staff_investigations()
returns table (
  id uuid, status text, opened_at timestamptz, closed_at timestamptz, hours_taken numeric,
  steps_done int, current_step text, assigned_name text, parent_response text,
  kind text, ref_no bigint, headline text, child_name text, severity text
)
language sql stable security definer set search_path = public as $$
  select i.id, i.status, i.opened_at, i.closed_at,
         round((extract(epoch from (coalesce(i.closed_at, now()) - i.opened_at)) / 3600)::numeric, 1),
         (select count(*)::int from public.investigation_steps st where st.investigation_id = i.id),
         (select st.step from public.investigation_steps st where st.investigation_id = i.id order by st.completed_at desc, st.id desc limit 1),
         a.full_name, i.parent_response,
         case when i.incident_id is not null then 'accident' else 'safety_concern' end,
         s.ref_no, coalesce(s.title, left(n.what_happened, 80)),
         c.full_name, n.severity
  from public.investigations i
  left join public.submissions s on s.id = i.submission_id
  left join public.incidents n on n.id = i.incident_id
  join public.children c on c.id = coalesce(s.child_id, n.child_id)
  left join public.profiles a on a.id = i.assigned_to
  where public.is_manager_or_owner()
  order by (i.status = 'closed'), i.opened_at desc
$$;

create function public.staff_investigation(p_id uuid)
returns table (
  id uuid, status text, opened_at timestamptz, closed_at timestamptz, hours_taken numeric,
  assigned_name text, parent_response text, parent_responded_at timestamptz,
  findings_for_parent text, findings_draft text, internal_findings text, staff_statements text, actions_taken text,
  kind text, submission_id uuid, ref_no bigint, headline text, description text, child_name text, severity text,
  occurred_at timestamptz, location text
)
language sql stable security definer set search_path = public as $$
  select i.id, i.status, i.opened_at, i.closed_at,
         round((extract(epoch from (coalesce(i.closed_at, now()) - i.opened_at)) / 3600)::numeric, 1),
         a.full_name, i.parent_response, i.parent_responded_at,
         i.findings_for_parent, x.findings_draft, x.internal_findings, x.staff_statements, x.actions_taken,
         case when i.incident_id is not null then 'accident' else 'safety_concern' end,
         i.submission_id, s.ref_no, coalesce(s.title, left(n.what_happened, 80)), coalesce(s.description, n.what_happened),
         c.full_name, n.severity, n.occurred_at, n.location
  from public.investigations i
  join public.investigation_internal x on x.investigation_id = i.id
  left join public.submissions s on s.id = i.submission_id
  left join public.incidents n on n.id = i.incident_id
  join public.children c on c.id = coalesce(s.child_id, n.child_id)
  left join public.profiles a on a.id = i.assigned_to
  where i.id = p_id and public.is_manager_or_owner()
$$;

-- staff_case now also says which investigation belongs to the case (manager/owner only).
drop function public.staff_case(uuid);
create function public.staff_case(p_id uuid)
returns table (
  id uuid, ref_no bigint, type text, title text, description text, urgency text, status text,
  escalation_level smallint, created_at timestamptz, acknowledge_by timestamptz, resolve_by timestamptz,
  acknowledged_at timestamptz, resolved_at timestamptz, parent_satisfied boolean,
  child_id uuid, child_name text, class_name text, parent_name text, parent_phone text,
  assigned_to uuid, assignee_name text, about_staff_name text, has_investigation boolean, investigation_id uuid
)
language sql stable security definer set search_path = public as $$
  select s.id, s.ref_no, s.type, s.title, s.description, s.urgency, s.status, s.escalation_level,
         s.created_at, s.acknowledge_by, s.resolve_by, s.acknowledged_at, s.resolved_at, s.parent_satisfied,
         s.child_id, c.full_name, cl.name, pp.full_name, pp.phone,
         s.assigned_to, a.full_name,
         case when public.is_management() then ab.full_name end,
         public.is_management() and exists (select 1 from public.investigations i where i.submission_id = s.id),
         case when public.is_manager_or_owner() then (select i.id from public.investigations i where i.submission_id = s.id) end
  from public.submissions s
  join public.children c on c.id = s.child_id
  left join public.classes cl on cl.id = c.class_id
  join public.profiles pp on pp.id = s.parent_id
  left join public.profiles a on a.id = s.assigned_to
  left join public.profiles ab on ab.id = s.about_staff_member
  where s.id = p_id and public.staff_can_see_submission(s.id)
$$;

revoke all on function
  public.save_investigation(uuid, text, text, text, text), public.investigation_name_warnings(uuid, text),
  public.staff_investigations(), public.staff_investigation(uuid), public.staff_case(uuid)
from public;
grant execute on function
  public.save_investigation(uuid, text, text, text, text), public.investigation_name_warnings(uuid, text),
  public.staff_investigations(), public.staff_investigation(uuid), public.staff_case(uuid)
to authenticated;
