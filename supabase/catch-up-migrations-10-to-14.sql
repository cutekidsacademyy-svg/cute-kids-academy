-- CATCH-UP: migrations 10 to 14 (everything added after the first nine). Paste into the Supabase SQL editor and run ONCE.
-- The first nine were already applied from all-migrations.sql earlier. Migration 14 (hardening) is last on purpose.
-- Generated from supabase/migrations/*.sql: do not edit (see README).

-- ============================================================
-- migrations/20261006120900_notifications.sql
-- ============================================================
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

-- ============================================================
-- migrations/20261006121000_reports.sql
-- ============================================================
-- Manager and owner reports (Prompt 9). One function returns every number for a period, so the
-- page, the CSV download and the tests all use the same source. Manager and owner only.
--
-- Definitions (all dates are Cairo time, the period runs from the start of p_from to the end of p_to):
--   * Cases are counted by the day they were received.
--   * "Acknowledged on time" = acknowledged by the promised time, out of the cases whose acknowledge
--     deadline has passed or that were acknowledged. "Resolved on time" works the same way.
--   * "Overdue now" and "investigations still open" are about right now, not the period.
--   * Average time to resolve is wall-clock hours from received to resolved.
--   * Escalations come from the case timeline (each time a case moved up a level in the period).
--   * Ratings: this is the month containing the end of the period, compared with the month before.

create function public.staff_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f timestamptz; t timestamptz; m0 date; m1 date; out jsonb;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid period'; end if;
  if p_to - p_from > 800 then raise exception 'The period is too long'; end if;

  f := p_from::timestamp at time zone 'Africa/Cairo';
  t := (p_to + 1)::timestamp at time zone 'Africa/Cairo';
  m0 := date_trunc('month', p_to)::date;
  m1 := (m0 - interval '1 month')::date;

  with
  subs as (select * from public.submissions where created_at >= f and created_at < t),
  ack as (select * from subs where acknowledged_at is not null or acknowledge_by <= now()),
  res as (select * from subs where resolved_at is not null or resolve_by <= now()),
  esc as (select e.* from public.submission_events e where e.event_type = 'escalated' and e.created_at >= f and e.created_at < t),
  inc as (select i.*, coalesce(cl.name, '—') as class_name from public.incidents i
            join public.children c on c.id = i.child_id left join public.classes cl on cl.id = c.class_id
           where i.occurred_at >= f and i.occurred_at < t),
  rat as (select r.*, coalesce(cl.name, '—') as class_name from public.ratings r left join public.classes cl on cl.id = r.class_id)
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', jsonb_build_object(
        'received', (select count(*) from subs),
        'open_now', (select count(*) from public.submissions where status in ('received', 'acknowledged', 'in_progress')),
        'overdue_now', (select count(*) from public.submissions s
                         where (s.status = 'received' and s.acknowledge_by < now())
                            or (s.status in ('acknowledged', 'in_progress') and s.resolve_by < now()))),
    'by_type_urgency', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'urgency', urgency, 'count', n) order by type, urgency)
                                   from (select type, urgency, count(*) n from subs group by 1, 2) x), '[]'),
    'on_time', jsonb_build_object(
        'acknowledged', jsonb_build_object(
            'due', (select count(*) from ack),
            'on_time', (select count(*) from ack where acknowledged_at is not null and acknowledged_at <= acknowledge_by)),
        'resolved', jsonb_build_object(
            'due', (select count(*) from res),
            'on_time', (select count(*) from res where resolved_at is not null and resolved_at <= resolve_by))),
    'avg_resolve_hours', (select round((avg(extract(epoch from (resolved_at - created_at))) / 3600)::numeric, 1) from subs where resolved_at is not null),
    'escalations', jsonb_build_object(
        'cases', (select count(distinct submission_id) from esc),
        'moves', (select count(*) from esc),
        'by_level', coalesce((select jsonb_agg(jsonb_build_object('level', lvl, 'count', n) order by lvl)
                                from (select new_value::int as lvl, count(*) n from esc group by 1) x), '[]')),
    'satisfaction', jsonb_build_object(
        'yes', (select count(*) from subs where parent_satisfied is true),
        'no', (select count(*) from subs where parent_satisfied is false),
        'waiting', (select count(*) from subs where status = 'resolved' and parent_satisfied is null)),
    'incidents', jsonb_build_object(
        'total', (select count(*) from inc),
        'by_class', coalesce((select jsonb_agg(jsonb_build_object('name', class_name, 'count', n) order by n desc, class_name)
                                from (select class_name, count(*) n from inc group by 1) x), '[]'),
        'by_location', coalesce((select jsonb_agg(jsonb_build_object('name', loc, 'count', n) order by n desc, loc)
                                   from (select min(btrim(location)) as loc, count(*) n from inc group by lower(btrim(location))) x), '[]'),
        'by_severity', coalesce((select jsonb_agg(jsonb_build_object('name', severity, 'count', n) order by severity)
                                   from (select severity, count(*) n from inc group by 1) x), '[]'),
        'open_investigations', (select count(*) from public.investigations where status = 'open')),
    'ratings', jsonb_build_object(
        'month', m0, 'previous_month', m1,
        'classes', coalesce((select jsonb_agg(jsonb_build_object(
              'name', c.class_name,
              'count', c.n, 'care', c.care, 'communication', c.comm, 'daily', c.daily,
              'prev_count', coalesce(p.n, 0), 'prev_care', p.care, 'prev_communication', p.comm, 'prev_daily', p.daily) order by c.class_name)
            from (select class_name, count(*) n, round(avg(care_score), 2) care, round(avg(communication_score), 2) comm, round(avg(daily_reports_score), 2) daily
                    from rat where month = m0 group by 1) c
            left join (select class_name, count(*) n, round(avg(care_score), 2) care, round(avg(communication_score), 2) comm, round(avg(daily_reports_score), 2) daily
                         from rat where month = m1 group by 1) p on p.class_name = c.class_name), '[]'),
        'compliments', coalesce((select jsonb_agg(jsonb_build_object('staff', staff, 'count', n, 'items', items) order by n desc, staff)
            from (select coalesce(st.full_name, '—') as staff, count(*) n,
                         jsonb_agg(jsonb_build_object('month', r.month, 'text', r.compliment_text) order by r.created_at) as items
                    from public.ratings r left join public.profiles st on st.id = r.compliment_staff_id
                   where r.created_at >= f and r.created_at < t and (r.compliment_staff_id is not null or nullif(btrim(r.compliment_text), '') is not null)
                   group by 1) x), '[]'))
  ) into out;

  return out;
end $$;

revoke all on function public.staff_report(date, date) from public;
grant execute on function public.staff_report(date, date) to authenticated;

-- ============================================================
-- migrations/20261006121100_owner_dashboard.sql
-- ============================================================
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

-- ============================================================
-- migrations/20261006121200_owner_routines.sql
-- ============================================================
-- The owner's daily routine (Prompt 21, "Owner"): a morning-walk and afternoon checklist, a task
-- tracker, and reminders (9:00, 16:30, Thursday review, monthly review). Owner-only, like the rest of
-- the owner's private area. Times are Cairo time; reminders only go out on working days (Sun-Thu).
--
-- The checklist items below are PLACEHOLDERS (the plan says 6 morning checks and 4 afternoon checks
-- but does not list them). The owner edits, adds and switches off items on the Checklist screen.

create table public.checklist_items (
  id         uuid primary key default gen_random_uuid(),
  list       text not null check (list in ('morning', 'afternoon')),
  position   int  not null default 0,
  label      text not null check (length(btrim(label)) > 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.checklist_items (list, position, label) values
  ('morning', 1, 'Entrance and reception are tidy and safe'),
  ('morning', 2, 'Every classroom is clean and ready'),
  ('morning', 3, 'Staff are present and on time'),
  ('morning', 4, 'Allergy list is visible in the kitchen and classrooms'),
  ('morning', 5, 'Outdoor area checked for hazards'),
  ('morning', 6, 'Children are welcomed warmly at arrival'),
  ('afternoon', 1, 'Daily reports are written and sent'),
  ('afternoon', 2, 'Cleaning log is signed'),
  ('afternoon', 3, 'Children are handed over to authorised people only'),
  ('afternoon', 4, 'Rooms are tidied and secured');

-- One row per item per day: ok = everything fine, not ok = needs attention (with a note).
create table public.checklist_checks (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.checklist_items (id),
  check_date date not null,
  ok         boolean not null,
  note       text,
  checked_at timestamptz not null default now(),
  unique (item_id, check_date)
);

create table public.owner_tasks (
  id          uuid primary key default gen_random_uuid(),
  what        text not null check (length(btrim(what)) > 0),
  assigned_to uuid references public.profiles (id),              -- "who"
  due_date    date not null,
  status      text not null default 'not_started' check (status in ('not_started', 'in_progress', 'done')),
  note        text,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index owner_tasks_due_idx on public.owner_tasks (due_date) where status <> 'done';

alter table public.checklist_items  enable row level security;
alter table public.checklist_checks enable row level security;
alter table public.owner_tasks      enable row level security;
revoke all on public.checklist_items, public.checklist_checks, public.owner_tasks from anon, authenticated;
grant select on public.checklist_items, public.checklist_checks, public.owner_tasks to authenticated;
grant insert, update on public.checklist_items, public.owner_tasks to authenticated;

create policy owner_ci_select on public.checklist_items  for select using (public.is_owner());
create policy owner_ci_insert on public.checklist_items  for insert with check (public.is_owner());
create policy owner_ci_update on public.checklist_items  for update using (public.is_owner()) with check (public.is_owner());
create policy owner_cc_select on public.checklist_checks for select using (public.is_owner());
create policy owner_ot_select on public.owner_tasks      for select using (public.is_owner());
create policy owner_ot_insert on public.owner_tasks      for insert with check (public.is_owner());
create policy owner_ot_update on public.owner_tasks      for update using (public.is_owner()) with check (public.is_owner());

create trigger owner_tasks_stamp before insert on public.owner_tasks for each row execute function public.cka_stamp_creator();

-- "Done" records when; reopening clears it.
create function public.cka_task_done_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and old.status <> 'done' then new.done_at := now(); end if;
  if new.status <> 'done' then new.done_at := null; end if;
  return new;
end $$;
create trigger owner_tasks_done before update on public.owner_tasks for each row execute function public.cka_task_done_at();

-- ---------------------------------------------------------------------------
-- Tick one check (the owner, for today or up to a week back)
-- ---------------------------------------------------------------------------
create function public.owner_set_check(p_item uuid, p_date date, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  if p_date is null or p_date > today or p_date < today - 7 then raise exception 'Choose today or one of the last 7 days'; end if;
  if not exists (select 1 from public.checklist_items where id = p_item and active) then raise exception 'That check is not in use'; end if;
  if p_ok is false and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Please say what needs attention'; end if;
  insert into public.checklist_checks (item_id, check_date, ok, note, checked_at)
  values (p_item, p_date, p_ok, nullif(btrim(coalesce(p_note, '')), ''), now())
  on conflict (item_id, check_date) do update set ok = excluded.ok, note = excluded.note, checked_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- Everything the Checklist screen needs for one day
-- ---------------------------------------------------------------------------
create function public.owner_routine(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Africa/Cairo')::date; d date; out jsonb;
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  d := coalesce(p_date, today);
  if d > today or d < today - 7 then raise exception 'Choose today or one of the last 7 days'; end if;

  select jsonb_build_object(
    'date', d, 'today', today, 'is_thursday', extract(dow from today) = 4,
    'lists', (select jsonb_object_agg(l.list, jsonb_build_object(
        'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'position', i.position, 'ok', c.ok, 'note', c.note, 'checked_at', c.checked_at) order by i.position, i.created_at)
                             from public.checklist_items i left join public.checklist_checks c on c.item_id = i.id and c.check_date = d
                            where i.list = l.list and i.active), '[]'),
        'total', (select count(*) from public.checklist_items i where i.list = l.list and i.active),
        'done', (select count(*) from public.checklist_items i join public.checklist_checks c on c.item_id = i.id and c.check_date = d where i.list = l.list and i.active),
        'attention', (select count(*) from public.checklist_items i join public.checklist_checks c on c.item_id = i.id and c.check_date = d where i.list = l.list and i.active and not c.ok)))
      from (values ('morning'), ('afternoon')) as l(list)),
    'history', (select jsonb_agg(jsonb_build_object('date', h, 'working_day', public.cka_is_work_day(h),
        'morning', (select count(*) from public.checklist_items i join public.checklist_checks c on c.item_id = i.id and c.check_date = h where i.list = 'morning' and i.active),
        'morning_total', (select count(*) from public.checklist_items i where i.list = 'morning' and i.active),
        'afternoon', (select count(*) from public.checklist_items i join public.checklist_checks c on c.item_id = i.id and c.check_date = h where i.list = 'afternoon' and i.active),
        'afternoon_total', (select count(*) from public.checklist_items i where i.list = 'afternoon' and i.active)) order by h desc)
      from generate_series((today - 6)::timestamp, today::timestamp, interval '1 day') as g(h0), lateral (select h0::date as h) x),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'what', t.what, 'assigned_to', t.assigned_to, 'who', p.full_name, 'due_date', t.due_date, 'status', t.status,
          'late', (t.status <> 'done' and t.due_date < today), 'note', t.note, 'done_at', t.done_at)
          order by (t.status = 'done'), t.due_date, t.created_at)
        from public.owner_tasks t left join public.profiles p on p.id = t.assigned_to
       where t.status <> 'done' or t.done_at >= now() - interval '14 days'), '[]'),
    'late_tasks', (select count(*) from public.owner_tasks where status <> 'done' and due_date < today)
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Reminders (run by the 15-minute scheduler, together with the deadline clock)
--   09:00  morning walk not finished       16:30  afternoon check not finished
--   Thursday 09:00  weekly review (with the number of late tasks)
--   First working day of the month, 09:00  monthly review
-- Each is sent at most once per day, on working days only, and a late scheduler still catches it
-- within a few hours.
-- ---------------------------------------------------------------------------
create function public.cka_run_owner_reminders(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  l timestamp := p_now at time zone 'Africa/Cairo';
  d date := l::date; tm time := l::time; dow int := extract(dow from l::date)::int;
  o uuid; sent int := 0; late int; fd date; k text; done int; total int; existed boolean;

  -- send once; count only if it really was queued now
begin
  if not public.cka_is_work_day(d) then return jsonb_build_object('sent', 0, 'working_day', false); end if;
  select count(*) into late from public.owner_tasks where status <> 'done' and due_date < d;

  for o in select id from public.profiles where role = 'owner' and active loop
    -- morning walk
    if tm >= time '09:00' and tm < time '12:00' then
      select count(*) filter (where c.id is not null), count(*) into done, total
        from public.checklist_items i left join public.checklist_checks c on c.item_id = i.id and c.check_date = d where i.list = 'morning' and i.active;
      k := 'chk-am:' || d || ':' || o; existed := exists (select 1 from public.email_outbox where dedupe_key = k);
      if total > 0 and done < total then
        perform public.cka_enqueue_email(o, 'checklist_morning', jsonb_build_object('date', d, 'done', done, 'total', total), k);
        if not existed then sent := sent + 1; end if;
      end if;
    end if;
    -- afternoon check
    if tm >= time '16:30' and tm < time '18:00' then
      select count(*) filter (where c.id is not null), count(*) into done, total
        from public.checklist_items i left join public.checklist_checks c on c.item_id = i.id and c.check_date = d where i.list = 'afternoon' and i.active;
      k := 'chk-pm:' || d || ':' || o; existed := exists (select 1 from public.email_outbox where dedupe_key = k);
      if total > 0 and done < total then
        perform public.cka_enqueue_email(o, 'checklist_afternoon', jsonb_build_object('date', d, 'done', done, 'total', total), k);
        if not existed then sent := sent + 1; end if;
      end if;
    end if;
    -- Thursday review
    if dow = 4 and tm >= time '09:00' and tm < time '12:00' then
      k := 'rev-thu:' || d || ':' || o; existed := exists (select 1 from public.email_outbox where dedupe_key = k);
      perform public.cka_enqueue_email(o, 'review_thursday', jsonb_build_object('date', d, 'late_tasks', late), k);
      if not existed then sent := sent + 1; end if;
    end if;
    -- monthly review: the first working day of the month
    fd := date_trunc('month', d)::date;
    while not public.cka_is_work_day(fd) loop fd := fd + 1; end loop;
    if d = fd and tm >= time '09:00' and tm < time '12:00' then
      k := 'rev-mon:' || to_char(d, 'YYYY-MM') || ':' || o; existed := exists (select 1 from public.email_outbox where dedupe_key = k);
      perform public.cka_enqueue_email(o, 'review_monthly', jsonb_build_object('date', d, 'late_tasks', late), k);
      if not existed then sent := sent + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('sent', sent, 'working_day', true, 'late_tasks', late);
end $$;

revoke all on function public.owner_set_check(uuid, date, boolean, text), public.owner_routine(date), public.cka_run_owner_reminders(timestamptz) from public;
grant execute on function public.owner_set_check(uuid, date, boolean, text), public.owner_routine(date) to authenticated;
grant execute on function public.cka_run_owner_reminders(timestamptz) to service_role;

-- ============================================================
-- migrations/20261006121300_hardening.sql
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
    'confirm_investigation_fault', 'investigation_fault', 'owner_dashboard', 'owner_set_check', 'owner_routine'
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
  if to_regprocedure('public.cka_run_owner_reminders(timestamptz)') is not null then
    revoke all on function public.cka_run_owner_reminders(timestamptz) from public, anon, authenticated;
    grant execute on function public.cka_run_owner_reminders(timestamptz) to service_role;
  end if;
end $$;
