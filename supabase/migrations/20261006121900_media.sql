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
