-- CATCH-UP 4: announcements, menu and events, photos and videos, the admin area, plus the security hardening. Paste into the Supabase SQL editor and run ONCE.
-- Only for a project that already ran an earlier catch-up that included 20261006121600_daily_reports.sql but NOT 20261006121700_announcements.sql.
-- Generated from supabase/migrations/*.sql: do not edit; run  bash regen.sh

-- ============================================================
-- migrations/20261006121700_announcements.sql
-- ============================================================
-- Announcements, notification choices and push (Prompt 14, part 1).
--
-- * Admin posts news to everyone, one class, or chosen families, in Arabic and English, with an optional image or PDF
--   and an "important" flag. Parents see only what is meant for them; admin sees who has read it.
-- * Important announcements remind the families who have not opened them after 24 hours.
-- * Every notification is also an email; parents choose which kinds they want. Safety messages (accident reports, safety
--   reviews) cannot be switched off. Browsers also get a push "You have a new update" with no private details.

-- ---------------------------------------------------------------------------
-- What each parent wants to hear about
-- ---------------------------------------------------------------------------
create table public.notification_prefs (
  user_id        uuid primary key references public.profiles (id),
  reports        boolean not null default true,
  announcements  boolean not null default true,
  events         boolean not null default true,
  cases          boolean not null default true,
  updated_at     timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
grant select on public.notification_prefs to authenticated;
create policy prefs_own on public.notification_prefs for select using (user_id = auth.uid());

create function public.notification_prefs_save(p_reports boolean, p_announcements boolean, p_events boolean, p_cases boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  insert into public.notification_prefs (user_id, reports, announcements, events, cases)
  values (auth.uid(), coalesce(p_reports, true), coalesce(p_announcements, true), coalesce(p_events, true), coalesce(p_cases, true))
  on conflict (user_id) do update set reports = excluded.reports, announcements = excluded.announcements, events = excluded.events,
         cases = excluded.cases, updated_at = now();
end $$;

-- The email queue now respects those choices (the kinds that protect a child's safety always go out).
create or replace function public.cka_enqueue_email(p_user uuid, p_template text, p_payload jsonb, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e text; lang text; cat text; wanted boolean;
begin
  select u.email, p.language into e, lang
    from auth.users u join public.profiles p on p.id = u.id
   where u.id = p_user and p.active;
  if e is null then return; end if;
  cat := case when p_template = 'daily_report_ready' then 'reports'
              when p_template like 'announcement%' then 'announcements'
              when p_template like 'event\_%' then 'events'
              when p_template in ('received', 'acknowledged', 'update_added', 'urgency_changed', 'resolved') then 'cases'
              else null end;
  if cat is not null then
    select case cat when 'reports' then reports when 'announcements' then announcements when 'events' then events else cases end
      into wanted from public.notification_prefs where user_id = p_user;
    if found and wanted is false then return; end if;
  end if;
  insert into public.email_outbox (user_id, to_email, language, template, payload, dedupe_key)
  values (p_user, e, lang, p_template, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Push subscriptions (browsers register; only the server reads them to send)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id),
  endpoint    text not null unique check (length(endpoint) between 20 and 1000),
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
-- Remember which queued notifications have already been pushed to the person's devices.
alter table public.email_outbox add column pushed_at timestamptz;

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() is null then raise exception 'Not allowed'; end if;
  if p_endpoint !~ '^https://' or length(coalesce(p_p256dh, '')) < 20 or length(coalesce(p_auth, '')) < 8 then raise exception 'Invalid subscription'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create function public.push_unsubscribe(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
create table public.announcements (
  id               uuid primary key default gen_random_uuid(),
  title_en         text,
  title_ar         text,
  body_en          text,
  body_ar          text,
  audience         text not null check (audience in ('all', 'class', 'families')),
  class_id         uuid references public.classes (id),
  important        boolean not null default false,
  kind             text not null default 'news' check (kind in ('news', 'weekly_update')),
  attachment_path  text,
  attachment_name  text,
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  reminded_at      timestamptz,
  check (length(btrim(coalesce(title_en, ''))) > 0 or length(btrim(coalesce(title_ar, ''))) > 0),
  check (length(btrim(coalesce(body_en, ''))) > 0 or length(btrim(coalesce(body_ar, ''))) > 0),
  check ((audience = 'class') = (class_id is not null))
);
create table public.announcement_targets (
  announcement_id  uuid not null references public.announcements (id) on delete cascade,
  child_id         uuid not null references public.children (id),
  primary key (announcement_id, child_id)
);
create table public.announcement_reads (
  announcement_id  uuid not null references public.announcements (id) on delete cascade,
  user_id          uuid not null references public.profiles (id),
  read_at          timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- Who may see an announcement: management all; a teacher what is for everyone or their class; a parent what is for
-- everyone, their child's class, or their own family.
create function public.cka_announcement_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.announcements a where a.id = p_id and (
    public.is_management()
    or (public.auth_role() = 'teacher' and (a.audience = 'all' or (a.audience = 'class' and public.teaches_class(a.class_id))))
    or (public.auth_role() = 'parent' and (a.audience = 'all'
        or (a.audience = 'class' and exists (select 1 from public.parent_children pc join public.children c on c.id = pc.child_id
                                              where pc.parent_id = auth.uid() and c.class_id = a.class_id and c.active))
        or (a.audience = 'families' and exists (select 1 from public.announcement_targets t join public.parent_children pc on pc.child_id = t.child_id
                                                 where t.announcement_id = a.id and pc.parent_id = auth.uid()))))))
$$;

-- The active parents an announcement is meant for.
create function public.cka_announcement_parents(p_id uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct pc.parent_id
    from public.announcements a
    join public.parent_children pc on true
    join public.children c on c.id = pc.child_id and c.active
    join public.profiles p on p.id = pc.parent_id and p.active
   where a.id = p_id and (a.audience = 'all'
      or (a.audience = 'class' and c.class_id = a.class_id)
      or (a.audience = 'families' and exists (select 1 from public.announcement_targets t where t.announcement_id = a.id and t.child_id = c.id)))
$$;

alter table public.announcements        enable row level security;
alter table public.announcement_targets enable row level security;
alter table public.announcement_reads   enable row level security;
revoke all on public.announcements, public.announcement_targets, public.announcement_reads from anon, authenticated;
grant select on public.announcements, public.announcement_targets, public.announcement_reads to authenticated;
create policy ann_select    on public.announcements        for select using (public.cka_announcement_visible(id));
create policy ann_tg_select on public.announcement_targets for select using (public.is_management());
create policy ann_rd_select on public.announcement_reads   for select using (public.is_management() or user_id = auth.uid());

-- Private storage for attachments (an image or a PDF); readable by whoever may see the announcement.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('announcements', 'announcements', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

create function public.cka_announcement_file(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then public.cka_announcement_visible(((storage.foldername(p_path))[1])::uuid) else false end
$$;
create policy announcements_read on storage.objects for select to authenticated
  using (bucket_id = 'announcements' and public.cka_announcement_file(name));
create policy announcements_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'announcements' and public.is_management());

-- Post an announcement. The page makes the id first (so the attachment can be uploaded into its own folder).
create function public.announcement_post(p_id uuid, p_title_en text, p_title_ar text, p_body_en text, p_body_ar text, p_audience text, p_class uuid,
                                         p_children uuid[], p_important boolean, p_kind text, p_attachment_path text, p_attachment_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_id is null then raise exception 'Invalid request'; end if;
  if p_audience not in ('all', 'class', 'families') then raise exception 'Choose who it is for'; end if;
  if p_audience = 'class' and not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;
  if p_audience = 'families' and (p_children is null or cardinality(p_children) = 0) then raise exception 'Choose at least one family'; end if;
  if p_attachment_path is not null and (p_attachment_path not like p_id::text || '/%' or p_attachment_path like '%..%') then raise exception 'Invalid attachment'; end if;
  insert into public.announcements (id, title_en, title_ar, body_en, body_ar, audience, class_id, important, kind, attachment_path, attachment_name, created_by)
  values (p_id, nullif(btrim(coalesce(p_title_en, '')), ''), nullif(btrim(coalesce(p_title_ar, '')), ''), nullif(btrim(coalesce(p_body_en, '')), ''), nullif(btrim(coalesce(p_body_ar, '')), ''),
          p_audience, case when p_audience = 'class' then p_class end, coalesce(p_important, false), case when p_kind = 'weekly_update' then 'weekly_update' else 'news' end,
          nullif(p_attachment_path, ''), nullif(left(p_attachment_name, 200), ''), auth.uid());
  if p_audience = 'families' then
    insert into public.announcement_targets (announcement_id, child_id) select p_id, c from unnest(p_children) c where exists (select 1 from public.children where id = c);
  end if;
  for s in select * from public.cka_announcement_parents(p_id) loop
    perform public.cka_enqueue_email(s, 'announcement_new', jsonb_build_object('important', coalesce(p_important, false)), 'ann:' || p_id || ':' || s);
  end loop;
  return p_id;
end $$;

create function public.announcement_mark_read(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'parent' or not public.cka_announcement_visible(p_id) then return; end if;
  insert into public.announcement_reads (announcement_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
end $$;

-- Admin: who has opened it, and who has not.
create function public.announcement_stats(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'total', (select count(*) from public.cka_announcement_parents(p_id)),
    'read', (select count(*) from public.announcement_reads r where r.announcement_id = p_id and r.user_id in (select * from public.cka_announcement_parents(p_id))),
    'readers', coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'read_at', r.read_at) order by r.read_at)
                from public.announcement_reads r join public.profiles p on p.id = r.user_id where r.announcement_id = p_id), '[]'),
    'unread', coalesce((select jsonb_agg(jsonb_build_object('name', p.full_name, 'phone', p.phone) order by p.full_name)
                from public.cka_announcement_parents(p_id) u join public.profiles p on p.id = u
               where not exists (select 1 from public.announcement_reads r where r.announcement_id = p_id and r.user_id = u)), '[]')) into out;
  return out;
end $$;

create function public.announcement_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.announcements where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.notification_prefs_save(boolean, boolean, boolean, boolean), public.push_subscribe(text, text, text), public.push_unsubscribe(text),
  public.cka_announcement_visible(uuid), public.cka_announcement_parents(uuid), public.cka_announcement_file(text),
  public.announcement_post(uuid, text, text, text, text, text, uuid, uuid[], boolean, text, text, text), public.announcement_mark_read(uuid),
  public.announcement_stats(uuid), public.announcement_remove(uuid)
from public, anon, authenticated;
grant execute on function
  public.notification_prefs_save(boolean, boolean, boolean, boolean), public.push_subscribe(text, text, text), public.push_unsubscribe(text),
  public.cka_announcement_visible(uuid), public.cka_announcement_file(text),
  public.announcement_post(uuid, text, text, text, text, text, uuid, uuid[], boolean, text, text, text), public.announcement_mark_read(uuid),
  public.announcement_stats(uuid), public.announcement_remove(uuid)
to authenticated;

-- ============================================================
-- migrations/20261006121800_menu_events.sql
-- ============================================================
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

-- ============================================================
-- migrations/20261006121900_media.sql
-- ============================================================
-- Class photos and short videos (Prompt 15).
--
-- * Teachers upload to a class album (for a day or an event) and TAG the children who appear in each photo or video.
-- * A photo cannot be saved if it is tagged with a child whose parents did not agree to class photos.
-- * A parent sees only the photos and videos in which their own child is tagged, and can download them.
-- * Files live in a private bucket; they are only ever opened through short-lived links.
-- * Admin can remove anything. Items older than the retention period are archived (hidden, kept) or deleted, on a
--   schedule admin sets. Only admin or owner may mark an item "OK to post" on social media, and only if every child in
--   it has social media consent.

create table public.media_items (
  id                uuid primary key default gen_random_uuid(),
  class_id          uuid not null references public.classes (id),
  album_date        date not null,
  event_id          uuid references public.events (id) on delete set null,
  kind              text not null check (kind in ('photo', 'video')),
  storage_path      text not null unique,
  file_name         text,
  mime_type         text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm')),
  size_bytes        integer not null check (size_bytes > 0 and size_bytes <= 52428800),
  duration_seconds  integer check (duration_seconds between 1 and 60),
  uploaded_by       uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  ok_to_post        boolean not null default false,
  posted_marked_by  uuid references public.profiles (id),
  removed           boolean not null default false,
  removed_by        uuid references public.profiles (id),
  removed_at        timestamptz,
  archived          boolean not null default false,
  check ((kind = 'video') = (mime_type like 'video/%')),
  check (kind = 'video' or duration_seconds is null)
);
create index media_items_class_date_idx on public.media_items (class_id, album_date desc);

create table public.media_tags (
  media_id  uuid not null references public.media_items (id) on delete cascade,
  child_id  uuid not null references public.children (id),
  primary key (media_id, child_id)
);
create index media_tags_child_idx on public.media_tags (child_id);

-- One row: how long to keep items, and what happens then.
create table public.media_settings (
  id               boolean primary key default true check (id),
  retention_months integer check (retention_months between 1 and 120),      -- null = keep for ever
  action           text not null default 'delete' check (action in ('delete', 'archive')),
  updated_by       uuid references public.profiles (id)
);
insert into public.media_settings (id, retention_months) values (true, 12);

-- Who may see an item: management everything; a teacher their own class's (not removed); a parent only items that are
-- not removed or archived and in which one of their own children is tagged.
create function public.cka_media_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.media_items m where m.id = p_id and (
    public.is_management()
    or (public.auth_role() = 'teacher' and not m.removed and public.teaches_class(m.class_id))
    or (public.auth_role() = 'parent' and not m.removed and not m.archived
        and exists (select 1 from public.media_tags t where t.media_id = m.id and public.can_see_child(t.child_id)))))
$$;

alter table public.media_items    enable row level security;
alter table public.media_tags     enable row level security;
alter table public.media_settings enable row level security;
revoke all on public.media_items, public.media_tags, public.media_settings from anon, authenticated;
grant select on public.media_items, public.media_tags, public.media_settings to authenticated;
create policy media_select    on public.media_items    for select using (public.cka_media_visible(id));
-- a parent never learns which other children appear in a photo: only their own tags are readable
create policy media_tag_select on public.media_tags    for select using (public.cka_media_visible(media_id) and (public.auth_role() <> 'parent' or public.can_see_child(child_id)));
create policy media_set_select on public.media_settings for select using (public.is_management());

-- ---------------------------------------------------------------------------
-- Private storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('media', 'media', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];

-- Files are stored as  <class id>/<random>.<ext>
create function public.cka_media_class_of(p_path text) returns uuid
language sql immutable as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ((storage.foldername(p_path))[1])::uuid end
$$;
create function public.cka_media_upload_ok(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cka_media_class_of(p_path) is not null and (public.is_management() or public.teaches_class(public.cka_media_class_of(p_path))), false)
$$;
create function public.cka_media_file(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.media_items m where m.storage_path = p_path and public.cka_media_visible(m.id))
$$;
create policy media_file_upload on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.cka_media_upload_ok(name));
create policy media_file_read   on storage.objects for select to authenticated using (bucket_id = 'media' and (public.cka_media_file(name) or public.cka_media_upload_ok(name)));
-- a file that was never registered (for example the photo was blocked) can be taken back by whoever may upload to that class
create policy media_file_undo   on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.cka_media_upload_ok(name) and not exists (select 1 from public.media_items m where m.storage_path = name));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- Which of these children's parents did NOT agree to class photos? (so the teacher is warned before uploading)
create function public.media_consent_check(p_children uuid[]) returns table (child_id uuid, child_name text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name
    from public.children c left join public.child_consents k on k.child_id = c.id
   where c.id = any (p_children) and coalesce(k.photos_class, false) = false
     and public.auth_role() in ('admin', 'manager', 'owner', 'teacher') and public.can_see_child(c.id)
   order by c.full_name
$$;

create function public.cka_media_names(p_children uuid[], p_social boolean) returns text
language sql stable security definer set search_path = public as $$
  select string_agg(c.full_name, ', ' order by c.full_name)
    from public.children c left join public.child_consents k on k.child_id = c.id
   where c.id = any (p_children) and coalesce(case when p_social then k.photos_social else k.photos_class end, false) = false
$$;

create function public.media_add(p_id uuid, p_class uuid, p_event uuid, p_date date, p_kind text, p_path text, p_name text, p_mime text, p_size int, p_duration int, p_children uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare names text; c uuid;
begin
  if not (public.is_management() or public.teaches_class(p_class)) then raise exception 'Not allowed'; end if;
  if p_id is null or p_path is null or p_path not like p_class::text || '/%' or p_path like '%..%' then raise exception 'Invalid request'; end if;
  if p_kind not in ('photo', 'video') or (p_kind = 'video' and (p_duration is null or p_duration < 1)) then raise exception 'Invalid request'; end if;
  if p_kind = 'video' and p_duration > 60 then raise exception 'video_too_long'; end if;
  if p_children is null or cardinality(p_children) < 1 or cardinality(p_children) > 60 then raise exception 'tag_at_least_one'; end if;
  if p_date is null or p_date > public.cka_today() or p_date < public.cka_today() - 60 then raise exception 'Please choose a date in the last 60 days'; end if;
  if p_event is not null and not exists (select 1 from public.events where id = p_event) then raise exception 'Not found'; end if;
  foreach c in array p_children loop
    if not exists (select 1 from public.children where id = c and active) or not public.can_see_child(c) then raise exception 'Not allowed'; end if;
  end loop;
  names := public.cka_media_names(p_children, false);
  if names is not null then raise exception 'no_photo_consent: %', names; end if;
  insert into public.media_items (id, class_id, album_date, event_id, kind, storage_path, file_name, mime_type, size_bytes, duration_seconds, uploaded_by)
  values (p_id, p_class, p_date, p_event, p_kind, p_path, left(p_name, 200), p_mime, p_size, case when p_kind = 'video' then p_duration end, auth.uid());
  insert into public.media_tags (media_id, child_id) select p_id, x from unnest(p_children) x;
end $$;

-- Correct who is in a photo.
create function public.media_set_tags(p_id uuid, p_children uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare m public.media_items; names text; c uuid;
begin
  select * into m from public.media_items where id = p_id;
  if m.id is null or not (public.is_management() or public.teaches_class(m.class_id)) then raise exception 'Not allowed'; end if;
  if p_children is null or cardinality(p_children) < 1 or cardinality(p_children) > 60 then raise exception 'tag_at_least_one'; end if;
  foreach c in array p_children loop
    if not exists (select 1 from public.children where id = c and active) or not public.can_see_child(c) then raise exception 'Not allowed'; end if;
  end loop;
  names := public.cka_media_names(p_children, false);
  if names is not null then raise exception 'no_photo_consent: %', names; end if;
  if m.ok_to_post then
    names := public.cka_media_names(p_children, true);
    if names is not null then raise exception 'no_social_consent: %', names; end if;
  end if;
  delete from public.media_tags where media_id = p_id;
  insert into public.media_tags (media_id, child_id) select p_id, x from unnest(p_children) x;
end $$;

create function public.media_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  update public.media_items set removed = true, removed_by = auth.uid(), removed_at = now(), ok_to_post = false where id = p_id and not removed;
end $$;

-- Only admin or the owner may mark an item "OK to post", and only if every child in it agreed to social media.
create function public.media_mark_post(p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare names text; kids uuid[];
begin
  if not coalesce(public.auth_role() in ('admin', 'owner'), false) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.media_items where id = p_id and not removed) then raise exception 'Not found'; end if;
  if coalesce(p_ok, false) then
    select array_agg(child_id) into kids from public.media_tags where media_id = p_id;
    names := public.cka_media_names(kids, true);
    if names is not null then raise exception 'no_social_consent: %', names; end if;
  end if;
  update public.media_items set ok_to_post = coalesce(p_ok, false), posted_marked_by = case when coalesce(p_ok, false) then auth.uid() end where id = p_id;
end $$;

create function public.media_settings_save(p_months int, p_action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_action not in ('delete', 'archive') or (p_months is not null and p_months not between 1 and 120) then raise exception 'Invalid request'; end if;
  update public.media_settings set retention_months = p_months, action = p_action, updated_by = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Retention (server only). Removed items are purged after 30 days; old items are archived or deleted as set.
-- ---------------------------------------------------------------------------
create function public.cka_media_expired(p_now timestamptz default now()) returns table (id uuid, storage_path text, action text)
language sql stable security definer set search_path = public as $$
  select m.id, m.storage_path, 'delete'::text from public.media_items m where m.removed and m.removed_at <= p_now - interval '30 days'
  union all
  select m.id, m.storage_path, s.action
    from public.media_items m cross join public.media_settings s
   where not m.removed and not m.archived and s.retention_months is not null
     and m.album_date < ((p_now at time zone 'Africa/Cairo')::date - (s.retention_months || ' months')::interval)::date
$$;

create function public.cka_media_apply(p_ids uuid[], p_action text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_action = 'archive' then
    update public.media_items set archived = true, ok_to_post = false where id = any (p_ids) and not removed;
  elsif p_action = 'delete' then
    delete from public.media_items where id = any (p_ids);
  else raise exception 'Invalid request'; end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_media_visible(uuid), public.cka_media_class_of(text), public.cka_media_upload_ok(text), public.cka_media_file(text), public.media_consent_check(uuid[]),
  public.cka_media_names(uuid[], boolean), public.media_add(uuid, uuid, uuid, date, text, text, text, text, int, int, uuid[]), public.media_set_tags(uuid, uuid[]),
  public.media_remove(uuid), public.media_mark_post(uuid, boolean), public.media_settings_save(int, text), public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text)
from public, anon, authenticated;
grant execute on function
  public.cka_media_visible(uuid), public.cka_media_upload_ok(text), public.cka_media_file(text), public.media_consent_check(uuid[]),
  public.media_add(uuid, uuid, uuid, date, text, text, text, text, int, int, uuid[]), public.media_set_tags(uuid, uuid[]),
  public.media_remove(uuid), public.media_mark_post(uuid, boolean), public.media_settings_save(int, text)
to authenticated;
grant execute on function public.cka_media_expired(timestamptz), public.cka_media_apply(uuid[], text) to service_role;

-- ============================================================
-- migrations/20261006122000_admin_area.sql
-- ============================================================
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

-- Fix for projects that already ran the daily-reports migration: an account that was switched off could call report_send (it sent nothing, but it should be refused).
create or replace function public.report_send(p_children uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare day date := public.cka_today(); r record; n int := 0;
begin
  if not coalesce(public.auth_role() in ('admin', 'manager', 'owner', 'teacher'), false) then raise exception 'Not allowed'; end if;
  for r in select * from public.daily_reports d where d.report_date = day and d.status = 'draft' and public.cka_report_has_content(d)
              and (p_children is null or d.child_id = any (p_children)) and public.cka_door_allowed(d.child_id) loop
    perform public.cka_report_send_one(r.id, auth.uid());
    n := n + 1;
  end loop;
  return n;
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

-- ============================================================
-- migrations/20261006122100_questions.sql
-- ============================================================
-- Questions and missing items (Prompt 17, with Prompt 21).
--
-- A parent can now ask a question (topic: fees, schedule, food, my child's day, other) or report a missing item, in
-- addition to complaints and safety concerns. Both become portal cases with the "can wait" promise unless the parent
-- picks "urgent", land in the staff queue, and are emailed to the academy's inbox and to the admins. Replies from
-- staff reach the parent in the portal and by email, exactly like any other case.

alter table public.submissions drop constraint submissions_type_check;
alter table public.submissions add constraint submissions_type_check check (type in ('complaint', 'safety_concern', 'question', 'missing_item'));
alter table public.submissions add column topic text check (topic in ('fees', 'schedule', 'food', 'my_childs_day', 'other'));

drop policy submissions_parent_insert on public.submissions;
create policy submissions_parent_insert on public.submissions for insert
  with check (public.auth_role() = 'parent' and parent_id = auth.uid() and public.can_see_child(child_id)
              and type in ('complaint', 'safety_concern', 'question', 'missing_item'));

-- Parents may not pick Critical for a question or a missing item either (the trigger already refused it for complaints).
create or replace function public.cka_submission_before_insert() returns trigger
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
    if new.urgency = 'critical' and new.type in ('complaint', 'question', 'missing_item') then
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

-- Tell the academy about a new question or missing item: the inbox address (if set) and every admin.
create function public.cka_notify_question_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; u uuid; payload jsonb;
begin
  payload := jsonb_build_object('id', new.id, 'ref_no', new.ref_no, 'title', new.title, 'urgency', new.urgency, 'type', new.type, 'topic', new.topic,
    'parent_name', (select full_name from public.profiles where id = new.parent_id), 'child_name', (select full_name from public.children where id = new.child_id),
    'text', left(new.description, 1500));
  select email into a from public.academy_settings;
  if a is not null and public.cka_is_email(a) then perform public.cka_enqueue_email_address(a, 'en', 'question_new', payload, 'qnew:' || new.id || ':inbox'); end if;
  for u in select id from public.profiles where role = 'admin' and active loop
    perform public.cka_enqueue_email(u, 'question_new', payload, 'qnew:' || new.id || ':' || u);
  end loop;
  return new;
end $$;
create trigger submissions_after_insert_question after insert on public.submissions
  for each row when (new.type in ('question', 'missing_item')) execute function public.cka_notify_question_insert();

-- This month at a glance, for one of the parent's own children: days attended, days absent (told us / not told us), late pickups.
create function public.parent_month_summary(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := public.cka_today(); first date := date_trunc('month', public.cka_today())::date; since date; last_day date; att int; rep int; unrep int; late int; days int;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  select greatest(first, (created_at at time zone 'Africa/Cairo')::date) into since from public.children where id = p_child;
  last_day := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then today else today - 1 end;
  select count(*) into att from public.attendance where child_id = p_child and att_date between first and today;
  select count(*) into late from public.attendance where child_id = p_child and att_date between first and today and overtime_minutes > 0;
  select count(*) into days from generate_series(since, last_day, interval '1 day') g where public.cka_is_work_day(g::date);
  select count(*) into rep from generate_series(since, last_day, interval '1 day') g
   where public.cka_is_work_day(g::date) and not exists (select 1 from public.attendance a where a.child_id = p_child and a.att_date = g::date)
     and exists (select 1 from public.attendance_notices n where n.child_id = p_child and n.notice_date = g::date and n.kind = 'absence');
  unrep := greatest(0, days - (select count(*) from public.attendance a where a.child_id = p_child and a.att_date between since and last_day) - rep);
  return jsonb_build_object('attended', att, 'absent_reported', rep, 'absent_unreported', unrep, 'late_pickups', late);
end $$;

revoke all on function public.cka_notify_question_insert(), public.parent_month_summary(uuid) from public, anon, authenticated;
grant execute on function public.parent_month_summary(uuid) to authenticated;

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
