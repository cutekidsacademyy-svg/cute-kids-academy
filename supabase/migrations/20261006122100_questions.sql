-- Questions and missing items (Prompt 17, with Prompt 21).
--
-- A parent can now ask a question (topic: fees, schedule, food, my child's day, other) or report a missing item, in
-- addition to complaints and safety concerns. Both become portal cases with the "can wait" promise unless the parent
-- picks "urgent", land in the staff queue, and are emailed to the academy's inbox and to the admins. Replies from
-- staff reach the parent in the portal and by email, exactly like any other case.

alter table public.submissions drop constraint submissions_type_check;
alter table public.submissions add constraint submissions_type_check check (type in ('complaint', 'safety_concern', 'question', 'missing_item'));
alter table public.submissions add column topic text check (topic in ('fees', 'schedule', 'food', 'my_childs_day', 'other'));

drop policy submissions_parent_insert on public.submissions;
create policy submissions_parent_insert on public.submissions for insert
  with check (public.auth_role() = 'parent' and parent_id = auth.uid() and public.can_see_child(child_id)
              and type in ('complaint', 'safety_concern', 'question', 'missing_item'));

-- Parents may not pick Critical for a question or a missing item either (the trigger already refused it for complaints).
create or replace function public.cka_submission_before_insert() returns trigger
language plpgsql as $$
declare d record;
begin
  -- The client never decides these; the database does.
  new.created_at := now();
  new.updated_at := now();
  new.status := 'received';
  new.acknowledged_at := null;
  new.resolved_at := null;
  new.parent_satisfied := null;

  if public.auth_role() = 'parent' then
    new.parent_id := auth.uid();
    new.assigned_to := null;
    if new.urgency = 'critical' and new.type in ('complaint', 'question', 'missing_item') then
      raise exception 'Parents choose Urgent or Can wait; Critical is set automatically for safety concerns';
    end if;
  end if;

  if new.type = 'safety_concern' then
    new.urgency := 'critical';
    new.escalation_level := 3;
  elsif new.about_staff_member is not null then
    new.escalation_level := 3;      -- complaint about a named staff member goes straight to the manager
  else
    new.escalation_level := 1;
  end if;

  select * into d from public.cka_deadlines(new.urgency, new.created_at);
  new.acknowledge_by := d.acknowledge_by;
  new.resolve_by := d.resolve_by;
  return new;
end $$;

-- Tell the academy about a new question or missing item: the inbox address (if set) and every admin.
create function public.cka_notify_question_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; u uuid; payload jsonb;
begin
  payload := jsonb_build_object('id', new.id, 'ref_no', new.ref_no, 'title', new.title, 'urgency', new.urgency, 'type', new.type, 'topic', new.topic,
    'parent_name', (select full_name from public.profiles where id = new.parent_id), 'child_name', (select full_name from public.children where id = new.child_id),
    'text', left(new.description, 1500));
  select email into a from public.academy_settings;
  if a is not null and public.cka_is_email(a) then perform public.cka_enqueue_email_address(a, 'en', 'question_new', payload, 'qnew:' || new.id || ':inbox'); end if;
  for u in select id from public.profiles where role = 'admin' and active loop
    perform public.cka_enqueue_email(u, 'question_new', payload, 'qnew:' || new.id || ':' || u);
  end loop;
  return new;
end $$;
create trigger submissions_after_insert_question after insert on public.submissions
  for each row when (new.type in ('question', 'missing_item')) execute function public.cka_notify_question_insert();

-- This month at a glance, for one of the parent's own children: days attended, days absent (told us / not told us), late pickups.
create function public.parent_month_summary(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := public.cka_today(); first date := date_trunc('month', public.cka_today())::date; since date; last_day date; att int; rep int; unrep int; late int; days int;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  select greatest(first, (created_at at time zone 'Africa/Cairo')::date) into since from public.children where id = p_child;
  last_day := case when (public.cka_now() at time zone 'Africa/Cairo')::time >= time '18:00' then today else today - 1 end;
  select count(*) into att from public.attendance where child_id = p_child and att_date between first and today;
  select count(*) into late from public.attendance where child_id = p_child and att_date between first and today and overtime_minutes > 0;
  select count(*) into days from generate_series(since, last_day, interval '1 day') g where public.cka_is_work_day(g::date);
  select count(*) into rep from generate_series(since, last_day, interval '1 day') g
   where public.cka_is_work_day(g::date) and not exists (select 1 from public.attendance a where a.child_id = p_child and a.att_date = g::date)
     and exists (select 1 from public.attendance_notices n where n.child_id = p_child and n.notice_date = g::date and n.kind = 'absence');
  unrep := greatest(0, days - (select count(*) from public.attendance a where a.child_id = p_child and a.att_date between since and last_day) - rep);
  return jsonb_build_object('attended', att, 'absent_reported', rep, 'absent_unreported', unrep, 'late_pickups', late);
end $$;

revoke all on function public.cka_notify_question_insert(), public.parent_month_summary(uuid) from public, anon, authenticated;
grant execute on function public.parent_month_summary(uuid) to authenticated;
