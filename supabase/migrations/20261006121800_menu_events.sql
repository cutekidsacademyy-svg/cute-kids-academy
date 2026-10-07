-- Weekly menu, daily class schedule, events and the calendar (Prompt 14, part 2).
--
-- * A menu per day. Each dish lists its allergens; a family is warned when a dish contains something their child is
--   allergic to (matched against the allergies written in the child's health record, in English or Arabic).
-- * A daily schedule per class (arrival, activities, meals, nap, pickup).
-- * Events, closures, holidays and specialist sessions. An event can need approval: parents answer yes or no, per child,
--   before a deadline; families who have not answered get a reminder; admin sees a live list.

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
create table public.menu_items (
  id          uuid primary key default gen_random_uuid(),
  menu_date   date not null,
  meal        text not null check (meal in ('breakfast', 'lunch', 'snack')),
  dish_en     text,
  dish_ar     text,
  allergens   text[] not null default '{}' check (allergens <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'wheat', 'soy', 'fish', 'shellfish', 'sesame']),
  created_by  uuid references public.profiles (id),
  unique (menu_date, meal),
  check (length(btrim(coalesce(dish_en, ''))) > 0 or length(btrim(coalesce(dish_ar, ''))) > 0)
);

create table public.schedule_items (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid references public.classes (id),              -- null = every class
  start_time  time not null,
  title_en    text,
  title_ar    text,
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0)
);

create table public.events (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null default 'event' check (kind in ('event', 'closure', 'holiday', 'session')),
  title_en          text,
  title_ar          text,
  details_en        text,
  details_ar        text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  all_day           boolean not null default false,
  place             text check (length(place) <= 200),
  audience          text not null default 'all' check (audience in ('all', 'class')),
  class_id          uuid references public.classes (id),
  cost              numeric(10, 2) check (cost >= 0),
  needs_approval    boolean not null default false,
  approval_deadline timestamptz,
  reminded_at       timestamptz,
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0),
  check ((audience = 'class') = (class_id is not null)),
  check (not needs_approval or approval_deadline is not null),
  check (ends_at is null or ends_at >= starts_at)
);
create index events_start_idx on public.events (starts_at);

create table public.event_responses (
  event_id     uuid not null references public.events (id) on delete cascade,
  child_id     uuid not null references public.children (id),
  answered_by  uuid references public.profiles (id),
  answer       text not null check (answer in ('yes', 'no')),
  answered_at  timestamptz not null default now(),
  primary key (event_id, child_id)
);

-- Is an event meant for the caller? (management: all; teacher: everyone's or their class; parent: everyone's or their child's class)
create function public.cka_event_visible(p_audience text, p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.auth_role()
    when 'admin' then true when 'manager' then true when 'owner' then true
    when 'teacher' then p_audience = 'all' or public.teaches_class(p_class)
    when 'parent' then p_audience = 'all' or exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id
                                                      where pc.parent_id = auth.uid() and c.class_id = p_class and c.active)
    else false end
$$;

alter table public.menu_items      enable row level security;
alter table public.schedule_items  enable row level security;
alter table public.events          enable row level security;
alter table public.event_responses enable row level security;
revoke all on public.menu_items, public.schedule_items, public.events, public.event_responses from anon, authenticated;
grant select on public.menu_items, public.schedule_items, public.events, public.event_responses to authenticated;
create policy menu_select  on public.menu_items      for select using (public.auth_role() is not null);
create policy sched_select on public.schedule_items  for select using (public.auth_role() is not null);
create policy events_select on public.events         for select using (public.cka_event_visible(audience, class_id));
create policy evresp_select on public.event_responses for select using (public.can_see_child(child_id));

-- ---------------------------------------------------------------------------
-- Allergen matching: the allergies are free text typed by parents, so look for common words (English and Arabic)
-- ---------------------------------------------------------------------------
create function public.cka_allergen_match(p_text text, p_allergen text) returns boolean
language sql immutable as $$
  select coalesce(p_text, '') ~* case p_allergen
    when 'peanuts'   then 'peanut|groundnut|فول سوداني|فول السوداني'
    when 'tree_nuts' then 'nut|almond|cashew|walnut|hazelnut|pistachio|pecan|مكسرات|لوز|جوز|بندق|كاجو|فستق'
    when 'milk'      then 'milk|dairy|lactose|cheese|yogh?urt|butter|cream|حليب|لبن|ألبان|البان|جبن|زبادي|لاكتوز'
    when 'eggs'      then 'egg|بيض'
    when 'wheat'     then 'wheat|gluten|flour|bread|قمح|جلوتين|غلوتين|دقيق|خبز'
    when 'soy'       then 'soy|صويا'
    when 'fish'      then 'fish|سمك|اسماك|أسماك'
    when 'shellfish' then 'shellfish|shrimp|prawn|crab|lobster|جمبري|روبيان|محار|كابوريا'
    when 'sesame'    then 'sesame|tahini|tahina|سمسم|طحينة|طحينه'
    else '^$a' end
$$;

-- The menu for a range of days. "affected" lists the children the caller may know about whose allergies match the dish:
-- a parent sees their own children, a teacher their class, management everyone.
create function public.menu_week(p_from date, p_to date)
returns table (menu_date date, meal text, dish_en text, dish_ar text, allergens text[], affected text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'Please choose up to two months'; end if;
  return query
    select m.menu_date, m.meal, m.dish_en, m.dish_ar, m.allergens,
           coalesce((select array_agg(distinct c.full_name order by c.full_name)
                       from public.children c join public.child_health h on h.child_id = c.id
                      where c.active and public.can_see_child(c.id) and public.auth_role() <> 'finance'
                        and exists (select 1 from unnest(m.allergens) a where public.cka_allergen_match(h.allergies, a))), '{}')
      from public.menu_items m where m.menu_date between p_from and p_to
     order by m.menu_date, case m.meal when 'breakfast' then 1 when 'lunch' then 2 else 3 end;
end $$;

create function public.menu_save(p_date date, p_meal text, p_en text, p_ar text, p_allergens text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_date is null or p_meal not in ('breakfast', 'lunch', 'snack') then raise exception 'Invalid request'; end if;
  if length(btrim(coalesce(p_en, ''))) = 0 and length(btrim(coalesce(p_ar, ''))) = 0 then
    delete from public.menu_items where menu_date = p_date and meal = p_meal;
    return;
  end if;
  if not (coalesce(p_allergens, '{}') <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'wheat', 'soy', 'fish', 'shellfish', 'sesame']) then raise exception 'Unknown allergen'; end if;
  insert into public.menu_items (menu_date, meal, dish_en, dish_ar, allergens, created_by)
  values (p_date, p_meal, nullif(btrim(coalesce(p_en, '')), ''), nullif(btrim(coalesce(p_ar, '')), ''), coalesce(p_allergens, '{}'), auth.uid())
  on conflict (menu_date, meal) do update set dish_en = excluded.dish_en, dish_ar = excluded.dish_ar, allergens = excluded.allergens, created_by = excluded.created_by;
end $$;

-- ---------------------------------------------------------------------------
-- Daily schedule
-- ---------------------------------------------------------------------------
create function public.schedule_save(p_id uuid, p_class uuid, p_time time, p_en text, p_ar text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_time is null or (length(btrim(coalesce(p_en, ''))) = 0 and length(btrim(coalesce(p_ar, ''))) = 0) then raise exception 'Please give a time and a title'; end if;
  if p_class is not null and not exists (select 1 from public.classes where id = p_class) then raise exception 'Not found'; end if;
  if rid is null then
    insert into public.schedule_items (class_id, start_time, title_en, title_ar) values (p_class, p_time, nullif(btrim(coalesce(p_en, '')), ''), nullif(btrim(coalesce(p_ar, '')), '')) returning id into rid;
  else
    update public.schedule_items set class_id = p_class, start_time = p_time, title_en = nullif(btrim(coalesce(p_en, '')), ''), title_ar = nullif(btrim(coalesce(p_ar, '')), '') where id = rid;
  end if;
  return rid;
end $$;

create function public.schedule_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.schedule_items where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Events and approvals
-- ---------------------------------------------------------------------------
create function public.cka_event_children(p_event uuid) returns table (child_id uuid)
language sql stable security definer set search_path = public as $$
  select c.id from public.events e join public.children c on c.active and (e.audience = 'all' or c.class_id = e.class_id) where e.id = p_event
$$;

create function public.event_save(p_id uuid, p_kind text, p_title_en text, p_title_ar text, p_details_en text, p_details_ar text, p_starts timestamptz, p_ends timestamptz,
                                  p_all_day boolean, p_place text, p_audience text, p_class uuid, p_cost numeric, p_needs_approval boolean, p_deadline timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id; s uuid; fresh boolean := false;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_kind not in ('event', 'closure', 'holiday', 'session') or p_audience not in ('all', 'class') then raise exception 'Invalid request'; end if;
  if p_audience = 'class' and not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;
  if p_starts is null then raise exception 'Please choose when it starts'; end if;
  if coalesce(p_needs_approval, false) and (p_deadline is null or p_deadline > p_starts) then raise exception 'Please choose an approval deadline before the event'; end if;
  if rid is null then
    rid := gen_random_uuid(); fresh := true;
    insert into public.events (id, kind, title_en, title_ar, details_en, details_ar, starts_at, ends_at, all_day, place, audience, class_id, cost, needs_approval, approval_deadline, created_by)
    values (rid, p_kind, nullif(btrim(coalesce(p_title_en, '')), ''), nullif(btrim(coalesce(p_title_ar, '')), ''), nullif(btrim(coalesce(p_details_en, '')), ''), nullif(btrim(coalesce(p_details_ar, '')), ''),
            p_starts, p_ends, coalesce(p_all_day, false), nullif(btrim(coalesce(p_place, '')), ''), p_audience, case when p_audience = 'class' then p_class end, p_cost,
            coalesce(p_needs_approval, false), case when coalesce(p_needs_approval, false) then p_deadline end, auth.uid());
  else
    update public.events set kind = p_kind, title_en = nullif(btrim(coalesce(p_title_en, '')), ''), title_ar = nullif(btrim(coalesce(p_title_ar, '')), ''),
           details_en = nullif(btrim(coalesce(p_details_en, '')), ''), details_ar = nullif(btrim(coalesce(p_details_ar, '')), ''), starts_at = p_starts, ends_at = p_ends,
           all_day = coalesce(p_all_day, false), place = nullif(btrim(coalesce(p_place, '')), ''), audience = p_audience, class_id = case when p_audience = 'class' then p_class end,
           cost = p_cost, needs_approval = coalesce(p_needs_approval, false), approval_deadline = case when coalesce(p_needs_approval, false) then p_deadline end
     where id = rid;
    if not found then raise exception 'Not found'; end if;
  end if;
  -- families are told about a new event, closure or holiday (sessions are only shown in the calendar)
  if fresh and p_kind <> 'session' then
    for s in select distinct pc.parent_id from public.cka_event_children(rid) k join public.parent_children pc on pc.child_id = k.child_id
              join public.profiles p on p.id = pc.parent_id and p.active loop
      perform public.cka_enqueue_email(s, 'event_new', jsonb_build_object('needs_approval', coalesce(p_needs_approval, false)), 'evnew:' || rid || ':' || s);
    end loop;
  end if;
  return rid;
end $$;

create function public.event_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.events where id = p_id;
end $$;

-- A parent answers yes or no for one child, until the deadline.
create function public.event_respond(p_event uuid, p_child uuid, p_answer text) returns void
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
end $$;

-- Admin: the live list of answers and missing answers.
create function public.event_responses_summary(p_event uuid)
returns table (child_id uuid, child_name text, class_name text, answer text, answered_by_name text, answered_at timestamptz, parents text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, coalesce(cl.name, ''), r.answer, p.full_name, r.answered_at,
         coalesce((select string_agg(pp.full_name, ', ' order by pp.full_name) from public.parent_children pc join public.profiles pp on pp.id = pc.parent_id where pc.child_id = c.id), '')
    from public.cka_event_children(p_event) k
    join public.children c on c.id = k.child_id
    left join public.classes cl on cl.id = c.class_id
    left join public.event_responses r on r.event_id = p_event and r.child_id = c.id
    left join public.profiles p on p.id = r.answered_by
   where public.is_management()
   order by (r.answer is null) desc, cl.name, c.full_name
$$;

-- ---------------------------------------------------------------------------
-- The scheduler (server only): reminders for unread important announcements and unanswered approvals
-- ---------------------------------------------------------------------------
create function public.cka_run_content_check(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; e record; s uuid; ann int := 0; ev int := 0; sent int := 0;
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
  for e in select id from public.events where needs_approval and reminded_at is null and approval_deadline > p_now and approval_deadline <= p_now + interval '24 hours' loop
    for s in select distinct pc.parent_id from public.cka_event_children(e.id) k join public.parent_children pc on pc.child_id = k.child_id
              join public.profiles p on p.id = pc.parent_id and p.active
              where not exists (select 1 from public.event_responses r where r.event_id = e.id and r.child_id = k.child_id) loop
      perform public.cka_enqueue_email(s, 'event_reminder', '{}'::jsonb, 'evrem:' || e.id || ':' || s);
      sent := sent + 1;
    end loop;
    update public.events set reminded_at = p_now where id = e.id;
    ev := ev + 1;
  end loop;
  return jsonb_build_object('announcements', ann, 'events', ev, 'emails', sent);
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_event_visible(text, uuid), public.cka_allergen_match(text, text), public.menu_week(date, date), public.menu_save(date, text, text, text, text[]),
  public.schedule_save(uuid, uuid, time, text, text), public.schedule_delete(uuid), public.cka_event_children(uuid),
  public.event_save(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, text, uuid, numeric, boolean, timestamptz),
  public.event_delete(uuid), public.event_respond(uuid, uuid, text), public.event_responses_summary(uuid), public.cka_run_content_check(timestamptz)
from public, anon, authenticated;
grant execute on function
  public.cka_event_visible(text, uuid), public.menu_week(date, date), public.menu_save(date, text, text, text, text[]),
  public.schedule_save(uuid, uuid, time, text, text), public.schedule_delete(uuid),
  public.event_save(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, text, text, uuid, numeric, boolean, timestamptz),
  public.event_delete(uuid), public.event_respond(uuid, uuid, text), public.event_responses_summary(uuid)
to authenticated;
grant execute on function public.cka_run_content_check(timestamptz) to service_role;
