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
