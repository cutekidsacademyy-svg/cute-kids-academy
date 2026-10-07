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
