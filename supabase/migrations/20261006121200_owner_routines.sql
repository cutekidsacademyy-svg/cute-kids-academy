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
