-- Row-level security (Prompt 3). Privacy lives here, in the database, not in the screens.
-- Default is "no access": a table with RLS on and no matching policy returns nothing.
-- Deactivated users have auth_role() = NULL, so every policy below refuses them.

alter table public.profiles               enable row level security;
alter table public.classes                enable row level security;
alter table public.children               enable row level security;
alter table public.parent_children        enable row level security;
alter table public.staff_classes          enable row level security;
alter table public.submissions            enable row level security;
alter table public.submission_events      enable row level security;
alter table public.incidents              enable row level security;
alter table public.investigations         enable row level security;
alter table public.investigation_internal enable row level security;
alter table public.investigation_steps    enable row level security;
alter table public.ratings                enable row level security;
alter table public.attachments            enable row level security;

-- Start from nothing; grant only what the policies need.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles, public.classes, public.children, public.parent_children, public.staff_classes,
                public.submissions, public.submission_events, public.incidents, public.investigations,
                public.investigation_internal, public.investigation_steps, public.ratings, public.attachments
  to authenticated;
grant insert on public.submissions, public.submission_events, public.incidents, public.investigation_steps,
                public.investigations, public.ratings, public.attachments,
                public.children, public.classes, public.parent_children, public.staff_classes
  to authenticated;
grant update on public.submissions, public.incidents, public.investigations, public.investigation_internal,
                public.children, public.classes
  to authenticated;
-- Users may edit only these three fields of their own profile. Roles and active flags are
-- changed only by the server (Prompt 4) using the service key.
grant update (full_name, phone, language) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_self        on public.profiles for select using (id = auth.uid() and public.auth_role() is not null);
create policy profiles_management  on public.profiles for select using (public.is_management());
create policy profiles_teacher     on public.profiles for select using (public.teacher_sees_parent(id));
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid() and public.auth_role() is not null) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- classes, children, links
-- ---------------------------------------------------------------------------
create policy classes_management on public.classes for select using (public.is_management());
create policy classes_teacher    on public.classes for select using (public.teaches_class(id));
create policy classes_parent     on public.classes for select using (
  public.auth_role() = 'parent' and exists (
    select 1 from public.children c where c.class_id = classes.id and public.can_see_child(c.id)));
create policy classes_write      on public.classes for insert with check (public.is_management());
create policy classes_update     on public.classes for update using (public.is_management()) with check (public.is_management());

create policy children_select on public.children for select using (public.can_see_child(id));
create policy children_insert on public.children for insert with check (public.is_management());
create policy children_update on public.children for update using (public.is_management()) with check (public.is_management());

create policy parent_children_own        on public.parent_children for select
  using (public.auth_role() = 'parent' and parent_id = auth.uid());
create policy parent_children_management on public.parent_children for select using (public.is_management());
create policy parent_children_insert     on public.parent_children for insert with check (public.is_management());

create policy staff_classes_own        on public.staff_classes for select using (staff_id = auth.uid() and public.auth_role() is not null);
create policy staff_classes_management on public.staff_classes for select using (public.is_management());
create policy staff_classes_insert     on public.staff_classes for insert with check (public.is_management());

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
create policy submissions_parent_select on public.submissions for select
  using (public.auth_role() = 'parent' and parent_id = auth.uid());
create policy submissions_staff_select  on public.submissions for select
  using (public.staff_can_see_submission(id));
create policy submissions_parent_insert on public.submissions for insert
  with check (public.auth_role() = 'parent' and parent_id = auth.uid() and public.can_see_child(child_id)
              and type in ('complaint', 'safety_concern'));
create policy submissions_staff_update  on public.submissions for update
  using (public.staff_can_see_submission(id)) with check (public.staff_can_see_submission(id));
-- Parents have no UPDATE policy: they act through respond_to_resolution().

-- ---------------------------------------------------------------------------
-- submission_events
-- ---------------------------------------------------------------------------
create policy events_parent_select on public.submission_events for select
  using (visible_to_parent and public.owns_submission(submission_id));
create policy events_staff_select  on public.submission_events for select
  using (public.staff_can_see_submission(submission_id));
create policy events_parent_insert on public.submission_events for insert
  with check (event_type = 'parent_reply' and visible_to_parent and actor_id = auth.uid()
              and public.owns_submission(submission_id));
create policy events_staff_insert  on public.submission_events for insert
  with check (actor_id = auth.uid() and event_type in ('update', 'internal_note')
              and (visible_to_parent = (event_type = 'update'))
              and public.staff_can_see_submission(submission_id));

-- ---------------------------------------------------------------------------
-- incidents (staff log them; parents read their own child's)
-- ---------------------------------------------------------------------------
create policy incidents_select on public.incidents for select using (public.can_see_child(child_id));
create policy incidents_insert on public.incidents for insert
  with check (public.auth_role() in ('teacher', 'admin', 'manager', 'owner')
              and reported_by = auth.uid() and public.can_see_child(child_id));
create policy incidents_update on public.incidents for update
  using (public.is_management()) with check (public.is_management());

-- ---------------------------------------------------------------------------
-- investigations
--   parents:       the shared part of their own, only
--   admin:         the shared part, never internal findings
--   manager/owner: everything
--   teachers:      nothing
-- ---------------------------------------------------------------------------
create policy investigations_parent     on public.investigations for select using (public.parent_owns_investigation(id));
create policy investigations_management on public.investigations for select using (public.is_management());
create policy investigations_insert     on public.investigations for insert with check (public.is_manager_or_owner());
create policy investigations_update     on public.investigations for update
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

create policy investigation_internal_select on public.investigation_internal for select using (public.is_manager_or_owner());
create policy investigation_internal_update on public.investigation_internal for update
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

create policy steps_parent     on public.investigation_steps for select using (public.parent_owns_investigation(investigation_id));
create policy steps_management on public.investigation_steps for select using (public.is_management());
create policy steps_insert     on public.investigation_steps for insert with check (public.is_manager_or_owner());

-- ---------------------------------------------------------------------------
-- ratings: a parent writes (and re-reads) their own; only manager and owner read the rest
-- ---------------------------------------------------------------------------
create policy ratings_own        on public.ratings for select using (public.auth_role() = 'parent' and parent_id = auth.uid());
create policy ratings_management on public.ratings for select using (public.is_manager_or_owner());
create policy ratings_insert     on public.ratings for insert
  with check (public.auth_role() = 'parent' and parent_id = auth.uid() and public.can_see_child(child_id));

-- ---------------------------------------------------------------------------
-- attachments (metadata; the files are in the private storage bucket)
-- ---------------------------------------------------------------------------
create policy attachments_parent_select on public.attachments for select using (public.owns_submission(submission_id));
create policy attachments_staff_select  on public.attachments for select using (public.staff_can_see_submission(submission_id));
create policy attachments_insert        on public.attachments for insert
  with check (uploaded_by = auth.uid()
              and (public.owns_submission(submission_id) or public.staff_can_see_submission(submission_id))
              and storage_path like submission_id::text || '/%');
