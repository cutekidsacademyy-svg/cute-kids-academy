-- Working-hours clock (Prompt 3): Sunday-Thursday, 08:00-18:00, Africa/Cairo.
-- Friday and Saturday are not business days. All maths is done on Cairo wall-clock
-- time, so daylight saving is handled by the time-zone database.

create function public.cka_is_work_day(d date) returns boolean
language sql immutable as $$
  select extract(dow from d) in (0, 1, 2, 3, 4)   -- 0 = Sunday ... 4 = Thursday
$$;

create function public.cka_next_work_day(d date) returns date
language plpgsql immutable as $$
declare n date := d + 1;
begin
  while not public.cka_is_work_day(n) loop n := n + 1; end loop;
  return n;
end $$;

-- First moment at or after t (Cairo wall-clock) that is inside working hours.
create function public.cka_working_start(t timestamp) returns timestamp
language plpgsql immutable as $$
begin
  if not public.cka_is_work_day(t::date) then
    return public.cka_next_work_day(t::date) + time '08:00';
  elsif t::time < time '08:00' then
    return t::date + time '08:00';
  elsif t::time >= time '18:00' then
    return public.cka_next_work_day(t::date) + time '08:00';
  end if;
  return t;
end $$;

-- Add working hours, only counting time inside Sun-Thu 08:00-18:00.
create function public.cka_add_working_hours(t timestamp, hrs numeric) returns timestamp
language plpgsql immutable as $$
declare
  cur timestamp := public.cka_working_start(t);
  remaining interval := make_interval(secs => hrs * 3600);
  avail interval;
begin
  loop
    avail := (cur::date + time '18:00') - cur;
    if remaining <= avail then return cur + remaining; end if;
    remaining := remaining - avail;
    cur := public.cka_next_work_day(cur::date) + time '08:00';
  end loop;
end $$;

-- Add business days, keeping the time of day (a request in at 14:00 on Sunday
-- with 1 business day is due Monday 14:00; Thursday 14:00 is due Sunday 14:00).
create function public.cka_add_business_days(t timestamp, n int) returns timestamp
language plpgsql immutable as $$
declare
  cur timestamp := public.cka_working_start(t);
  i int;
begin
  for i in 1..n loop
    cur := public.cka_next_work_day(cur::date) + cur::time;
  end loop;
  return cur;
end $$;

-- Deadlines for a submission, as real timestamps.
--   critical : acknowledge in 1 hour (any hour of the day); investigation opened by closing time
--              of the first working day on or after submission.
--   urgent   : acknowledge in 2 working hours; resolve in 1 business day (our reading of "24 hours").
--   can_wait : acknowledge in 1 business day; resolve in 3 business days.
create function public.cka_deadlines(p_urgency text, p_from timestamptz,
                                     out acknowledge_by timestamptz, out resolve_by timestamptz)
language plpgsql immutable as $$
declare local_t timestamp := p_from at time zone 'Africa/Cairo';
begin
  if p_urgency = 'critical' then
    acknowledge_by := p_from + interval '1 hour';
    resolve_by := (public.cka_working_start(local_t)::date + time '18:00') at time zone 'Africa/Cairo';
  elsif p_urgency = 'urgent' then
    acknowledge_by := public.cka_add_working_hours(local_t, 2) at time zone 'Africa/Cairo';
    resolve_by := public.cka_add_business_days(local_t, 1) at time zone 'Africa/Cairo';
  elsif p_urgency = 'can_wait' then
    acknowledge_by := public.cka_add_business_days(local_t, 1) at time zone 'Africa/Cairo';
    resolve_by := public.cka_add_business_days(local_t, 3) at time zone 'Africa/Cairo';
  else
    raise exception 'unknown urgency %', p_urgency;
  end if;
end $$;
