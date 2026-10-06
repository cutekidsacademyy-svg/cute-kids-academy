-- TEST DATA ONLY. Every name, email and phone number below is fake.
-- Never apply this to the live (production) project. Remove it before launch with
-- supabase/remove-seed-data.sql.
--
-- The seed logins have NO usable password. To try one, set a password for it in the
-- Supabase dashboard (Authentication > Users) or use "forgot password". The password
-- is never stored in this repository.
--
-- Fixed IDs make the data easy to reference in tests:
--   staff   00000000-0000-4000-8000-0000000000{01..05}   teacher Hana, teacher Mariam, admin, manager, owner
--   parents 00000000-0000-4000-8000-0000000001{01..03}   A, B, C
--   classes 00000000-0000-4000-8000-0000000002{01..02}
--   children 00000000-0000-4000-8000-0000000003{01..04}  Alpha, Beta, Gamma, Delta

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email,
       md5(random()::text),                          -- not a valid password hash: nobody can log in
       now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
from (values
  ('00000000-0000-4000-8000-000000000001', 'teacher.hana@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000002', 'teacher.mariam@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000003', 'admin.sara@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000004', 'manager.dina@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000005', 'owner.laila@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000101', 'parent.a@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000102', 'parent.b@seed.cka.test'),
  ('00000000-0000-4000-8000-000000000103', 'parent.c@seed.cka.test')
) as u(id, email);

insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
select gen_random_uuid(), u.id, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', u.id::text, now(), now(), now()
from auth.users u where u.email like '%@seed.cka.test';

insert into public.profiles (id, full_name, phone, language, role) values
  ('00000000-0000-4000-8000-000000000001', 'Teacher Hana (seed)',   '+20 100 000 0001', 'en', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', 'Teacher Mariam (seed)', '+20 100 000 0002', 'ar', 'teacher'),
  ('00000000-0000-4000-8000-000000000003', 'Admin Sara (seed)',     '+20 100 000 0003', 'en', 'admin'),
  ('00000000-0000-4000-8000-000000000004', 'Manager Dina (seed)',   '+20 100 000 0004', 'en', 'manager'),
  ('00000000-0000-4000-8000-000000000005', 'Owner Laila (seed)',    '+20 100 000 0005', 'en', 'owner'),
  ('00000000-0000-4000-8000-000000000101', 'Parent A (seed)',       '+20 100 000 0101', 'en', 'parent'),
  ('00000000-0000-4000-8000-000000000102', 'Parent B (seed)',       '+20 100 000 0102', 'ar', 'parent'),
  ('00000000-0000-4000-8000-000000000103', 'Parent C (seed)',       '+20 100 000 0103', 'en', 'parent');

insert into public.classes (id, name, age_group, head_teacher_id) values
  ('00000000-0000-4000-8000-000000000201', 'Butterflies (seed)', '1-2 years', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000202', 'Ducklings (seed)',   '2-3 years', '00000000-0000-4000-8000-000000000002');

insert into public.staff_classes (staff_id, class_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000202');

insert into public.children (id, full_name, date_of_birth, class_id) values
  ('00000000-0000-4000-8000-000000000301', 'Omar Testson (seed)', '2024-03-10', '00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000302', 'Salma Testson (seed)',  '2024-06-21', '00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000303', 'Youssef Testson (seed)', '2023-09-02', '00000000-0000-4000-8000-000000000202'),
  ('00000000-0000-4000-8000-000000000304', 'Mariam Testson (seed)', '2023-12-15', '00000000-0000-4000-8000-000000000202');

-- Parent A: Alpha.  Parent B: Beta and Gamma.  Parent C: Delta, and is Alpha's second parent.
insert into public.parent_children (parent_id, child_id) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000302'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000303'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000304'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000301');

insert into public.submissions (id, parent_id, child_id, type, title, description, urgency, about_staff_member) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000301',
   'complaint', 'Seed: lunch concern', 'Seed text: my child came home hungry twice this week.', 'urgent', null),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000302',
   'complaint', 'Seed: concern about a teacher', 'Seed text: a concern about Teacher Hana.', 'can_wait',
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000304',
   'safety_concern', 'Seed: mark on arm', 'Seed text: a small bruise noticed at home.', 'critical', null);

-- An internal staff note and a parent-visible update on submission 1.
insert into public.submission_events (submission_id, actor_id, actor_name, event_type, message, visible_to_parent) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000003', 'Admin Sara (seed)', 'internal_note',
   'SEED INTERNAL NOTE: staff only, never for parents', false),
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000003', 'Admin Sara (seed)', 'update',
   'Seed update: we are looking into this.', true);

insert into public.attachments (submission_id, uploaded_by, storage_path, file_name, mime_type, size_bytes) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000401/seed-photo.jpg', 'seed-photo.jpg', 'image/jpeg', 120000);

-- A staff-logged accident for Gamma, and the safety investigation for Delta's concern.
insert into public.incidents (id, child_id, occurred_at, location, what_happened, injury, first_aid, severity,
                              witnesses, parent_called_at, reported_by) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000303', now() - interval '2 hours',
   'Garden', 'Seed text: tripped on the path.', 'Small graze on the knee', 'Cleaned and plaster applied',
   'needs_attention', array['Teacher Mariam (seed)'], now() - interval '90 minutes',
   '00000000-0000-4000-8000-000000000002');

-- The safety concern above opened its investigation automatically (assigned to the manager).
-- Fill in some shared findings and internal notes on it for testing.
update public.investigations
   set findings_for_parent = 'Seed findings for the parent: nothing unusual found at the academy.'
 where submission_id = '00000000-0000-4000-8000-000000000403';
update public.investigation_internal
   set internal_findings = 'SEED INTERNAL FINDINGS: names Youssef Testson (seed); staff only',
       staff_statements = 'SEED STAFF STATEMENT: staff only'
 where investigation_id = (select id from public.investigations where submission_id = '00000000-0000-4000-8000-000000000403');

insert into public.ratings (parent_id, child_id, care_score, communication_score, daily_reports_score, comment) values
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000302', 5, 4, 5, 'Seed rating comment');

-- Registration: one application waiting for review, and the health details / pickup people / consents of the seed children.
insert into public.registration_applications (id, draft_id, child_name, child_dob, programme, preferred_start, allergies, medical_conditions,
    consent_photos_class, consent_photos_social, consent_outings, consent_emergency_treatment, consent_birthday_wall) values
  ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-0000000007d1', 'Layla Applicant (seed)', '2025-05-05', 'nursery', current_date + 30,
   'SEED APPLICANT ALLERGY: egg', 'SEED APPLICANT CONDITION', true, false, true, true, false);
insert into public.registration_parents (application_id, position, full_name, phone, email, relationship) values
  ('00000000-0000-4000-8000-000000000701', 1, 'Seed Applicant Parent (seed)', '+20 100 000 0201', 'applicant@seed.cka.test', 'mother');
insert into public.registration_pickups (application_id, full_name, relationship, phone) values
  ('00000000-0000-4000-8000-000000000701', 'Seed Applicant Aunt (seed)', 'aunt', '+20 100 000 0202');
insert into public.registration_documents (application_id, kind, storage_path, file_name, mime_type, size_bytes) values
  ('00000000-0000-4000-8000-000000000701', 'birth_certificate', 'drafts/00000000-0000-4000-8000-0000000007d1/birth_certificate/seed.pdf', 'seed.pdf', 'application/pdf', 1000);
insert into public.registration_events (application_id, kind) values ('00000000-0000-4000-8000-000000000701', 'submitted');

insert into public.child_health (child_id, allergies, medical_conditions) values
  ('00000000-0000-4000-8000-000000000301', 'Peanut allergy (seed)', null),
  ('00000000-0000-4000-8000-000000000302', null, 'SEED HEALTH SECRET: asthma inhaler'),
  ('00000000-0000-4000-8000-000000000303', 'None known (seed)', null);
insert into public.child_pickups (child_id, full_name, relationship, phone) values
  ('00000000-0000-4000-8000-000000000301', 'Grandma Seed (seed)', 'grandmother', '+20 100 000 0301'),
  ('00000000-0000-4000-8000-000000000302', 'Uncle Seed Secret (seed)', 'uncle', '+20 100 000 0302');
insert into public.child_consents (child_id, photos_class, photos_social, outings, emergency_treatment, birthday_wall) values
  ('00000000-0000-4000-8000-000000000301', true, false, true, true, false);
insert into public.child_documents (child_id, kind, storage_path) values
  ('00000000-0000-4000-8000-000000000301', 'birth_certificate', 'drafts/seed/birth.pdf');
insert into public.child_change_log (child_id, kind, summary) values
  ('00000000-0000-4000-8000-000000000301', 'created', 'SEED LOG: created from application');
