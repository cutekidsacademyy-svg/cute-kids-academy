-- TEST LOGINS for your own live check. Run AFTER you have created the two logins in
-- Supabase > Authentication > Users > Add user > Create new user (tick "Auto Confirm User",
-- choose your own passwords there; they are never stored in this repository).
-- 1) Replace the two emails below with the emails you created.  2) Run this file once.
-- It makes the first login an OWNER (sees everything in /staff, including Payments) and the
-- second a PARENT linked to a pretend child "Test Child (test)" in a pretend class.
-- Remove the pretend child later from the admin area (withdraw) or ask Claude Code.
do $$
declare
  owner_email  text := 'PUT-YOUR-OWNER-EMAIL-HERE';
  parent_email text := 'PUT-YOUR-PARENT-EMAIL-HERE';
  o uuid; p uuid; cl uuid; ch uuid;
begin
  select id into o from auth.users where lower(email) = lower(owner_email);
  select id into p from auth.users where lower(email) = lower(parent_email);
  if o is null then raise exception 'No login found for the owner email. Create it in Authentication > Users first, then fix the email at the top of this file.'; end if;
  if p is null then raise exception 'No login found for the parent email. Create it in Authentication > Users first, then fix the email at the top of this file.'; end if;
  if o = p then raise exception 'Use two different emails.'; end if;

  insert into public.profiles (id, full_name, role, language) values (o, 'Owner (test)', 'owner', 'en')
    on conflict (id) do update set role = 'owner', active = true;
  insert into public.profiles (id, full_name, role, language) values (p, 'Parent (test)', 'parent', 'en')
    on conflict (id) do update set role = 'parent', active = true;

  select id into cl from public.classes where name = 'Test class (test)';
  if cl is null then insert into public.classes (name, age_group) values ('Test class (test)', '2-3 years') returning id into cl; end if;
  select id into ch from public.children where full_name = 'Test Child (test)';
  if ch is null then insert into public.children (full_name, date_of_birth, class_id) values ('Test Child (test)', '2024-03-12', cl) returning id into ch; end if;
  insert into public.parent_children (parent_id, child_id) values (p, ch) on conflict do nothing;
end $$;
