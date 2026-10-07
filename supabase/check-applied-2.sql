-- Read-only: what does this Supabase project contain? Changes nothing.
select 'tables in the public schema' as what, count(*)::text as result from pg_tables where schemaname = 'public'
union all select 'core tables (profiles, children, submissions)',
  (to_regclass('public.profiles') is not null)::text || ', ' || (to_regclass('public.children') is not null)::text || ', ' || (to_regclass('public.submissions') is not null)::text
union all select 'migration 9 notifications (email_outbox)', (to_regclass('public.email_outbox') is not null)::text
union all select 'migration 11 owner dashboard (hr_log)', (to_regclass('public.hr_log') is not null)::text
union all select 'migration 12 owner routines (checklist_items)', (to_regclass('public.checklist_items') is not null)::text
union all select 'migration 14 registration', (to_regclass('public.registration_applications') is not null)::text
union all select 'attendance', (to_regclass('public.attendance') is not null)::text
union all select 'project address', current_database();
