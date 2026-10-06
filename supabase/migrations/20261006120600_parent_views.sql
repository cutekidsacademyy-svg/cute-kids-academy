-- Narrow, parent-safe lookups for the parent portal (Prompt 5).
-- Parents cannot read other people's profiles, so anything that needs a staff name goes
-- through these functions. Each returns only what a parent may see, and only their own data.

-- The parent's own cases, with the name of whoever is handling each (no escalation level,
-- no internal fields).
create function public.parent_cases()
returns table (
  id uuid, ref_no bigint, type text, title text, urgency text, status text,
  created_at timestamptz, acknowledge_by timestamptz, resolve_by timestamptz,
  parent_satisfied boolean, handler_name text
)
language sql stable security definer set search_path = public as $$
  select s.id, s.ref_no, s.type, s.title, s.urgency, s.status,
         s.created_at, s.acknowledge_by, s.resolve_by, s.parent_satisfied, p.full_name
  from public.submissions s
  left join public.profiles p on p.id = s.assigned_to
  where public.auth_role() = 'parent' and s.parent_id = auth.uid()
  order by s.created_at desc
$$;

-- Accident reports about the parent's own children, with the reporting staff member's name.
create function public.parent_incidents()
returns table (
  id uuid, child_id uuid, child_name text, occurred_at timestamptz, location text,
  what_happened text, injury text, first_aid text, severity text,
  parent_called_at timestamptz, parent_signed_at timestamptz, reported_by_name text
)
language sql stable security definer set search_path = public as $$
  select i.id, i.child_id, c.full_name, i.occurred_at, i.location,
         i.what_happened, i.injury, i.first_aid, i.severity,
         i.parent_called_at, i.parent_signed_at, p.full_name
  from public.incidents i
  join public.children c on c.id = i.child_id
  left join public.profiles p on p.id = i.reported_by
  where public.auth_role() = 'parent' and public.can_see_child(i.child_id)
  order by i.occurred_at desc
$$;

-- Names (only) of active staff, so a parent can say a concern or a compliment is about someone.
-- Parents only; no phone, email or role is returned.
create function public.list_staff_names()
returns table (id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name
  from public.profiles p
  where public.auth_role() = 'parent' and p.active and p.role in ('teacher', 'admin', 'manager')
  order by p.full_name
$$;

revoke all on function public.parent_cases(), public.parent_incidents(), public.list_staff_names() from public;
grant execute on function public.parent_cases(), public.parent_incidents(), public.list_staff_names() to authenticated;
