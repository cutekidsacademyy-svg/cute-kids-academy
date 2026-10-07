-- Read-only: shows which migrations your Supabase project already has. Changes nothing.
select m.migration, case when m.ok then 'applied' else 'MISSING' end as status from (values
  ('20261006121500 attendance',      to_regclass('public.attendance') is not null),
  ('20261006121600 daily reports',   to_regclass('public.daily_reports') is not null),
  ('20261006121700 announcements',   to_regclass('public.announcements') is not null),
  ('20261006121800 menu and events', to_regclass('public.events') is not null),
  ('20261006121900 photos',          to_regclass('public.media_items') is not null),
  ('20261006122000 admin area',      to_regclass('public.academy_settings') is not null),
  ('20261006122100 questions',       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'parent_month_summary')),
  ('20261006122200 absences',        to_regclass('public.absence_followups') is not null),
  ('20261006122300 payments',        to_regclass('public.payments') is not null),
  ('20261006122400 birthdays/transport', to_regclass('public.bus_routes') is not null)
) as m(migration, ok) order by 1;
