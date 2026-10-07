-- Minimal stand-in for the parts of Supabase the migrations rely on, so they can be
-- tested on a plain Postgres. NOT a migration: never apply this to a real Supabase project.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- Supabase gives every NEW table, sequence and function in the public schema to anon, authenticated and
-- service_role automatically. Copy that, so the tests catch anything a migration forgets to lock down.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
create schema storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text, role text, email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text
);
create table auth.identities (
  id uuid primary key, user_id uuid references auth.users (id),
  identity_data jsonb, provider text, provider_id text,
  created_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz
);

create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id), name text
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/')
$$;
grant select, insert, update, delete on storage.objects to authenticated;
