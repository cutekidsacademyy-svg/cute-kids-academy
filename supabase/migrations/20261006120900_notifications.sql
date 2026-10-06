-- Notifications and the deadline clock (Prompt 8).
--   * Emails are written to a queue (email_outbox); a Vercel function sends them through Resend.
--   * Deadline checker: warns the assigned person 1 hour before a deadline, and escalates a case
--     one level when a deadline is missed. Non-critical deadlines pause outside working hours
--     (Sunday-Thursday 08:00-18:00 Cairo); critical items are handled at any hour.
--   * Nothing is sent twice for the same deadline.
-- Parent emails are deliberately short: they say there is news and link to the portal, so a
-- child's private details are never sent by email.

alter table public.submissions add column next_escalation_at timestamptz;   -- internal escalation clock

create table public.email_outbox (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles (id),
  to_email    text not null,
  language    text not null check (language in ('ar', 'en')),
  template    text not null,
  payload     jsonb not null default '{}',
  status      text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts    int not null default 0,
  last_error  text,
  dedupe_key  text unique,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index email_outbox_pending_idx on public.email_outbox (created_at) where status = 'pending';

create table public.deadline_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id),
  kind          text not null check (kind in ('ack', 'resolve')),
  deadline      timestamptz not null,
  action        text not null check (action in ('warned', 'escalated', 'top')),
  level         smallint not null default 0,
  created_at    timestamptz not null default now(),
  unique (submission_id, kind, deadline, action, level)
);

-- Only the server (service key) touches these.
alter table public.email_outbox enable row level security;
alter table public.deadline_events enable row level security;
revoke all on public.email_outbox, public.deadline_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.cka_in_working_hours(p_ts timestamptz) returns boolean
language plpgsql immutable as $$
declare l timestamp := p_ts at time zone 'Africa/Cairo';
begin
  return public.cka_is_work_day(l::date) and l::time >= time '08:00' and l::time < time '18:00';
end $$;

create function public.cka_enqueue_email(p_user uuid, p_template text, p_payload jsonb, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e text; lang text;
begin
  select u.email, p.language into e, lang
    from auth.users u join public.profiles p on p.id = u.id
   where u.id = p_user and p.active;
  if e is null then return; end if;
  insert into public.email_outbox (user_id, to_email, language, template, payload, dedupe_key)
  values (p_user, e, lang, p_template, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

-- Who is told about a case: the person it is assigned to, otherwise the people for its level.
create function public.cka_alert_recipients(p_assigned uuid, p_level int, p_child uuid) returns setof uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if p_assigned is not null and exists (select 1 from public.profiles where id = p_assigned and active) then
    return next p_assigned; return;
  end if;
  if p_level = 2 then
    return query select cl.head_teacher_id from public.children c join public.classes cl on cl.id = c.class_id
                  join public.profiles h on h.id = cl.head_teacher_id and h.active where c.id = p_child;
    if found then return; end if;
  end if;
  if p_level >= 4 then
    return query select id from public.profiles where role = 'owner' and active;
  elsif p_level = 3 then
    return query select id from public.profiles where role = 'manager' and active;
  else
    return query select id from public.profiles where role = 'admin' and active;
  end if;
  if not found then
    return query select id from public.profiles where role in ('manager', 'owner') and active;
  end if;
end $$;

create function public.cka_case_payload(s public.submissions) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', s.id, 'ref_no', s.ref_no, 'title', s.title, 'urgency', s.urgency,
                            'level', s.escalation_level, 'acknowledge_by', s.acknowledge_by, 'resolve_by', s.resolve_by)
$$;

-- ---------------------------------------------------------------------------
-- Emails triggered by what happens to a case
-- ---------------------------------------------------------------------------
create function public.cka_notify_submission_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  perform public.cka_enqueue_email(new.parent_id, 'received', public.cka_case_payload(new), 'received:' || new.id);
  if new.assigned_to is not null then
    perform public.cka_enqueue_email(new.assigned_to, 'assigned', public.cka_case_payload(new), 'assigned:' || new.id || ':' || new.assigned_to);
  end if;
  if new.urgency = 'critical' then
    for u in select id from public.profiles where role in ('manager', 'owner') and active loop
      perform public.cka_enqueue_email(u, 'critical_alert', public.cka_case_payload(new), 'critical:' || new.id || ':' || u);
    end loop;
  end if;
  return new;
end $$;
create trigger submissions_after_insert_notify after insert on public.submissions
  for each row execute function public.cka_notify_submission_insert();

create function public.cka_notify_submission_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  reason text := nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), '');
  u uuid;
begin
  if new.status is distinct from old.status then
    if new.status = 'acknowledged' then
      perform public.cka_enqueue_email(new.parent_id, 'acknowledged', public.cka_case_payload(new), 'ack:' || new.id);
    elsif new.status = 'resolved' then
      perform public.cka_enqueue_email(new.parent_id, 'resolved', public.cka_case_payload(new), 'resolved:' || new.id || ':' || extract(epoch from now())::bigint);
    end if;
  end if;
  if new.urgency is distinct from old.urgency then
    perform public.cka_enqueue_email(new.parent_id, 'urgency_changed',
      public.cka_case_payload(new) || jsonb_build_object('old_urgency', old.urgency, 'reason', reason),
      'urgency:' || new.id || ':' || extract(epoch from now())::bigint);
    if new.urgency = 'critical' then
      for u in select id from public.profiles where role in ('manager', 'owner') and active loop
        perform public.cka_enqueue_email(u, 'critical_alert', public.cka_case_payload(new), 'critical:' || new.id || ':' || u);
      end loop;
    end if;
  end if;
  if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null
     and new.assigned_to is distinct from auth.uid()
     and coalesce(current_setting('app.suppress_assign_email', true), '') <> '1' then
    perform public.cka_enqueue_email(new.assigned_to, 'assigned', public.cka_case_payload(new),
      'assigned:' || new.id || ':' || new.assigned_to || ':' || extract(epoch from now())::bigint);
  end if;
  return new;
end $$;
create trigger submissions_after_update_notify after update on public.submissions
  for each row execute function public.cka_notify_submission_update();

-- A staff update on a case: tell the parent there is news (not what it says).
create function public.cka_notify_event_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.submissions;
begin
  if new.event_type = 'update' and new.visible_to_parent then
    select * into s from public.submissions where id = new.submission_id;
    perform public.cka_enqueue_email(s.parent_id, 'update_added', public.cka_case_payload(s), 'update:' || new.id);
  end if;
  return new;
end $$;
create trigger submission_events_after_insert_notify after insert on public.submission_events
  for each row execute function public.cka_notify_event_insert();

-- Investigation steps: tell the parent(s) a step was completed (the automatic "opened" step is skipped).
create function public.cka_notify_step_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.investigations; sub public.submissions; child uuid; p uuid; payload jsonb;
begin
  if new.step = 'opened' then return new; end if;
  select * into inv from public.investigations where id = new.investigation_id;
  if inv.submission_id is not null then
    select * into sub from public.submissions where id = inv.submission_id;
    perform public.cka_enqueue_email(sub.parent_id, 'investigation_step',
      public.cka_case_payload(sub) || jsonb_build_object('step', new.step), 'step:' || new.id || ':' || sub.parent_id);
  else
    select child_id into child from public.incidents where id = inv.incident_id;
    for p in select parent_id from public.parent_children where child_id = child loop
      perform public.cka_enqueue_email(p, 'investigation_step', jsonb_build_object('step', new.step, 'accident', true), 'step:' || new.id || ':' || p);
    end loop;
  end if;
  return new;
end $$;
create trigger investigation_steps_after_insert_notify after insert on public.investigation_steps
  for each row execute function public.cka_notify_step_insert();

-- An accident: both parents are told there is a report (no details in the email); a serious one also alerts management.
create function public.cka_notify_incident_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p uuid;
begin
  for p in select parent_id from public.parent_children where child_id = new.child_id loop
    perform public.cka_enqueue_email(p, 'accident_report', jsonb_build_object('incident_id', new.id), 'accident:' || new.id || ':' || p);
  end loop;
  if new.severity = 'serious' then
    for p in select id from public.profiles where role in ('manager', 'owner') and active loop
      perform public.cka_enqueue_email(p, 'serious_accident', jsonb_build_object('incident_id', new.id), 'serious:' || new.id || ':' || p);
    end loop;
  end if;
  return new;
end $$;
create trigger incidents_after_insert_notify after insert on public.incidents
  for each row execute function public.cka_notify_incident_insert();

-- ---------------------------------------------------------------------------
-- The deadline clock. Run every 15 minutes by the scheduler (see supabase/schedule-emails.sql).
-- ---------------------------------------------------------------------------
create function public.cka_run_deadline_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.submissions;
  d record; r uuid; ins int;
  warned int := 0; escalated int := 0; top int := 0; requeued int := 0;
  in_hours boolean := public.cka_in_working_hours(p_now);
  newlvl int; who uuid; next_at timestamptz;
begin
  -- Staff are told by the "escalated" email below, not also by the generic "assigned" one.
  perform set_config('app.suppress_assign_email', '1', true);

  for s in select * from public.submissions where status in ('received', 'acknowledged', 'in_progress') order by created_at loop
    for d in select * from (values
               ('ack', case when s.acknowledged_at is null then s.acknowledge_by end),
               ('resolve', s.resolve_by)) as t(kind, deadline) loop
      continue when d.deadline is null;
      continue when not in_hours and s.urgency <> 'critical';        -- deadlines pause outside working hours

      -- 1 hour before: warn whoever is handling it (once per deadline)
      if p_now < d.deadline and p_now >= d.deadline - interval '1 hour' and not (s.urgency = 'critical' and d.kind = 'ack') then
        insert into public.deadline_events (submission_id, kind, deadline, action, level)
        values (s.id, d.kind, d.deadline, 'warned', 0) on conflict do nothing;
        get diagnostics ins = row_count;
        if ins = 1 then
          for r in select * from public.cka_alert_recipients(s.assigned_to, s.escalation_level, s.child_id) loop
            perform public.cka_enqueue_email(r, 'deadline_warning', public.cka_case_payload(s) || jsonb_build_object('kind', d.kind, 'deadline', d.deadline),
              'warn:' || s.id || ':' || d.kind || ':' || extract(epoch from d.deadline)::bigint || ':' || r);
          end loop;
          warned := warned + 1;
        end if;
      end if;

      -- missed: move up one level (at most once per escalation window)
      if p_now >= d.deadline and (s.next_escalation_at is null or p_now >= s.next_escalation_at) then
        if s.escalation_level < 4 then
          newlvl := s.escalation_level + 1;
          who := public.cka_level_assignee(newlvl, s.child_id, s.about_staff_member);
          next_at := case when s.urgency = 'critical' then p_now + interval '1 hour'
                          else public.cka_add_working_hours(p_now at time zone 'Africa/Cairo', 2) at time zone 'Africa/Cairo' end;
          perform set_config('app.change_reason', 'escalated automatically: deadline missed', true);
          update public.submissions
             set escalation_level = newlvl, assigned_to = coalesce(who, assigned_to), next_escalation_at = next_at
           where id = s.id;
          insert into public.deadline_events (submission_id, kind, deadline, action, level)
          values (s.id, d.kind, d.deadline, 'escalated', newlvl) on conflict do nothing;
          for r in select * from public.cka_alert_recipients(who, newlvl, s.child_id) loop
            perform public.cka_enqueue_email(r, 'escalated', public.cka_case_payload(s) || jsonb_build_object('kind', d.kind, 'deadline', d.deadline, 'level', newlvl),
              'esc:' || s.id || ':' || newlvl || ':' || extract(epoch from d.deadline)::bigint || ':' || r);
          end loop;
          escalated := escalated + 1;
        else
          -- already with the owner: tell the owner once that it is overdue
          insert into public.deadline_events (submission_id, kind, deadline, action, level)
          values (s.id, d.kind, d.deadline, 'top', 4) on conflict do nothing;
          get diagnostics ins = row_count;
          if ins = 1 then
            for r in select id from public.profiles where role = 'owner' and active loop
              perform public.cka_enqueue_email(r, 'overdue_top', public.cka_case_payload(s) || jsonb_build_object('kind', d.kind, 'deadline', d.deadline),
                'top:' || s.id || ':' || d.kind || ':' || extract(epoch from d.deadline)::bigint || ':' || r);
            end loop;
            top := top + 1;
          end if;
        end if;
        exit;     -- one escalation per case per run
      end if;
    end loop;
  end loop;

  -- Emails stuck "sending" for 10 minutes (the sender crashed) go back in the queue.
  update public.email_outbox set status = 'pending' where status = 'sending' and claimed_at < p_now - interval '10 minutes';
  get diagnostics requeued = row_count;

  return jsonb_build_object('warned', warned, 'escalated', escalated, 'overdue_at_top', top, 'requeued', requeued, 'in_working_hours', in_hours);
end $$;

-- Only the server (service key) may run the checker or touch the queue helpers.
revoke all on function
  public.cka_in_working_hours(timestamptz), public.cka_enqueue_email(uuid, text, jsonb, text),
  public.cka_alert_recipients(uuid, int, uuid), public.cka_case_payload(public.submissions),
  public.cka_run_deadline_check(timestamptz)
from public;
grant execute on function public.cka_run_deadline_check(timestamptz) to service_role;
