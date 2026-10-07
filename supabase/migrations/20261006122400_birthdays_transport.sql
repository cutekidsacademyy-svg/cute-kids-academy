-- Birthdays and transport (Prompt 21).
--
-- Birthdays: a list by month; an automatic message to both parents at 8:00 am on the birthday (editable in English and Arabic,
-- on/off switch, "send now"); and the data for a public birthday wall that shows first name, initial and age only for
-- children whose parents agreed (the consent is part of registration and can be withdrawn at any time).
-- Transport: routes with driver, the staff member riding the bus, stops and times, and the children on each route; morning and
-- afternoon status per child; "bus 10 minutes away" and "dropped off" notifications; a monthly transport fee as a charge.

-- ---------------------------------------------------------------------------
-- Birthdays
-- ---------------------------------------------------------------------------
create table public.birthday_settings (
  id           boolean primary key default true check (id),
  enabled      boolean not null default true,
  template_en  text not null default 'Happy birthday, {child}! Everyone at Cute Kids Academy wishes {child} a wonderful day full of joy.' check (length(template_en) between 5 and 600),
  template_ar  text not null default 'عيد ميلاد سعيد يا {child}! يتمنى لك كل من في كيوت كيدز أكاديمي يوماً رائعاً مليئاً بالفرح.' check (length(template_ar) between 5 and 600),
  updated_by   uuid references public.profiles (id)
);
insert into public.birthday_settings (id) values (true);

create table public.birthday_sent (
  child_id  uuid not null references public.children (id),
  year      integer not null,
  sent_at   timestamptz not null default now(),
  kind      text not null check (kind in ('auto', 'manual')),
  primary key (child_id, year)
);
alter table public.birthday_settings enable row level security;
alter table public.birthday_sent     enable row level security;
revoke all on public.birthday_settings, public.birthday_sent from anon, authenticated;
grant select on public.birthday_settings, public.birthday_sent to authenticated;
create policy bday_settings_select on public.birthday_settings for select using (public.is_management());
create policy bday_sent_select     on public.birthday_sent     for select using (public.is_management());

create function public.birthday_settings_save(p_enabled boolean, p_en text, p_ar text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_en, ''))) < 5 or length(btrim(coalesce(p_ar, ''))) < 5 then raise exception 'Please write the message in both languages'; end if;
  update public.birthday_settings set enabled = coalesce(p_enabled, true), template_en = btrim(p_en), template_ar = btrim(p_ar), updated_by = auth.uid();
end $$;

-- Every active child with their birthday, for the list by month (management only).
create function public.birthdays_list()
returns table (child_id uuid, child_name text, class_name text, date_of_birth date, month int, day int, turning int, sent_this_year boolean, on_wall boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, coalesce(cl.name, ''), c.date_of_birth, extract(month from c.date_of_birth)::int, extract(day from c.date_of_birth)::int,
         (extract(year from public.cka_today()) - extract(year from c.date_of_birth))::int,
         exists (select 1 from public.birthday_sent b where b.child_id = c.id and b.year = extract(year from public.cka_today())::int),
         coalesce((select k.birthday_wall from public.child_consents k where k.child_id = c.id), false)
    from public.children c left join public.classes cl on cl.id = c.class_id
   where public.is_management() and c.active
   order by extract(month from c.date_of_birth), extract(day from c.date_of_birth), c.full_name
$$;

-- The message to both parents (portal + an email saying there is one). Used by the 8:00 am routine and "send now".
create function public.cka_birthday_send(p_child uuid, p_kind text) returns int
language plpgsql security definer set search_path = public as $$
declare c public.children; st public.birthday_settings; par record; n int := 0; first_name text; body text; yr int := extract(year from public.cka_today())::int;
begin
  select * into c from public.children where id = p_child and active;
  if c.id is null then return 0; end if;
  select * into st from public.birthday_settings;
  first_name := split_part(btrim(c.full_name), ' ', 1);
  for par in select pc.parent_id, p.language from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
    body := replace(case when par.language = 'ar' then st.template_ar else st.template_en end, '{child}', first_name);
    insert into public.parent_messages (parent_id, child_id, kind, body, sent_by) values (par.parent_id, p_child, 'birthday', left(body, 2000), auth.uid());
    perform public.cka_enqueue_email(par.parent_id, 'birthday_message', '{}'::jsonb, 'bday:' || p_child || ':' || yr || ':' || par.parent_id || case when p_kind = 'manual' then ':' || extract(epoch from public.cka_now())::bigint else '' end);
    n := n + 1;
  end loop;
  insert into public.birthday_sent (child_id, year, kind) values (p_child, yr, p_kind) on conflict (child_id, year) do update set sent_at = now(), kind = excluded.kind;
  return n;
end $$;

create function public.birthday_send_now(p_child uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  return public.cka_birthday_send(p_child, 'manual');
end $$;

-- 8:00 am on the day (server only). A 29 February birthday is celebrated on 28 February in other years.
create function public.cka_run_birthdays(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; today date := l::date; k record; sent int := 0; kids int := 0; st public.birthday_settings;
begin
  select * into st from public.birthday_settings;
  if not st.enabled or l::time < time '08:00' then return jsonb_build_object('checked', false, 'children', 0, 'messages', 0); end if;
  for k in select c.id from public.children c
            where c.active and (
                  (extract(month from c.date_of_birth) = extract(month from today) and extract(day from c.date_of_birth) = extract(day from today))
               or (extract(month from c.date_of_birth) = 2 and extract(day from c.date_of_birth) = 29 and extract(month from today) = 2 and extract(day from today) = 28
                   and (extract(year from today)::int % 4 <> 0 or (extract(year from today)::int % 100 = 0 and extract(year from today)::int % 400 <> 0))))
              and not exists (select 1 from public.birthday_sent b where b.child_id = c.id and b.year = extract(year from today)::int) loop
    sent := sent + public.cka_birthday_send(k.id, 'auto'); kids := kids + 1;
  end loop;
  return jsonb_build_object('checked', true, 'children', kids, 'messages', sent);
end $$;

-- The public birthday wall (served by a small public page through the server key): first name, initial and age, this month, only with consent.
create function public.birthday_wall() returns table (first_name text, initial text, day int, turning int, is_today boolean)
language sql stable security definer set search_path = public as $$
  select split_part(btrim(c.full_name), ' ', 1),
         case when position(' ' in btrim(c.full_name)) > 0 then upper(left((regexp_split_to_array(btrim(c.full_name), '\s+'))[array_length(regexp_split_to_array(btrim(c.full_name), '\s+'), 1)], 1)) else '' end,
         extract(day from c.date_of_birth)::int,
         (extract(year from public.cka_today()) - extract(year from c.date_of_birth))::int,
         extract(day from c.date_of_birth) = extract(day from public.cka_today())
    from public.children c join public.child_consents k on k.child_id = c.id and k.birthday_wall
   where c.active and extract(month from c.date_of_birth) = extract(month from public.cka_today())
   order by extract(day from c.date_of_birth), 1
$$;

-- ---------------------------------------------------------------------------
-- Transport
-- ---------------------------------------------------------------------------
create table public.bus_routes (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 2 and 80),
  driver_name   text check (length(driver_name) <= 80),
  driver_phone  text check (length(driver_phone) <= 40),
  rider_id      uuid references public.profiles (id),                -- the staff member who rides the bus
  rider_name    text check (length(rider_name) <= 80),
  monthly_fee   numeric(10, 2) not null default 0 check (monthly_fee >= 0),
  active        boolean not null default true
);
create table public.route_stops (
  id              uuid primary key default gen_random_uuid(),
  route_id        uuid not null references public.bus_routes (id) on delete cascade,
  position        integer not null check (position between 1 and 40),
  name            text not null check (length(btrim(name)) between 1 and 100),
  morning_time    time,
  afternoon_time  time,
  unique (route_id, position)
);
create table public.route_children (
  child_id  uuid primary key references public.children (id),
  route_id  uuid not null references public.bus_routes (id) on delete cascade,
  stop_id   uuid references public.route_stops (id) on delete set null
);
create table public.transport_status (
  child_id     uuid not null references public.children (id),
  status_date  date not null,
  session      text not null check (session in ('morning', 'afternoon')),
  status       text not null check (status in ('on_board', 'absent', 'dropped_off')),
  updated_by   uuid references public.profiles (id),
  updated_at   timestamptz not null default now(),
  primary key (child_id, status_date, session)
);

-- The staff who may run a route: management, and the person riding that bus.
create function public.cka_route_staff(p_route uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_management() or exists (select 1 from public.bus_routes r where r.id = p_route and r.rider_id = auth.uid() and public.auth_role() in ('teacher', 'admin')), false)
$$;

alter table public.bus_routes       enable row level security;
alter table public.route_stops      enable row level security;
alter table public.route_children   enable row level security;
alter table public.transport_status enable row level security;
revoke all on public.bus_routes, public.route_stops, public.route_children, public.transport_status from anon, authenticated;
grant select on public.bus_routes, public.route_stops, public.route_children, public.transport_status to authenticated;
create policy routes_select  on public.bus_routes       for select using (public.cka_route_staff(id));
create policy stops_select   on public.route_stops      for select using (public.cka_route_staff(route_id));
create policy rchild_select  on public.route_children   for select using (public.cka_route_staff(route_id));
create policy tstatus_select on public.transport_status  for select using (public.is_management() or public.cka_route_staff((select route_id from public.route_children rc where rc.child_id = transport_status.child_id))
                                                                         or (public.auth_role() = 'parent' and public.can_see_child(child_id)));

create function public.route_save(p_id uuid, p_name text, p_driver text, p_driver_phone text, p_rider uuid, p_rider_name text, p_fee numeric, p_active boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or coalesce(p_fee, 0) < 0 then raise exception 'Please check the route'; end if;
  if p_rider is not null and not exists (select 1 from public.profiles where id = p_rider and active and role in ('teacher', 'admin')) then raise exception 'The rider must be a teacher or admin account'; end if;
  if rid is null then
    insert into public.bus_routes (name, driver_name, driver_phone, rider_id, rider_name, monthly_fee, active) values (btrim(p_name), nullif(btrim(coalesce(p_driver, '')), ''), nullif(btrim(coalesce(p_driver_phone, '')), ''), p_rider, nullif(btrim(coalesce(p_rider_name, '')), ''), coalesce(p_fee, 0), coalesce(p_active, true)) returning id into rid;
  else
    update public.bus_routes set name = btrim(p_name), driver_name = nullif(btrim(coalesce(p_driver, '')), ''), driver_phone = nullif(btrim(coalesce(p_driver_phone, '')), ''), rider_id = p_rider, rider_name = nullif(btrim(coalesce(p_rider_name, '')), ''),
           monthly_fee = coalesce(p_fee, 0), active = coalesce(p_active, true) where id = rid;
    if not found then raise exception 'Not found'; end if;
  end if;
  return rid;
end $$;

create function public.stop_save(p_id uuid, p_route uuid, p_position int, p_name text, p_morning time, p_afternoon time) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := p_id;
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.bus_routes where id = p_route) then raise exception 'Not found'; end if;
  if rid is null then
    insert into public.route_stops (route_id, position, name, morning_time, afternoon_time) values (p_route, p_position, btrim(p_name), p_morning, p_afternoon) returning id into rid;
  else
    update public.route_stops set position = p_position, name = btrim(p_name), morning_time = p_morning, afternoon_time = p_afternoon where id = rid and route_id = p_route;
    if not found then raise exception 'Not found'; end if;
  end if;
  return rid;
end $$;

create function public.stop_delete(p_stop uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.route_stops where id = p_stop;
end $$;

create function public.route_child_set(p_route uuid, p_child uuid, p_stop uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.children where id = p_child and active) or not exists (select 1 from public.bus_routes where id = p_route) then raise exception 'Not found'; end if;
  if p_stop is not null and not exists (select 1 from public.route_stops where id = p_stop and route_id = p_route) then raise exception 'That stop is not on this route'; end if;
  insert into public.route_children (child_id, route_id, stop_id) values (p_child, p_route, p_stop) on conflict (child_id) do update set route_id = excluded.route_id, stop_id = excluded.stop_id;
end $$;

create function public.route_child_remove(p_child uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_management() then raise exception 'Not allowed'; end if;
  delete from public.route_children where child_id = p_child;
end $$;

-- The bus run: every stop with its children and today's status, for one session.
create function public.transport_run(p_route uuid, p_session text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.cka_route_staff(p_route) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') then raise exception 'Invalid request'; end if;
  select jsonb_build_object('route', jsonb_build_object('id', r.id, 'name', r.name, 'driver_name', r.driver_name, 'driver_phone', r.driver_phone, 'rider_name', coalesce(rp.full_name, r.rider_name)),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'name', s.name, 'time', case when p_session = 'morning' then s.morning_time else s.afternoon_time end,
        'children', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'name', c.full_name, 'status', ts.status) order by c.full_name)
                                from public.route_children rc join public.children c on c.id = rc.child_id and c.active
                                left join public.transport_status ts on ts.child_id = c.id and ts.status_date = public.cka_today() and ts.session = p_session
                               where rc.stop_id = s.id), '[]')) order by s.position) from public.route_stops s where s.route_id = r.id), '[]'),
    'unassigned', coalesce((select jsonb_agg(jsonb_build_object('child_id', c.id, 'name', c.full_name, 'status', ts.status) order by c.full_name)
                              from public.route_children rc join public.children c on c.id = rc.child_id and c.active
                              left join public.transport_status ts on ts.child_id = c.id and ts.status_date = public.cka_today() and ts.session = p_session
                             where rc.route_id = r.id and rc.stop_id is null), '[]')) into out
    from public.bus_routes r left join public.profiles rp on rp.id = r.rider_id where r.id = p_route;
  return out;
end $$;

create function public.transport_set_status(p_child uuid, p_session text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare rt uuid; s uuid;
begin
  select route_id into rt from public.route_children where child_id = p_child;
  if rt is null or not public.cka_route_staff(rt) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') or p_status not in ('on_board', 'absent', 'dropped_off') then raise exception 'Invalid request'; end if;
  insert into public.transport_status (child_id, status_date, session, status, updated_by) values (p_child, public.cka_today(), p_session, p_status, auth.uid())
  on conflict (child_id, status_date, session) do update set status = excluded.status, updated_by = excluded.updated_by, updated_at = now();
  if p_status = 'dropped_off' then
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
      perform public.cka_enqueue_email(s, 'bus_dropped_off', '{}'::jsonb, 'busdrop:' || p_child || ':' || public.cka_today() || ':' || p_session || ':' || s);
    end loop;
  end if;
end $$;

-- "The bus is 10 minutes away" for one stop: tells the parents of the children there who have not been dropped off or marked absent.
create function public.transport_near(p_route uuid, p_session text, p_stop uuid) returns int
language plpgsql security definer set search_path = public as $$
declare k record; s uuid; n int := 0;
begin
  if not public.cka_route_staff(p_route) then raise exception 'Not allowed'; end if;
  if p_session not in ('morning', 'afternoon') or not exists (select 1 from public.route_stops where id = p_stop and route_id = p_route) then raise exception 'Invalid request'; end if;
  for k in select rc.child_id from public.route_children rc join public.children c on c.id = rc.child_id and c.active
            where rc.route_id = p_route and rc.stop_id = p_stop
              and not exists (select 1 from public.transport_status ts where ts.child_id = rc.child_id and ts.status_date = public.cka_today() and ts.session = p_session and ts.status in ('absent', 'dropped_off')) loop
    for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = k.child_id loop
      perform public.cka_enqueue_email(s, 'bus_near', '{}'::jsonb, 'busnear:' || p_stop || ':' || public.cka_today() || ':' || p_session || ':' || s);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- What a parent sees for each of their children: the route, driver, stop and times, and today's status.
create function public.parent_transport() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if public.auth_role() <> 'parent' then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('child_id', c.id, 'child_name', c.full_name, 'route', r.name, 'driver_name', r.driver_name, 'driver_phone', r.driver_phone,
         'stop', s.name, 'morning_time', s.morning_time, 'afternoon_time', s.afternoon_time,
         'morning_status', (select status from public.transport_status t where t.child_id = c.id and t.status_date = public.cka_today() and t.session = 'morning'),
         'afternoon_status', (select status from public.transport_status t where t.child_id = c.id and t.status_date = public.cka_today() and t.session = 'afternoon')) order by c.full_name), '[]') into out
    from public.parent_children pc join public.children c on c.id = pc.child_id and c.active
    join public.route_children rc on rc.child_id = c.id join public.bus_routes r on r.id = rc.route_id and r.active left join public.route_stops s on s.id = rc.stop_id
   where pc.parent_id = auth.uid();
  return out;
end $$;

-- The transport fee, once a month, as a charge in Payments (server only).
create function public.cka_run_transport_billing(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare cur date := date_trunc('month', p_now at time zone 'Africa/Cairo')::date; n int;
begin
  insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
  select rc.child_id, cur, 'transport', 'Transport: ' || r.name, r.monthly_fee, 'transport:' || rc.child_id || ':' || to_char(cur, 'YYYY-MM'), p_now
    from public.route_children rc join public.bus_routes r on r.id = rc.route_id and r.active and r.monthly_fee > 0 join public.children c on c.id = rc.child_id and c.active
  on conflict (source_ref) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.birthday_settings_save(boolean, text, text), public.birthdays_list(), public.cka_birthday_send(uuid, text), public.birthday_send_now(uuid), public.cka_run_birthdays(timestamptz), public.birthday_wall(),
  public.cka_route_staff(uuid), public.route_save(uuid, text, text, text, uuid, text, numeric, boolean), public.stop_save(uuid, uuid, int, text, time, time), public.stop_delete(uuid),
  public.route_child_set(uuid, uuid, uuid), public.route_child_remove(uuid), public.transport_run(uuid, text), public.transport_set_status(uuid, text, text), public.transport_near(uuid, text, uuid),
  public.parent_transport(), public.cka_run_transport_billing(timestamptz)
from public, anon, authenticated;
grant execute on function
  public.birthday_settings_save(boolean, text, text), public.birthdays_list(), public.birthday_send_now(uuid), public.cka_route_staff(uuid), public.route_save(uuid, text, text, text, uuid, text, numeric, boolean),
  public.stop_save(uuid, uuid, int, text, time, time), public.stop_delete(uuid), public.route_child_set(uuid, uuid, uuid), public.route_child_remove(uuid), public.transport_run(uuid, text),
  public.transport_set_status(uuid, text, text), public.transport_near(uuid, text, uuid), public.parent_transport()
to authenticated;
grant execute on function public.cka_run_birthdays(timestamptz), public.cka_run_transport_billing(timestamptz), public.birthday_wall() to service_role;
