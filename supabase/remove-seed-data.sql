-- Removes ALL test data created by seed.sql (and anything the seed logins created while
-- testing). Run once before launch, in the Supabase SQL editor. It only touches rows tied
-- to the fake "@seed.cka.test" logins, so real families are not affected.
--
-- Timeline events and investigation steps are permanent records (protected by triggers),
-- so those two protections are switched off for this clean-up and switched back on after.

begin;

create temporary table seed_users on commit drop as
  select id from auth.users where email like '%@seed.cka.test';
create temporary table seed_children on commit drop as
  select id from public.children where full_name like '%(seed)';
create temporary table seed_classes on commit drop as
  select id from public.classes where name like '%(seed)';
create temporary table seed_subs on commit drop as
  select id from public.submissions
   where parent_id in (select id from seed_users) or child_id in (select id from seed_children);
create temporary table seed_incidents on commit drop as
  select id from public.incidents
   where child_id in (select id from seed_children) or reported_by in (select id from seed_users);
create temporary table seed_invs on commit drop as
  select id from public.investigations
   where submission_id in (select id from seed_subs) or incident_id in (select id from seed_incidents);

alter table public.submission_events   disable trigger submission_events_no_update;
alter table public.investigation_steps disable trigger investigation_steps_no_change;

delete from public.deadline_events        where submission_id in (select id from seed_subs);
delete from public.email_outbox           where user_id in (select id from seed_users);
delete from public.attachments            where submission_id in (select id from seed_subs);
delete from public.ratings                where parent_id in (select id from seed_users) or child_id in (select id from seed_children);
delete from public.investigation_steps    where investigation_id in (select id from seed_invs);
delete from public.investigation_internal where investigation_id in (select id from seed_invs);
delete from public.investigations         where id in (select id from seed_invs);
delete from public.submission_events      where submission_id in (select id from seed_subs);
delete from public.incidents              where id in (select id from seed_incidents);
delete from public.submissions            where id in (select id from seed_subs);
delete from public.parent_children        where parent_id in (select id from seed_users) or child_id in (select id from seed_children);
delete from public.staff_classes          where staff_id in (select id from seed_users) or class_id in (select id from seed_classes);
delete from public.children               where id in (select id from seed_children);
delete from public.classes                where id in (select id from seed_classes);
delete from public.profiles               where id in (select id from seed_users);
delete from auth.identities               where user_id in (select id from seed_users);
delete from auth.users                    where id in (select id from seed_users);

alter table public.submission_events   enable trigger submission_events_no_update;
alter table public.investigation_steps enable trigger investigation_steps_no_change;

commit;
