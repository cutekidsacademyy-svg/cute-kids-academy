-- Who-can-see-what helpers (Prompt 3). Used by the row-level security policies.
-- They are SECURITY DEFINER so they can look at tables without triggering the
-- policies on those tables (which would loop). Each one only answers a yes/no
-- or role question about the CURRENT user (auth.uid()).

-- Role of the current user. NULL when not logged in or when the account is deactivated,
-- so a deactivated user instantly loses all access.
create function public.auth_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create function public.is_management() returns boolean   -- admin, manager or owner
language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() in ('admin', 'manager', 'owner'), false)
$$;

create function public.is_manager_or_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() in ('manager', 'owner'), false)
$$;

-- Does the current teacher work in this class (or head it)?
create function public.teaches_class(p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'teacher' and p_class is not null and (
    exists (select 1 from public.staff_classes sc where sc.staff_id = auth.uid() and sc.class_id = p_class)
    or exists (select 1 from public.classes c where c.id = p_class and c.head_teacher_id = auth.uid())
  )
$$;

-- Can the current user see this child at all?
create function public.can_see_child(p_child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.auth_role()
    when 'admin' then true
    when 'manager' then true
    when 'owner' then true
    when 'teacher' then exists (
      select 1 from public.children c where c.id = p_child and public.teaches_class(c.class_id))
    when 'parent' then exists (
      select 1 from public.parent_children pc where pc.parent_id = auth.uid() and pc.child_id = p_child)
    else false
  end
$$;

create function public.owns_submission(p_submission uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'parent' and exists (
    select 1 from public.submissions s where s.id = p_submission and s.parent_id = auth.uid())
$$;

-- Can the current STAFF member see this submission? (Parents use owns_submission.)
-- Teachers: children in their classes, never a complaint about themselves.
create function public.staff_can_see_submission(p_submission uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.is_management() then exists (select 1 from public.submissions s where s.id = p_submission)
    when public.auth_role() = 'teacher' then exists (
      select 1 from public.submissions s
      where s.id = p_submission
        and public.can_see_child(s.child_id)
        and s.about_staff_member is distinct from auth.uid())
    else false
  end
$$;

-- Does this investigation belong to the current parent (via their submission or their child's incident)?
create function public.parent_owns_investigation(p_investigation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'parent' and exists (
    select 1 from public.investigations i
    left join public.submissions s on s.id = i.submission_id
    left join public.incidents n on n.id = i.incident_id
    where i.id = p_investigation
      and (s.parent_id = auth.uid()
           or (n.child_id is not null and public.can_see_child(n.child_id))))
$$;

-- Teachers may see the parents of children in their classes (for contact), nobody else's.
create function public.teacher_sees_parent(p_parent uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'teacher' and exists (
    select 1 from public.parent_children pc where pc.parent_id = p_parent and public.can_see_child(pc.child_id))
$$;

-- Name of whoever is handling a parent's own submission (parents cannot read other profiles).
create function public.submission_handler_name(p_submission uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.full_name
  from public.submissions s join public.profiles p on p.id = s.assigned_to
  where s.id = p_submission and public.owns_submission(p_submission)
$$;

revoke all on function
  public.auth_role(), public.is_management(), public.is_manager_or_owner(), public.teaches_class(uuid),
  public.can_see_child(uuid), public.owns_submission(uuid), public.staff_can_see_submission(uuid),
  public.parent_owns_investigation(uuid), public.teacher_sees_parent(uuid), public.submission_handler_name(uuid)
from public;
grant execute on function
  public.auth_role(), public.is_management(), public.is_manager_or_owner(), public.teaches_class(uuid),
  public.can_see_child(uuid), public.owns_submission(uuid), public.staff_can_see_submission(uuid),
  public.parent_owns_investigation(uuid), public.teacher_sees_parent(uuid), public.submission_handler_name(uuid)
to authenticated;
