-- Online child registration (Prompt 11).
--
-- A family fills in the public registration form (no login). The server stores the application with the
-- service key (nobody can write these tables from a browser). Staff review it, and approving it creates
-- the child's record and invites the parents.
--
-- WHO CAN SEE WHAT (enforced here, in the database):
--   applications, health details, ID photos, documents ... admin, manager, owner
--   a child's allergies ................................. also the child's class teachers (ONLY allergies)
--   a child's own details ............................... that child's parents (they can update pickup
--                                                         people and allergies; staff are told)
--   everyone else, including other parents .............. nothing

-- ---------------------------------------------------------------------------
-- Applications (before approval)
-- ---------------------------------------------------------------------------
create table public.registration_applications (
  id               uuid primary key default gen_random_uuid(),
  application_no   bigint generated always as identity unique,
  draft_id         uuid not null,
  status           text not null default 'new' check (status in ('new', 'missing_documents', 'tour_booked', 'approved', 'waitlist', 'declined')),
  status_note      text,
  language         text not null default 'en' check (language in ('ar', 'en')),
  child_name       text not null check (length(btrim(child_name)) between 2 and 120),
  child_dob        date not null,
  programme        text not null check (programme in ('nursery', 'preschool', 'after_school', 'camp')),
  preferred_start  date,
  child_photo_path text,
  allergies        text,
  medical_conditions text,
  medications      text,
  doctor_name      text,
  doctor_phone     text,
  consent_photos_class       boolean not null,
  consent_photos_social      boolean not null,
  consent_outings            boolean not null,
  consent_emergency_treatment boolean not null,
  consent_birthday_wall      boolean not null,
  child_id         uuid references public.children (id),
  assigned_class_id uuid references public.classes (id),
  decided_by       uuid references public.profiles (id),
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index registration_status_idx on public.registration_applications (status, created_at desc);

create table public.registration_parents (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.registration_applications (id),
  position       smallint not null check (position in (1, 2)),
  full_name      text not null,
  phone          text not null,
  email          text not null,
  relationship   text not null check (relationship in ('mother', 'father', 'guardian', 'other')),
  unique (application_id, position)
);

create table public.registration_pickups (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.registration_applications (id),
  full_name       text not null,
  relationship    text not null,
  phone           text not null,
  id_photo_path   text
);

create table public.registration_documents (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.registration_applications (id),
  kind            text not null check (kind in ('birth_certificate', 'vaccination_record', 'other')),
  storage_path    text not null,
  file_name       text,
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 5242880)
);

create table public.registration_events (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.registration_applications (id),
  actor_id        uuid references public.profiles (id),
  actor_name      text,
  kind            text not null,
  note            text,
  created_at      timestamptz not null default now()
);

-- Simple counters so the public form cannot be hammered (server only).
create table public.registration_rate (
  key     text not null,
  bucket  timestamptz not null,
  n       int not null default 0,
  primary key (key, bucket)
);

-- ---------------------------------------------------------------------------
-- A child's records after approval
-- ---------------------------------------------------------------------------
create table public.child_health (
  child_id           uuid primary key references public.children (id),
  allergies          text,
  medical_conditions text,
  medications        text,
  doctor_name        text,
  doctor_phone       text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles (id)
);

create table public.child_pickups (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children (id),
  full_name     text not null check (length(btrim(full_name)) > 0),
  relationship  text not null,
  phone         text not null,
  id_photo_path text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index child_pickups_child_idx on public.child_pickups (child_id) where active;

create table public.child_consents (
  child_id                    uuid primary key references public.children (id),
  photos_class                boolean not null,
  photos_social               boolean not null,
  outings                     boolean not null,
  emergency_treatment         boolean not null,
  birthday_wall               boolean not null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references public.profiles (id)
);

create table public.child_documents (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children (id),
  kind          text not null check (kind in ('birth_certificate', 'vaccination_record', 'child_photo', 'other')),
  storage_path  text not null,
  file_name     text,
  mime_type     text,
  size_bytes    integer,
  created_at    timestamptz not null default now()
);

-- Every change to health, consent or the pickup list: who, when, what (management only).
create table public.child_change_log (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  kind            text not null check (kind in ('created', 'health', 'pickup', 'consent', 'contact')),
  summary         text not null,
  old_value       text,
  new_value       text,
  changed_by      uuid references public.profiles (id),
  changed_by_name text,
  created_at      timestamptz not null default now()
);
create index child_change_log_idx on public.child_change_log (child_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.registration_applications enable row level security;
alter table public.registration_parents       enable row level security;
alter table public.registration_pickups       enable row level security;
alter table public.registration_documents     enable row level security;
alter table public.registration_events        enable row level security;
alter table public.registration_rate          enable row level security;
alter table public.child_health               enable row level security;
alter table public.child_pickups              enable row level security;
alter table public.child_consents             enable row level security;
alter table public.child_documents            enable row level security;
alter table public.child_change_log           enable row level security;

revoke all on public.registration_applications, public.registration_parents, public.registration_pickups, public.registration_documents,
              public.registration_events, public.registration_rate, public.child_health, public.child_pickups, public.child_consents,
              public.child_documents, public.child_change_log from anon, authenticated;
-- Everything is written through checked functions below; browsers only ever READ, and only what the policies allow.
grant select on public.registration_applications, public.registration_parents, public.registration_pickups, public.registration_documents,
                public.registration_events, public.child_health, public.child_pickups, public.child_consents, public.child_documents,
                public.child_change_log to authenticated;

create policy reg_app_select  on public.registration_applications for select using (public.is_management());
create policy reg_par_select  on public.registration_parents       for select using (public.is_management());
create policy reg_pick_select on public.registration_pickups       for select using (public.is_management());
create policy reg_doc_select  on public.registration_documents     for select using (public.is_management());
create policy reg_ev_select   on public.registration_events        for select using (public.is_management());

create policy child_health_staff   on public.child_health   for select using (public.is_management());
create policy child_health_parent  on public.child_health   for select using (public.auth_role() = 'parent' and public.can_see_child(child_id));
create policy child_pick_staff     on public.child_pickups  for select using (public.is_management());
create policy child_pick_parent    on public.child_pickups  for select using (public.auth_role() = 'parent' and public.can_see_child(child_id));
create policy child_cons_staff     on public.child_consents for select using (public.is_management());
create policy child_cons_parent    on public.child_consents for select using (public.auth_role() = 'parent' and public.can_see_child(child_id));
create policy child_docs_staff     on public.child_documents for select using (public.is_management());
create policy child_log_staff      on public.child_change_log for select using (public.is_management());

-- Teachers get NOTHING from these tables directly; they see allergies only through class_allergies() below.

-- ---------------------------------------------------------------------------
-- Private storage for registration files
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('registrations', 'registrations', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
  ('child-files',   'child-files',   false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

-- Files uploaded with the public form: only admin, manager and owner can read them. (The form uploads through
-- short-lived signed upload links created by the server, which is why there is no insert policy.)
create policy registrations_read on storage.objects for select to authenticated
  using (bucket_id = 'registrations' and public.is_management());

-- A child's own files (for example the ID photo of a pickup person added later): the child's parents and management.
create policy child_files_read on storage.objects for select to authenticated
  using (bucket_id = 'child-files' and (public.is_management()
         or (public.auth_role() = 'parent' and public.can_see_child(((storage.foldername(name))[1])::uuid))));
create policy child_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'child-files' and (storage.foldername(name))[2] = 'pickups'
              and (public.is_management() or (public.auth_role() = 'parent' and public.can_see_child(((storage.foldername(name))[1])::uuid))));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Queue an email to an address that has no login yet (the applicant).
create function public.cka_enqueue_email_address(p_email text, p_lang text, p_template text, p_payload jsonb, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.email_outbox (user_id, to_email, language, template, payload, dedupe_key)
  values (null, lower(btrim(p_email)), case when p_lang = 'ar' then 'ar' else 'en' end, p_template, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

create function public.cka_log_child_change(p_child uuid, p_kind text, p_summary text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.child_change_log (child_id, kind, summary, old_value, new_value, changed_by, changed_by_name)
  values (p_child, p_kind, p_summary, p_old, p_new, auth.uid(), public.cka_actor_name());
end $$;

-- The people to tell when something about a child's health or pickup list changes: the class's teachers and the admins.
create function public.cka_class_staff_and_admins(p_child uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from (
    select cl.head_teacher_id as id from public.children c join public.classes cl on cl.id = c.class_id where c.id = p_child
    union select sc.staff_id from public.children c join public.staff_classes sc on sc.class_id = c.class_id where c.id = p_child
    union select id from public.profiles where role = 'admin'
  ) x where id is not null and exists (select 1 from public.profiles p where p.id = x.id and p.active)
$$;

-- Rate limiting for the public form (server only). True while the caller is within the limit.
create function public.registration_rate_hit(p_key text, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.registration_rate (key, bucket, n) values (p_key, date_trunc('hour', now()), 1)
  on conflict (key, bucket) do update set n = public.registration_rate.n + 1 returning n into c;
  delete from public.registration_rate where bucket < now() - interval '2 days';
  return c <= p_limit;
end $$;

create function public.cka_is_email(p text) returns boolean language sql immutable as $$ select p ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(p) <= 254 $$;
create function public.cka_is_phone(p text) returns boolean language sql immutable as $$ select p ~ '^[+0-9][0-9 ()+-]{6,19}$' $$;

-- ---------------------------------------------------------------------------
-- Submitting an application (server only; the public form posts to the server, which calls this)
-- ---------------------------------------------------------------------------
create function public.register_application(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  draft uuid; lang text; cname text; dob date; prog text; start_ date; photo text;
  prefix text; parents jsonb; pk jsonb; docs jsonb; d jsonb; i int; app public.registration_applications; cons jsonb; firstemail text;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'bad_request'; end if;
  begin draft := (p ->> 'draft_id')::uuid; exception when others then raise exception 'bad_request'; end;
  prefix := 'drafts/' || draft || '/';
  lang := case when p ->> 'language' = 'ar' then 'ar' else 'en' end;

  cname := btrim(coalesce(p #>> '{child,name}', ''));
  if length(cname) < 2 or length(cname) > 120 then raise exception 'invalid_child_name'; end if;
  begin dob := (p #>> '{child,dob}')::date; exception when others then raise exception 'invalid_child_dob'; end;
  if dob is null or dob > current_date or dob < current_date - interval '20 years' then raise exception 'invalid_child_dob'; end if;
  prog := p #>> '{child,programme}';
  if prog is null or prog not in ('nursery', 'preschool', 'after_school', 'camp') then raise exception 'invalid_programme'; end if;
  if nullif(p #>> '{child,preferred_start}', '') is not null then
    begin start_ := (p #>> '{child,preferred_start}')::date; exception when others then raise exception 'invalid_start_date'; end;
    if start_ < current_date - 30 or start_ > current_date + 800 then raise exception 'invalid_start_date'; end if;
  end if;
  photo := nullif(p #>> '{child,photo_path}', '');
  if photo is not null and (photo not like prefix || '%' or photo like '%..%') then raise exception 'invalid_file'; end if;

  parents := coalesce(p -> 'parents', '[]');
  if jsonb_typeof(parents) <> 'array' or jsonb_array_length(parents) < 1 or jsonb_array_length(parents) > 2 then raise exception 'invalid_parents'; end if;
  for i in 0 .. jsonb_array_length(parents) - 1 loop
    d := parents -> i;
    if length(btrim(coalesce(d ->> 'full_name', ''))) < 2 or length(d ->> 'full_name') > 120
       or not public.cka_is_phone(btrim(coalesce(d ->> 'phone', ''))) or not public.cka_is_email(lower(btrim(coalesce(d ->> 'email', ''))))
       or coalesce(d ->> 'relationship', '') not in ('mother', 'father', 'guardian', 'other') then
      raise exception 'invalid_parent_%', i + 1;
    end if;
  end loop;
  firstemail := lower(btrim(parents -> 0 ->> 'email'));

  cons := coalesce(p -> 'consents', '{}');
  if jsonb_typeof(cons -> 'photos_class') <> 'boolean' or jsonb_typeof(cons -> 'photos_social') <> 'boolean' or jsonb_typeof(cons -> 'outings') <> 'boolean'
     or jsonb_typeof(cons -> 'emergency_treatment') <> 'boolean' or jsonb_typeof(cons -> 'birthday_wall') <> 'boolean' then
    raise exception 'consents_incomplete';
  end if;
  if length(coalesce(p #>> '{health,allergies}', '')) > 2000 or length(coalesce(p #>> '{health,medical_conditions}', '')) > 2000
     or length(coalesce(p #>> '{health,medications}', '')) > 2000 then raise exception 'text_too_long'; end if;
  if nullif(p #>> '{health,doctor_phone}', '') is not null and not public.cka_is_phone(btrim(p #>> '{health,doctor_phone}')) then raise exception 'invalid_doctor_phone'; end if;

  pk := coalesce(p -> 'pickups', '[]');
  if jsonb_typeof(pk) <> 'array' or jsonb_array_length(pk) > 6 then raise exception 'invalid_pickups'; end if;
  for i in 0 .. jsonb_array_length(pk) - 1 loop
    d := pk -> i;
    if length(btrim(coalesce(d ->> 'full_name', ''))) < 2 or length(btrim(coalesce(d ->> 'relationship', ''))) < 2
       or not public.cka_is_phone(btrim(coalesce(d ->> 'phone', ''))) then raise exception 'invalid_pickup_%', i + 1; end if;
    if nullif(d ->> 'id_photo_path', '') is not null and ((d ->> 'id_photo_path') not like prefix || '%' or (d ->> 'id_photo_path') like '%..%') then raise exception 'invalid_file'; end if;
  end loop;

  docs := coalesce(p -> 'documents', '[]');
  if jsonb_typeof(docs) <> 'array' or jsonb_array_length(docs) > 6 then raise exception 'invalid_documents'; end if;
  for i in 0 .. jsonb_array_length(docs) - 1 loop
    d := docs -> i;
    if coalesce(d ->> 'kind', '') not in ('birth_certificate', 'vaccination_record', 'other')
       or (d ->> 'path') not like prefix || '%' or (d ->> 'path') like '%..%'
       or coalesce(d ->> 'mime_type', '') not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
       or coalesce((d ->> 'size_bytes')::int, 0) not between 1 and 5242880 then raise exception 'invalid_file'; end if;
  end loop;

  -- the same child, from the same email, within 30 days, is a duplicate
  if exists (select 1 from public.registration_applications a join public.registration_parents rp on rp.application_id = a.id and rp.position = 1
              where lower(a.child_name) = lower(cname) and a.child_dob = dob and lower(rp.email) = firstemail
                and a.created_at > now() - interval '30 days' and a.status <> 'declined') then
    raise exception 'duplicate_application';
  end if;

  insert into public.registration_applications (draft_id, language, child_name, child_dob, programme, preferred_start, child_photo_path,
      allergies, medical_conditions, medications, doctor_name, doctor_phone,
      consent_photos_class, consent_photos_social, consent_outings, consent_emergency_treatment, consent_birthday_wall)
  values (draft, lang, cname, dob, prog, start_, photo,
      nullif(btrim(p #>> '{health,allergies}'), ''), nullif(btrim(p #>> '{health,medical_conditions}'), ''), nullif(btrim(p #>> '{health,medications}'), ''),
      nullif(btrim(p #>> '{health,doctor_name}'), ''), nullif(btrim(p #>> '{health,doctor_phone}'), ''),
      (cons ->> 'photos_class')::boolean, (cons ->> 'photos_social')::boolean, (cons ->> 'outings')::boolean,
      (cons ->> 'emergency_treatment')::boolean, (cons ->> 'birthday_wall')::boolean)
  returning * into app;

  for i in 0 .. jsonb_array_length(parents) - 1 loop
    d := parents -> i;
    insert into public.registration_parents (application_id, position, full_name, phone, email, relationship)
    values (app.id, i + 1, btrim(d ->> 'full_name'), btrim(d ->> 'phone'), lower(btrim(d ->> 'email')), d ->> 'relationship');
  end loop;
  for i in 0 .. jsonb_array_length(pk) - 1 loop
    d := pk -> i;
    insert into public.registration_pickups (application_id, full_name, relationship, phone, id_photo_path)
    values (app.id, btrim(d ->> 'full_name'), btrim(d ->> 'relationship'), btrim(d ->> 'phone'), nullif(d ->> 'id_photo_path', ''));
  end loop;
  for i in 0 .. jsonb_array_length(docs) - 1 loop
    d := docs -> i;
    insert into public.registration_documents (application_id, kind, storage_path, file_name, mime_type, size_bytes)
    values (app.id, d ->> 'kind', d ->> 'path', left(d ->> 'file_name', 200), d ->> 'mime_type', (d ->> 'size_bytes')::int);
  end loop;
  insert into public.registration_events (application_id, kind, note) values (app.id, 'submitted', null);

  perform public.cka_enqueue_email_address(firstemail, lang, 'registration_received',
    jsonb_build_object('application_no', app.application_no, 'child_name', cname), 'reg-received:' || app.id);
  return jsonb_build_object('id', app.id, 'application_no', app.application_no);
end $$;

-- ---------------------------------------------------------------------------
-- Staff: list, open, change status, approve
-- ---------------------------------------------------------------------------
create function public.registration_list(p_status text default null)
returns table (id uuid, application_no bigint, status text, child_name text, child_dob date, programme text, preferred_start date,
               parent_name text, parent_phone text, parent_email text, created_at timestamptz, document_count int, has_birth_certificate boolean,
               has_vaccination_record boolean, child_id uuid)
language sql stable security definer set search_path = public as $$
  select a.id, a.application_no, a.status, a.child_name, a.child_dob, a.programme, a.preferred_start, rp.full_name, rp.phone, rp.email, a.created_at,
         (select count(*)::int from public.registration_documents d where d.application_id = a.id),
         exists (select 1 from public.registration_documents d where d.application_id = a.id and d.kind = 'birth_certificate'),
         exists (select 1 from public.registration_documents d where d.application_id = a.id and d.kind = 'vaccination_record'),
         a.child_id
  from public.registration_applications a
  left join public.registration_parents rp on rp.application_id = a.id and rp.position = 1
  where public.is_management() and (p_status is null or a.status = p_status)
  order by (a.status in ('approved', 'declined')), a.created_at desc
$$;

create function public.registration_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select to_jsonb(a) || jsonb_build_object(
      'parents', coalesce((select jsonb_agg(to_jsonb(rp) order by rp.position) from public.registration_parents rp where rp.application_id = a.id), '[]'),
      'pickups', coalesce((select jsonb_agg(to_jsonb(k) order by k.full_name) from public.registration_pickups k where k.application_id = a.id), '[]'),
      'documents', coalesce((select jsonb_agg(to_jsonb(d) order by d.kind) from public.registration_documents d where d.application_id = a.id), '[]'),
      'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.registration_events e where e.application_id = a.id), '[]'),
      'class_name', (select name from public.classes where id = a.assigned_class_id))
    into out from public.registration_applications a where a.id = p_id;
  return out;
end $$;

create function public.registration_set_status(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a public.registration_applications; note text := nullif(btrim(coalesce(p_note, '')), ''); ev uuid; em text;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if p_status not in ('new', 'missing_documents', 'tour_booked', 'waitlist', 'declined') then raise exception 'Use approve to approve an application'; end if;
  select * into a from public.registration_applications where id = p_id;
  if a.id is null then raise exception 'Not found'; end if;
  if a.status = 'approved' then raise exception 'This application has already been approved'; end if;
  if p_status in ('missing_documents', 'declined') and note is null then raise exception 'Please say what is missing, or the reason'; end if;
  update public.registration_applications set status = p_status, status_note = note, decided_by = case when p_status = 'declined' then auth.uid() end,
         decided_at = case when p_status = 'declined' then now() end where id = p_id;
  insert into public.registration_events (application_id, actor_id, actor_name, kind, note)
  values (p_id, auth.uid(), public.cka_actor_name(), p_status, note) returning id into ev;
  select email into em from public.registration_parents where application_id = p_id and position = 1;
  if p_status <> 'new' and em is not null then
    perform public.cka_enqueue_email_address(em, a.language, 'registration_update',
      jsonb_build_object('application_no', a.application_no, 'child_name', a.child_name, 'status', p_status, 'note', note), 'reg-status:' || ev);
  end if;
end $$;

-- Approve: creates the child's record in the chosen class, copies the health details, consents, pickup people
-- and documents, and reports who to invite. (The server then sends the portal invitations.)
create function public.approve_registration(p_id uuid, p_class uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.registration_applications; cid uuid; k record; d record; parents jsonb; em text;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  select * into a from public.registration_applications where id = p_id for update;
  if a.id is null then raise exception 'Not found'; end if;
  if a.status in ('approved', 'declined') then raise exception 'This application is already %', a.status; end if;
  if not exists (select 1 from public.classes where id = p_class) then raise exception 'Choose a class'; end if;

  insert into public.children (full_name, date_of_birth, class_id) values (a.child_name, a.child_dob, p_class) returning id into cid;
  insert into public.child_health (child_id, allergies, medical_conditions, medications, doctor_name, doctor_phone, updated_by)
  values (cid, a.allergies, a.medical_conditions, a.medications, a.doctor_name, a.doctor_phone, auth.uid());
  insert into public.child_consents (child_id, photos_class, photos_social, outings, emergency_treatment, birthday_wall, updated_by)
  values (cid, a.consent_photos_class, a.consent_photos_social, a.consent_outings, a.consent_emergency_treatment, a.consent_birthday_wall, auth.uid());
  insert into public.child_pickups (child_id, full_name, relationship, phone, id_photo_path)
    select cid, full_name, relationship, phone, id_photo_path from public.registration_pickups where application_id = p_id;
  insert into public.child_documents (child_id, kind, storage_path, file_name, mime_type, size_bytes)
    select cid, kind, storage_path, file_name, mime_type, size_bytes from public.registration_documents where application_id = p_id;
  if a.child_photo_path is not null then
    insert into public.child_documents (child_id, kind, storage_path, file_name) values (cid, 'child_photo', a.child_photo_path, 'child photo');
  end if;
  perform public.cka_log_child_change(cid, 'created', 'Created from application #' || a.application_no, null, null);

  update public.registration_applications set status = 'approved', status_note = null, child_id = cid, assigned_class_id = p_class, decided_by = auth.uid(), decided_at = now() where id = p_id;
  insert into public.registration_events (application_id, actor_id, actor_name, kind, note) values (p_id, auth.uid(), public.cka_actor_name(), 'approved', null);

  select email into em from public.registration_parents where application_id = p_id and position = 1;
  if em is not null then
    perform public.cka_enqueue_email_address(em, a.language, 'registration_update',
      jsonb_build_object('application_no', a.application_no, 'child_name', a.child_name, 'status', 'approved'), 'reg-approved:' || p_id);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('position', position, 'full_name', full_name, 'phone', phone, 'email', email) order by position), '[]')
    into parents from public.registration_parents where application_id = p_id;
  return jsonb_build_object('child_id', cid, 'language', a.language, 'parents', parents);
end $$;

-- Server only: is there already a login for this email? (used to link a second child to an existing parent)
create function public.find_user_by_email(p_email text) returns table (id uuid, role text, active boolean)
language sql stable security definer set search_path = public as $$
  select u.id, p.role, p.active from auth.users u join public.profiles p on p.id = u.id where lower(u.email) = lower(btrim(p_email))
$$;

-- ---------------------------------------------------------------------------
-- Teachers: allergies for the children in their classes (and ONLY allergies)
-- ---------------------------------------------------------------------------
create function public.class_allergies()
returns table (child_id uuid, child_name text, class_name text, allergies text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, cl.name, nullif(btrim(h.allergies), '')
  from public.children c
  join public.classes cl on cl.id = c.class_id
  left join public.child_health h on h.child_id = c.id
  where c.active and (public.is_management() or public.teaches_class(c.class_id))
  order by cl.name, c.full_name
$$;

-- ---------------------------------------------------------------------------
-- Parents: update a child's allergies/health and pickup people (staff are told, the change is logged)
-- ---------------------------------------------------------------------------
create function public.parent_update_health(p_child uuid, p_allergies text, p_conditions text, p_medications text, p_doctor_name text, p_doctor_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare old public.child_health; s uuid; ch uuid; summary text := '';
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if length(coalesce(p_allergies, '')) > 2000 or length(coalesce(p_conditions, '')) > 2000 or length(coalesce(p_medications, '')) > 2000 then raise exception 'That is too long'; end if;
  if nullif(btrim(coalesce(p_doctor_phone, '')), '') is not null and not public.cka_is_phone(btrim(p_doctor_phone)) then raise exception 'Please check the doctor''s phone number'; end if;
  select * into old from public.child_health where child_id = p_child;
  if old.child_id is null then
    insert into public.child_health (child_id, updated_by) values (p_child, auth.uid()); select * into old from public.child_health where child_id = p_child;
  end if;
  if old.allergies is distinct from nullif(btrim(coalesce(p_allergies, '')), '') then summary := summary || 'Allergies. '; end if;
  if old.medical_conditions is distinct from nullif(btrim(coalesce(p_conditions, '')), '') then summary := summary || 'Medical conditions. '; end if;
  if old.medications is distinct from nullif(btrim(coalesce(p_medications, '')), '') then summary := summary || 'Medications. '; end if;
  if old.doctor_name is distinct from nullif(btrim(coalesce(p_doctor_name, '')), '') or old.doctor_phone is distinct from nullif(btrim(coalesce(p_doctor_phone, '')), '') then summary := summary || 'Doctor. '; end if;
  if summary = '' then return; end if;
  update public.child_health set allergies = nullif(btrim(coalesce(p_allergies, '')), ''), medical_conditions = nullif(btrim(coalesce(p_conditions, '')), ''),
         medications = nullif(btrim(coalesce(p_medications, '')), ''), doctor_name = nullif(btrim(coalesce(p_doctor_name, '')), ''),
         doctor_phone = nullif(btrim(coalesce(p_doctor_phone, '')), ''), updated_at = now(), updated_by = auth.uid() where child_id = p_child;
  perform public.cka_log_child_change(p_child, 'health', 'Parent updated: ' || btrim(summary),
    concat_ws(' | ', old.allergies, old.medical_conditions, old.medications), concat_ws(' | ', nullif(btrim(p_allergies), ''), nullif(btrim(p_conditions), ''), nullif(btrim(p_medications), '')));
  select id into ch from public.child_change_log where child_id = p_child order by created_at desc limit 1;
  for s in select * from public.cka_class_staff_and_admins(p_child) loop
    perform public.cka_enqueue_email(s, 'child_health_changed', jsonb_build_object('child_id', p_child), 'health:' || ch || ':' || s);
  end loop;
end $$;

create function public.parent_save_pickup(p_child uuid, p_pickup uuid, p_name text, p_relationship text, p_phone text, p_id_photo_path text default null, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid := p_pickup; s uuid; ch uuid; photo text := nullif(btrim(coalesce(p_id_photo_path, '')), '');
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(btrim(coalesce(p_relationship, ''))) < 2 or not public.cka_is_phone(btrim(coalesce(p_phone, ''))) then raise exception 'Please check the name, relationship and phone number'; end if;
  if photo is not null and (photo not like p_child::text || '/pickups/%' or photo like '%..%') then raise exception 'Invalid photo'; end if;
  if pid is null then
    if (select count(*) from public.child_pickups where child_id = p_child and active) >= 8 then raise exception 'You can list at most 8 people'; end if;
    insert into public.child_pickups (child_id, full_name, relationship, phone, id_photo_path, active)
    values (p_child, btrim(p_name), btrim(p_relationship), btrim(p_phone), photo, coalesce(p_active, true)) returning id into pid;
    perform public.cka_log_child_change(p_child, 'pickup', 'Parent added a pickup person: ' || btrim(p_name), null, btrim(p_name));
  else
    if not exists (select 1 from public.child_pickups where id = pid and child_id = p_child) then raise exception 'Not found'; end if;
    update public.child_pickups set full_name = btrim(p_name), relationship = btrim(p_relationship), phone = btrim(p_phone),
           id_photo_path = coalesce(photo, id_photo_path), active = coalesce(p_active, true) where id = pid;
    perform public.cka_log_child_change(p_child, 'pickup', case when coalesce(p_active, true) then 'Parent changed a pickup person: ' else 'Parent removed a pickup person: ' end || btrim(p_name), null, btrim(p_name));
  end if;
  select id into ch from public.child_change_log where child_id = p_child order by created_at desc limit 1;
  for s in select * from public.cka_class_staff_and_admins(p_child) loop
    perform public.cka_enqueue_email(s, 'child_pickup_changed', jsonb_build_object('child_id', p_child), 'pickup:' || ch || ':' || s);
  end loop;
  return pid;
end $$;

-- Grants: browsers may call the staff, teacher and parent functions; the server alone calls the rest.
revoke all on function
  public.cka_enqueue_email_address(text, text, text, jsonb, text), public.cka_log_child_change(uuid, text, text, text, text),
  public.cka_class_staff_and_admins(uuid), public.registration_rate_hit(text, int), public.register_application(jsonb), public.find_user_by_email(text),
  public.registration_list(text), public.registration_get(uuid), public.registration_set_status(uuid, text, text), public.approve_registration(uuid, uuid),
  public.class_allergies(), public.parent_update_health(uuid, text, text, text, text, text), public.parent_save_pickup(uuid, uuid, text, text, text, text, boolean)
from public, anon, authenticated;
grant execute on function public.registration_list(text), public.registration_get(uuid), public.registration_set_status(uuid, text, text), public.approve_registration(uuid, uuid),
  public.class_allergies(), public.parent_update_health(uuid, text, text, text, text, text), public.parent_save_pickup(uuid, uuid, text, text, text, text, boolean) to authenticated;
