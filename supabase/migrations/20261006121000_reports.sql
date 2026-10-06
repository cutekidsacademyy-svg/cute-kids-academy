-- Manager and owner reports (Prompt 9). One function returns every number for a period, so the
-- page, the CSV download and the tests all use the same source. Manager and owner only.
--
-- Definitions (all dates are Cairo time, the period runs from the start of p_from to the end of p_to):
--   * Cases are counted by the day they were received.
--   * "Acknowledged on time" = acknowledged by the promised time, out of the cases whose acknowledge
--     deadline has passed or that were acknowledged. "Resolved on time" works the same way.
--   * "Overdue now" and "investigations still open" are about right now, not the period.
--   * Average time to resolve is wall-clock hours from received to resolved.
--   * Escalations come from the case timeline (each time a case moved up a level in the period).
--   * Ratings: this is the month containing the end of the period, compared with the month before.

create function public.staff_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f timestamptz; t timestamptz; m0 date; m1 date; out jsonb;
begin
  if not public.is_manager_or_owner() then raise exception 'Not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid period'; end if;
  if p_to - p_from > 800 then raise exception 'The period is too long'; end if;

  f := p_from::timestamp at time zone 'Africa/Cairo';
  t := (p_to + 1)::timestamp at time zone 'Africa/Cairo';
  m0 := date_trunc('month', p_to)::date;
  m1 := (m0 - interval '1 month')::date;

  with
  subs as (select * from public.submissions where created_at >= f and created_at < t),
  ack as (select * from subs where acknowledged_at is not null or acknowledge_by <= now()),
  res as (select * from subs where resolved_at is not null or resolve_by <= now()),
  esc as (select e.* from public.submission_events e where e.event_type = 'escalated' and e.created_at >= f and e.created_at < t),
  inc as (select i.*, coalesce(cl.name, '—') as class_name from public.incidents i
            join public.children c on c.id = i.child_id left join public.classes cl on cl.id = c.class_id
           where i.occurred_at >= f and i.occurred_at < t),
  rat as (select r.*, coalesce(cl.name, '—') as class_name from public.ratings r left join public.classes cl on cl.id = r.class_id)
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', jsonb_build_object(
        'received', (select count(*) from subs),
        'open_now', (select count(*) from public.submissions where status in ('received', 'acknowledged', 'in_progress')),
        'overdue_now', (select count(*) from public.submissions s
                         where (s.status = 'received' and s.acknowledge_by < now())
                            or (s.status in ('acknowledged', 'in_progress') and s.resolve_by < now()))),
    'by_type_urgency', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'urgency', urgency, 'count', n) order by type, urgency)
                                   from (select type, urgency, count(*) n from subs group by 1, 2) x), '[]'),
    'on_time', jsonb_build_object(
        'acknowledged', jsonb_build_object(
            'due', (select count(*) from ack),
            'on_time', (select count(*) from ack where acknowledged_at is not null and acknowledged_at <= acknowledge_by)),
        'resolved', jsonb_build_object(
            'due', (select count(*) from res),
            'on_time', (select count(*) from res where resolved_at is not null and resolved_at <= resolve_by))),
    'avg_resolve_hours', (select round((avg(extract(epoch from (resolved_at - created_at))) / 3600)::numeric, 1) from subs where resolved_at is not null),
    'escalations', jsonb_build_object(
        'cases', (select count(distinct submission_id) from esc),
        'moves', (select count(*) from esc),
        'by_level', coalesce((select jsonb_agg(jsonb_build_object('level', lvl, 'count', n) order by lvl)
                                from (select new_value::int as lvl, count(*) n from esc group by 1) x), '[]')),
    'satisfaction', jsonb_build_object(
        'yes', (select count(*) from subs where parent_satisfied is true),
        'no', (select count(*) from subs where parent_satisfied is false),
        'waiting', (select count(*) from subs where status = 'resolved' and parent_satisfied is null)),
    'incidents', jsonb_build_object(
        'total', (select count(*) from inc),
        'by_class', coalesce((select jsonb_agg(jsonb_build_object('name', class_name, 'count', n) order by n desc, class_name)
                                from (select class_name, count(*) n from inc group by 1) x), '[]'),
        'by_location', coalesce((select jsonb_agg(jsonb_build_object('name', loc, 'count', n) order by n desc, loc)
                                   from (select min(btrim(location)) as loc, count(*) n from inc group by lower(btrim(location))) x), '[]'),
        'by_severity', coalesce((select jsonb_agg(jsonb_build_object('name', severity, 'count', n) order by severity)
                                   from (select severity, count(*) n from inc group by 1) x), '[]'),
        'open_investigations', (select count(*) from public.investigations where status = 'open')),
    'ratings', jsonb_build_object(
        'month', m0, 'previous_month', m1,
        'classes', coalesce((select jsonb_agg(jsonb_build_object(
              'name', c.class_name,
              'count', c.n, 'care', c.care, 'communication', c.comm, 'daily', c.daily,
              'prev_count', coalesce(p.n, 0), 'prev_care', p.care, 'prev_communication', p.comm, 'prev_daily', p.daily) order by c.class_name)
            from (select class_name, count(*) n, round(avg(care_score), 2) care, round(avg(communication_score), 2) comm, round(avg(daily_reports_score), 2) daily
                    from rat where month = m0 group by 1) c
            left join (select class_name, count(*) n, round(avg(care_score), 2) care, round(avg(communication_score), 2) comm, round(avg(daily_reports_score), 2) daily
                         from rat where month = m1 group by 1) p on p.class_name = c.class_name), '[]'),
        'compliments', coalesce((select jsonb_agg(jsonb_build_object('staff', staff, 'count', n, 'items', items) order by n desc, staff)
            from (select coalesce(st.full_name, '—') as staff, count(*) n,
                         jsonb_agg(jsonb_build_object('month', r.month, 'text', r.compliment_text) order by r.created_at) as items
                    from public.ratings r left join public.profiles st on st.id = r.compliment_staff_id
                   where r.created_at >= f and r.created_at < t and (r.compliment_staff_id is not null or nullif(btrim(r.compliment_text), '') is not null)
                   group by 1) x), '[]'))
  ) into out;

  return out;
end $$;

revoke all on function public.staff_report(date, date) from public;
grant execute on function public.staff_report(date, date) to authenticated;
