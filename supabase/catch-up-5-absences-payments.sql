-- CATCH-UP 5: absence follow-up, approval reminders, payments, birthdays and transport, plus the security hardening. Paste into the Supabase SQL editor and run ONCE.
-- Only for a project that already ran an earlier catch-up that included 20261006122100_questions.sql but NOT 20261006122200_absences_approvals.sql.
-- Generated from supabase/migrations/*.sql: do not edit; run  bash regen.sh

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
