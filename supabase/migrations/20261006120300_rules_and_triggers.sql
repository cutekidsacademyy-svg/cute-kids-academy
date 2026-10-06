-- Automatic rules (Prompt 3). These run inside the database, so they apply no matter
-- which screen or script writes the data.

create function public.cka_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.cka_touch_updated_at();

-- A child can have at most two parent accounts.
create function public.cka_limit_two_parents() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.parent_children where child_id = new.child_id) >= 2 then
    raise exception 'A child can have at most two parents';
  end if;
  return new;
end $$;
create trigger parent_children_max_two before insert on public.parent_children
  for each row execute function public.cka_limit_two_parents();

-- ---------------------------------------------------------------------------
-- Submissions: normalise on insert, guard on update, log every change
-- ---------------------------------------------------------------------------
create function public.cka_submission_before_insert() returns trigger
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
    if new.urgency = 'critical' and new.type = 'complaint' then
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
create trigger submissions_before_insert before insert on public.submissions
  for each row execute function public.cka_submission_before_insert();

create function public.cka_submission_before_update() returns trigger
language plpgsql as $$
declare
  reason text := nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), '');
  d record;
begin
  -- What the parent wrote can never be edited afterwards.
  if new.parent_id is distinct from old.parent_id or new.child_id is distinct from old.child_id
     or new.type is distinct from old.type or new.title is distinct from old.title
     or new.description is distinct from old.description or new.created_at is distinct from old.created_at
     or new.ref_no is distinct from old.ref_no then
    raise exception 'The original submission cannot be edited';
  end if;

  new.updated_at := now();

  -- A safety concern stays critical.
  if new.type = 'safety_concern' and new.urgency <> 'critical' then
    raise exception 'Safety concerns are always critical';
  end if;

  -- Changing urgency needs a reason (the parent sees it). The system (no logged-in user) is exempt.
  if new.urgency is distinct from old.urgency then
    if auth.uid() is not null and reason is null then
      raise exception 'A reason is required when changing urgency';
    end if;
    select * into d from public.cka_deadlines(new.urgency, now());
    new.acknowledge_by := case when old.acknowledged_at is null then d.acknowledge_by else new.acknowledge_by end;
    new.resolve_by := d.resolve_by;
  end if;

  if new.status in ('acknowledged', 'in_progress', 'resolved', 'closed') and new.acknowledged_at is null then
    new.acknowledged_at := now();
  end if;
  if new.status = 'resolved' and old.status <> 'resolved' then new.resolved_at := now(); end if;
  if new.status in ('received', 'acknowledged', 'in_progress') then new.resolved_at := null; end if;
  return new;
end $$;
create trigger submissions_before_update before update on public.submissions
  for each row execute function public.cka_submission_before_update();

create function public.cka_actor_name() returns text
language sql stable security definer set search_path = public as $$
  select full_name from public.profiles where id = auth.uid()
$$;

create function public.cka_person_name(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select full_name from public.profiles where id = p_id
$$;

create function public.cka_submission_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, new_value, visible_to_parent)
  values (new.id, new.parent_id, public.cka_person_name(new.parent_id), 'created', 'Submission received',
          new.urgency, true);
  return new;
end $$;
create trigger submissions_after_insert after insert on public.submissions
  for each row execute function public.cka_submission_after_insert();

-- Every status, urgency, assignment or escalation change writes a timeline row.
create function public.cka_submission_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  reason text := nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), '');
  who uuid := auth.uid();
  who_name text := public.cka_actor_name();
begin
  if new.status is distinct from old.status then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, old_value, new_value, visible_to_parent)
    values (new.id, who, who_name,
            case new.status when 'acknowledged' then 'acknowledged' when 'resolved' then 'resolved' else 'status_changed' end,
            reason, old.status, new.status, true);
  end if;
  if new.urgency is distinct from old.urgency then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, old_value, new_value, visible_to_parent)
    values (new.id, who, who_name, 'urgency_changed', reason, old.urgency, new.urgency, true);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, old_value, new_value, visible_to_parent)
    values (new.id, who, who_name, 'assigned', 'Assigned to ' || coalesce(public.cka_person_name(new.assigned_to), 'nobody'),
            old.assigned_to::text, new.assigned_to::text, true);
  end if;
  if new.escalation_level is distinct from old.escalation_level then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, old_value, new_value, visible_to_parent)
    values (new.id, who, who_name, 'escalated', coalesce(reason, 'Escalation level changed'),
            old.escalation_level::text, new.escalation_level::text, false);   -- escalation is internal
  end if;
  return new;
end $$;
create trigger submissions_after_update after update on public.submissions
  for each row execute function public.cka_submission_after_update();

-- Events are a permanent record: fill in who/when, never edit or delete.
create function public.cka_event_before_insert() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    new.actor_id := auth.uid();
    new.actor_name := public.cka_actor_name();
  end if;
  new.created_at := now();
  return new;
end $$;
create trigger submission_events_before_insert before insert on public.submission_events
  for each row execute function public.cka_event_before_insert();

create function public.cka_event_immutable() returns trigger
language plpgsql as $$
begin raise exception 'Timeline events cannot be changed or deleted'; end $$;
create trigger submission_events_no_update before update or delete on public.submission_events
  for each row execute function public.cka_event_immutable();

-- ---------------------------------------------------------------------------
-- Ratings: the class is taken from the child, never from the client
-- ---------------------------------------------------------------------------
create function public.cka_rating_before_insert() returns trigger
language plpgsql as $$
begin
  new.parent_id := coalesce(auth.uid(), new.parent_id);
  new.class_id := (select class_id from public.children where id = new.child_id);
  new.month := (date_trunc('month', now() at time zone 'Africa/Cairo'))::date;
  new.created_at := now();
  return new;
end $$;
create trigger ratings_before_insert before insert on public.ratings
  for each row execute function public.cka_rating_before_insert();

-- ---------------------------------------------------------------------------
-- Investigations: steps in order, no skipping, closing needs findings + actions
-- ---------------------------------------------------------------------------
create function public.cka_investigation_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.investigation_steps (investigation_id, step, completed_by) values (new.id, 'opened', auth.uid());
  insert into public.investigation_internal (investigation_id) values (new.id);
  return new;
end $$;
create trigger investigations_after_insert after insert on public.investigations
  for each row execute function public.cka_investigation_after_insert();

create function public.cka_step_before_insert() returns trigger
language plpgsql as $$
declare
  order_ text[] := array['opened', 'parent_called', 'facts_gathered', 'findings', 'actions_taken', 'parent_informed', 'closed'];
  idx int := array_position(order_, new.step);
  done int := (select count(*) from public.investigation_steps where investigation_id = new.investigation_id);
begin
  if idx is distinct from done + 1 then
    raise exception 'Investigation steps cannot be skipped: next step is %', order_[done + 1];
  end if;
  new.completed_by := coalesce(auth.uid(), new.completed_by);
  new.completed_at := now();

  if new.step = 'findings' and coalesce(btrim((select findings_for_parent from public.investigations where id = new.investigation_id)), '') = '' then
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
create trigger investigation_steps_before_insert before insert on public.investigation_steps
  for each row execute function public.cka_step_before_insert();

create function public.cka_step_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare sub uuid;
begin
  if new.step = 'closed' then
    update public.investigations set status = 'closed', closed_at = now() where id = new.investigation_id;
  end if;
  -- Parents see step names and dates on the case timeline.
  select submission_id into sub from public.investigations where id = new.investigation_id;
  if sub is not null then
    insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, new_value, visible_to_parent)
    values (sub, new.completed_by, public.cka_person_name(new.completed_by), 'investigation_step', null, new.step, true);
  end if;
  return new;
end $$;
create trigger investigation_steps_after_insert after insert on public.investigation_steps
  for each row execute function public.cka_step_after_insert();

create function public.cka_steps_immutable() returns trigger
language plpgsql as $$
begin raise exception 'Investigation steps cannot be changed or deleted'; end $$;
create trigger investigation_steps_no_change before update or delete on public.investigation_steps
  for each row execute function public.cka_steps_immutable();

create trigger investigation_internal_touch before update on public.investigation_internal
  for each row execute function public.cka_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Actions that need a rule bigger than "can this user update this row"
-- ---------------------------------------------------------------------------

-- Staff: change urgency, with a reason the parent will see.
create function public.change_urgency(p_submission uuid, p_urgency text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.staff_can_see_submission(p_submission) then raise exception 'Not allowed'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required'; end if;
  perform set_config('app.change_reason', p_reason, true);
  update public.submissions set urgency = p_urgency where id = p_submission;
end $$;

-- Parent: "Are you satisfied with how this was handled?"  Yes closes it; No reopens it
-- and moves it up one escalation level.
create function public.respond_to_resolution(p_submission uuid, p_satisfied boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.submissions;
begin
  select * into s from public.submissions where id = p_submission;
  if s.id is null or not public.owns_submission(p_submission) then raise exception 'Not allowed'; end if;
  if s.status <> 'resolved' then raise exception 'This submission has not been resolved yet'; end if;

  if p_satisfied then
    update public.submissions set status = 'closed', parent_satisfied = true where id = p_submission;
    insert into public.submission_events (submission_id, event_type, message, visible_to_parent)
    values (p_submission, 'satisfaction', 'Parent confirmed they are satisfied', true);
  else
    perform set_config('app.change_reason', 'Parent was not satisfied; reopened', true);
    update public.submissions
       set status = 'in_progress', parent_satisfied = false, escalation_level = least(escalation_level + 1, 4)
     where id = p_submission;
    insert into public.submission_events (submission_id, event_type, message, visible_to_parent)
    values (p_submission, 'reopened', 'Parent was not satisfied; case reopened', true);
  end if;
end $$;

-- Parent: "I've read this report" on an accident report. Records the time once.
create function public.mark_incident_read(p_incident uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'parent'
     or not public.can_see_child((select child_id from public.incidents where id = p_incident)) then
    raise exception 'Not allowed';
  end if;
  update public.incidents set parent_signed_at = now() where id = p_incident and parent_signed_at is null;
end $$;

-- Parent: acknowledge an investigation outcome, or disagree (which escalates a linked case to the owner).
create function public.respond_to_investigation(p_investigation uuid, p_response text) returns void
language plpgsql security definer set search_path = public as $$
declare inv public.investigations;
begin
  if p_response not in ('acknowledged', 'disagreed') then raise exception 'Invalid response'; end if;
  select * into inv from public.investigations where id = p_investigation;
  if inv.id is null or not public.parent_owns_investigation(p_investigation) then raise exception 'Not allowed'; end if;
  if coalesce(btrim(inv.findings_for_parent), '') = '' then raise exception 'There are no findings to respond to yet'; end if;

  update public.investigations set parent_response = p_response, parent_responded_at = now() where id = p_investigation;
  if p_response = 'disagreed' and inv.submission_id is not null then
    perform set_config('app.change_reason', 'Parent disagrees with the investigation outcome', true);
    update public.submissions set escalation_level = 4 where id = inv.submission_id;
  end if;
end $$;

revoke all on function
  public.change_urgency(uuid, text, text), public.respond_to_resolution(uuid, boolean),
  public.mark_incident_read(uuid), public.respond_to_investigation(uuid, text),
  public.cka_person_name(uuid)
from public;
grant execute on function
  public.change_urgency(uuid, text, text), public.respond_to_resolution(uuid, boolean),
  public.mark_incident_read(uuid), public.respond_to_investigation(uuid, text)
to authenticated;
