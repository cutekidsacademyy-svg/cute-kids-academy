-- Payments: fee plans, monthly charges, InstaPay payments confirmed by finance, late fees, receipts (Prompt 20).
--
-- Who sees money: the family (their own children only), the finance role, and the owner. Never teachers, never other families.
-- (Admin and manager can read the settings, such as the InstaPay address, to help a parent, but see no amounts.)
-- InstaPay does not tell the system when someone has paid. The parent enters the transaction reference (and may attach a
-- screenshot); finance matches it against the bank statement and confirms or rejects it. A confirmed payment gets a numbered receipt.
-- Late fees are OFF until the owner switches them on (after the fee policy states the amount and grace period).

create table public.payment_settings (
  id              boolean primary key default true check (id),
  due_day         integer not null default 1 check (due_day between 1 and 28),
  grace_days      integer not null default 5 check (grace_days between 0 and 28),
  late_fees_on    boolean not null default false,
  late_fee_kind   text not null default 'fixed' check (late_fee_kind in ('fixed', 'percent')),
  late_fee_value  numeric(10, 2) not null default 0 check (late_fee_value >= 0),
  reminder_days   integer[] not null default '{25,1,5}',
  overtime_rate   numeric(10, 2) not null default 0 check (overtime_rate >= 0),     -- EGP for each started 15 minutes
  instapay_ipa    text check (length(instapay_ipa) <= 100),
  instapay_link   text check (instapay_link ~ '^https://' and length(instapay_link) <= 500),
  bank_details    text check (length(bank_details) <= 600),
  updated_by      uuid references public.profiles (id)
);
insert into public.payment_settings (id) values (true);

create table public.fee_plans (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  programme       text not null check (programme in ('nursery', 'preschool', 'after_school', 'camp')),
  monthly_amount  numeric(10, 2) not null check (monthly_amount >= 0),
  starts_on       date not null,
  ends_on         date,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index fee_plans_child_idx on public.fee_plans (child_id, starts_on desc);

create table public.charges (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  month           date not null check (month = date_trunc('month', month)::date),
  kind            text not null check (kind in ('tuition', 'overtime', 'event', 'transport', 'late_fee', 'other')),
  description     text not null check (length(btrim(description)) between 2 and 200),
  amount          numeric(10, 2) not null check (amount > 0),
  source_ref      text unique,
  removed         boolean not null default false,
  waived          boolean not null default false,
  waived_by       uuid references public.profiles (id),
  waived_reason   text,
  waived_at       timestamptz,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index charges_child_month_idx on public.charges (child_id, month);

create sequence public.payment_receipt_seq;
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  child_id        uuid not null references public.children (id),
  month           date not null check (month = date_trunc('month', month)::date),
  amount          numeric(10, 2) not null check (amount > 0),
  method          text not null check (method in ('instapay', 'cash', 'bank_transfer')),
  reference       text check (length(btrim(reference)) between 4 and 60),
  screenshot_path text,
  status          text not null default 'waiting' check (status in ('waiting', 'confirmed', 'rejected')),
  submitted_by    uuid references public.profiles (id),
  submitted_at    timestamptz not null default now(),
  decided_by      uuid references public.profiles (id),
  decided_at      timestamptz,
  reject_reason   text,
  receipt_no      bigint unique
);
create unique index payments_reference_uq on public.payments (lower(btrim(reference))) where status <> 'rejected' and reference is not null;
create index payments_child_month_idx on public.payments (child_id, month);

create table public.payment_log (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid references public.children (id),
  action      text not null,
  note        text,
  actor_id    uuid references public.profiles (id),
  actor_name  text,
  created_at  timestamptz not null default now()
);

-- Who may see a child's money: the finance role, the owner, and that child's own parents.
create function public.cka_pay_access(p_child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() in ('finance', 'owner') or (public.auth_role() = 'parent' and public.can_see_child(p_child)), false)
$$;
create function public.cka_pay_staff() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.auth_role() in ('finance', 'owner'), false) $$;

alter table public.payment_settings enable row level security;
alter table public.fee_plans        enable row level security;
alter table public.charges          enable row level security;
alter table public.payments         enable row level security;
alter table public.payment_log      enable row level security;
revoke all on public.payment_settings, public.fee_plans, public.charges, public.payments, public.payment_log from anon, authenticated;
grant select on public.payment_settings, public.fee_plans, public.charges, public.payments, public.payment_log to authenticated;
create policy pay_settings_select on public.payment_settings for select using (public.auth_role() in ('parent', 'finance', 'owner', 'admin', 'manager'));
create policy fee_plans_select    on public.fee_plans        for select using (public.cka_pay_access(child_id));
create policy charges_select      on public.charges          for select using (public.cka_pay_access(child_id) and not removed);
create policy payments_select     on public.payments         for select using (public.cka_pay_access(child_id));
create policy pay_log_select      on public.payment_log      for select using (public.cka_pay_staff());

-- Screenshots of transfers: private; the family can add to their own child's folder; finance, owner and the family can read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('payments', 'payments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
create function public.cka_pay_file_ok(p_path text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case when (storage.foldername(p_path))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (case when p_write then coalesce(public.auth_role() = 'parent' and public.can_see_child(((storage.foldername(p_path))[1])::uuid), false)
                         else public.cka_pay_access(((storage.foldername(p_path))[1])::uuid) end) else false end
$$;
create policy pay_file_read   on storage.objects for select to authenticated using (bucket_id = 'payments' and public.cka_pay_file_ok(name, false));
create policy pay_file_upload on storage.objects for insert to authenticated with check (bucket_id = 'payments' and public.cka_pay_file_ok(name, true));

create function public.cka_pay_log(p_child uuid, p_action text, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into public.payment_log (child_id, action, note, actor_id, actor_name) values (p_child, p_action, p_note, auth.uid(), public.cka_actor_name())
$$;

-- ---------------------------------------------------------------------------
-- Settings and fee plans
-- ---------------------------------------------------------------------------
create function public.payment_settings_save(p_due_day int, p_grace int, p_late_on boolean, p_late_kind text, p_late_value numeric, p_reminder_days int[], p_overtime_rate numeric,
                                             p_ipa text, p_link text, p_bank text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'owner' then raise exception 'Only the owner can change the payment settings'; end if;
  if p_due_day not between 1 and 28 or p_grace not between 0 and 28 or p_late_kind not in ('fixed', 'percent') or coalesce(p_late_value, 0) < 0 or coalesce(p_overtime_rate, 0) < 0 then raise exception 'Please check the numbers'; end if;
  if p_late_kind = 'percent' and p_late_value > 100 then raise exception 'A percentage cannot be more than 100'; end if;
  if p_reminder_days is null or exists (select 1 from unnest(p_reminder_days) d where d not between 1 and 28) or cardinality(p_reminder_days) > 6 then raise exception 'Reminder days must be days of the month (1 to 28)'; end if;
  if nullif(btrim(coalesce(p_link, '')), '') is not null and p_link !~ '^https://' then raise exception 'The payment link must start with https://'; end if;
  update public.payment_settings set due_day = p_due_day, grace_days = p_grace, late_fees_on = coalesce(p_late_on, false), late_fee_kind = p_late_kind, late_fee_value = coalesce(p_late_value, 0),
         reminder_days = p_reminder_days, overtime_rate = coalesce(p_overtime_rate, 0), instapay_ipa = nullif(btrim(coalesce(p_ipa, '')), ''), instapay_link = nullif(btrim(coalesce(p_link, '')), ''),
         bank_details = nullif(btrim(coalesce(p_bank, '')), ''), updated_by = auth.uid();
  perform public.cka_pay_log(null, 'settings_changed', null);
end $$;

create function public.fee_plan_save(p_child uuid, p_programme text, p_amount numeric, p_starts date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_programme not in ('nursery', 'preschool', 'after_school', 'camp') or p_amount is null or p_amount < 0 or p_starts is null then raise exception 'Please check the plan'; end if;
  if not exists (select 1 from public.children where id = p_child and active) then raise exception 'Not found'; end if;
  update public.fee_plans set ends_on = p_starts - 1 where child_id = p_child and ends_on is null and starts_on < p_starts;
  delete from public.fee_plans where child_id = p_child and starts_on = p_starts;
  insert into public.fee_plans (child_id, programme, monthly_amount, starts_on, created_by) values (p_child, p_programme, p_amount, p_starts, auth.uid());
  perform public.cka_pay_log(p_child, 'fee_plan', p_programme || ' ' || p_amount || ' from ' || p_starts);
end $$;

-- ---------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------
create function public.charge_add(p_child uuid, p_month date, p_kind text, p_description text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_kind not in ('tuition', 'transport', 'event', 'other') then raise exception 'Choose the kind of charge'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 or length(btrim(coalesce(p_description, ''))) < 2 or p_month is null then raise exception 'Please check the charge'; end if;
  if not exists (select 1 from public.children where id = p_child) then raise exception 'Not found'; end if;
  insert into public.charges (child_id, month, kind, description, amount, created_by) values (p_child, date_trunc('month', p_month)::date, p_kind, btrim(p_description), p_amount, auth.uid()) returning id into rid;
  perform public.cka_pay_log(p_child, 'charge_added', p_kind || ' ' || p_amount);
  return rid;
end $$;

create function public.charge_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.charges;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  select * into c from public.charges where id = p_id and not removed;
  if c.id is null then raise exception 'Not found'; end if;
  if c.kind = 'late_fee' then raise exception 'A late fee can only be waived by the owner'; end if;
  update public.charges set removed = true where id = p_id;
  perform public.cka_pay_log(c.child_id, 'charge_removed', c.kind || ' ' || c.amount);
end $$;

create function public.late_fee_waive(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.charges;
begin
  if public.auth_role() <> 'owner' then raise exception 'Only the owner can waive a late fee'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write the reason'; end if;
  select * into c from public.charges where id = p_id and kind = 'late_fee' and not removed and not waived;
  if c.id is null then raise exception 'Not found'; end if;
  update public.charges set waived = true, waived_by = auth.uid(), waived_reason = btrim(p_reason), waived_at = now() where id = p_id;
  perform public.cka_pay_log(c.child_id, 'late_fee_waived', btrim(p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Balances (the parent sees their own children's; finance and the owner see everyone's)
-- ---------------------------------------------------------------------------
create function public.cka_balances(p_child uuid default null)
returns table (child_id uuid, month date, charges numeric, paid numeric, waiting numeric, balance numeric, due_date date, grace_end date, overdue boolean)
language sql stable security definer set search_path = public as $$
  with m as (
    select c.child_id, c.month from public.charges c where not c.removed
    union select p.child_id, p.month from public.payments p
  ), s as (select due_day, grace_days from public.payment_settings)
  select m.child_id, m.month,
         coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0),
         coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0),
         coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'waiting'), 0),
         coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0)
           - coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0),
         (m.month + (s.due_day - 1))::date, (m.month + (s.due_day - 1) + s.grace_days)::date,
         (public.cka_today() > (m.month + (s.due_day - 1) + s.grace_days)::date
            and coalesce((select sum(c.amount) from public.charges c where c.child_id = m.child_id and c.month = m.month and not c.removed and not c.waived), 0)
              - coalesce((select sum(p.amount) from public.payments p where p.child_id = m.child_id and p.month = m.month and p.status = 'confirmed'), 0) > 0)
    from m cross join s
   where (p_child is null or m.child_id = p_child)
   order by m.month desc
$$;

create function public.payment_balances(p_child uuid default null)
returns table (child_id uuid, month date, charges numeric, paid numeric, waiting numeric, balance numeric, due_date date, grace_end date, overdue boolean)
language sql stable security definer set search_path = public as $$
  select * from public.cka_balances(p_child) b where public.cka_pay_access(b.child_id)
$$;

-- Finance and the owner: every family for one month.
create function public.payments_month(p_month date)
returns table (child_id uuid, child_name text, class_name text, parents text, programme text, charges numeric, paid numeric, waiting numeric, balance numeric, status text)
language sql stable security definer set search_path = public as $$
  with mm as (select date_trunc('month', coalesce(p_month, public.cka_today()))::date as m)
  select c.id, c.full_name, coalesce(cl.name, ''),
         coalesce((select string_agg(p.full_name, ', ' order by p.full_name) from public.parent_children pc join public.profiles p on p.id = pc.parent_id where pc.child_id = c.id), ''),
         (select fp.programme from public.fee_plans fp where fp.child_id = c.id and fp.starts_on <= (select m from mm) and (fp.ends_on is null or fp.ends_on >= (select m from mm)) order by fp.starts_on desc limit 1),
         b.charges, b.paid, b.waiting, b.balance,
         case when b.charges = 0 and b.paid = 0 and b.waiting = 0 then 'none' when b.balance <= 0 then 'paid' when b.waiting >= b.balance then 'waiting'
              when public.cka_today() > (select m from mm) + (s.due_day - 1) + s.grace_days then 'overdue' else 'due' end
    from public.children c
    left join public.classes cl on cl.id = c.class_id
    cross join public.payment_settings s
    left join lateral (select coalesce(x.charges, 0) as charges, coalesce(x.paid, 0) as paid, coalesce(x.waiting, 0) as waiting, coalesce(x.balance, 0) as balance
                         from (select 1) d left join (select * from public.payment_balances(c.id) pb where pb.month = (select m from mm)) x on true) b on true
   where public.cka_pay_staff() and c.active
   order by c.full_name
$$;

create function public.payments_list(p_month date)
returns table (id uuid, child_id uuid, child_name text, month date, amount numeric, method text, reference text, screenshot_path text, status text, submitted_by_name text, submitted_at timestamptz, decided_at timestamptz, reject_reason text, receipt_no bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.child_id, c.full_name, p.month, p.amount, p.method, p.reference, p.screenshot_path, p.status, sb.full_name, p.submitted_at, p.decided_at, p.reject_reason, p.receipt_no
    from public.payments p join public.children c on c.id = p.child_id left join public.profiles sb on sb.id = p.submitted_by
   where public.cka_pay_staff() and (p_month is null or p.month = date_trunc('month', p_month)::date)
   order by (p.status = 'waiting') desc, p.submitted_at desc
$$;

-- ---------------------------------------------------------------------------
-- Paying
-- ---------------------------------------------------------------------------
create function public.payment_submit(p_child uuid, p_month date, p_amount numeric, p_reference text, p_screenshot text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid; ref text := btrim(coalesce(p_reference, '')); mo date := date_trunc('month', p_month)::date; f uuid;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Please check the amount'; end if;
  if length(ref) < 4 or length(ref) > 60 then raise exception 'Please enter the transaction reference from your bank app'; end if;
  if mo < date_trunc('month', public.cka_today())::date - interval '12 months' or mo > date_trunc('month', public.cka_today())::date + interval '1 month' then raise exception 'Please choose a recent month'; end if;
  if p_screenshot is not null and (p_screenshot not like p_child::text || '/%' or p_screenshot like '%..%') then raise exception 'Invalid file'; end if;
  if (select count(*) from public.payments where child_id = p_child and status = 'waiting') >= 5 then raise exception 'You already have payments waiting for confirmation'; end if;
  if exists (select 1 from public.payments where lower(btrim(reference)) = lower(ref) and status <> 'rejected') then raise exception 'reference_used'; end if;
  insert into public.payments (child_id, month, amount, method, reference, screenshot_path, submitted_by) values (p_child, mo, p_amount, 'instapay', ref, nullif(p_screenshot, ''), auth.uid()) returning id into rid;
  for f in select id from public.profiles where role in ('finance', 'owner') and active loop
    perform public.cka_enqueue_email(f, 'payment_waiting', '{}'::jsonb, 'paywait:' || rid || ':' || f);
  end loop;
  return rid;
end $$;

create function public.cka_pay_notify_parents(p_child uuid, p_template text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  for s in select pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active where pc.child_id = p_child loop
    perform public.cka_enqueue_email(s, p_template, '{}'::jsonb, p_key || ':' || s);
  end loop;
end $$;

create function public.payment_confirm(p_id uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare p public.payments; n bigint;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  select * into p from public.payments where id = p_id for update;
  if p.id is null then raise exception 'Not found'; end if;
  if p.status <> 'waiting' then raise exception 'This payment has already been decided'; end if;
  n := nextval('public.payment_receipt_seq');
  update public.payments set status = 'confirmed', decided_by = auth.uid(), decided_at = now(), receipt_no = n where id = p_id;
  perform public.cka_pay_log(p.child_id, 'payment_confirmed', 'receipt ' || n || ' ' || p.amount);
  perform public.cka_pay_notify_parents(p.child_id, 'payment_confirmed', 'payok:' || p_id);
  return n;
end $$;

create function public.payment_reject(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.payments;
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write the reason'; end if;
  select * into p from public.payments where id = p_id for update;
  if p.id is null then raise exception 'Not found'; end if;
  if p.status <> 'waiting' then raise exception 'This payment has already been decided'; end if;
  update public.payments set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reject_reason = btrim(p_reason) where id = p_id;
  perform public.cka_pay_log(p.child_id, 'payment_rejected', btrim(p_reason));
  perform public.cka_pay_notify_parents(p.child_id, 'payment_rejected', 'payno:' || p_id);
end $$;

-- Cash or a bank transfer received at the office: recorded and confirmed at once.
create function public.payment_record(p_child uuid, p_month date, p_amount numeric, p_method text, p_reference text) returns bigint
language plpgsql security definer set search_path = public as $$
declare rid uuid; n bigint; ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if not public.cka_pay_staff() then raise exception 'Not allowed'; end if;
  if p_method not in ('cash', 'bank_transfer') or p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_month is null then raise exception 'Please check the payment'; end if;
  if ref is not null and length(ref) < 4 then raise exception 'The reference is too short'; end if;
  if not exists (select 1 from public.children where id = p_child) then raise exception 'Not found'; end if;
  n := nextval('public.payment_receipt_seq');
  insert into public.payments (child_id, month, amount, method, reference, status, submitted_by, decided_by, decided_at, receipt_no)
  values (p_child, date_trunc('month', p_month)::date, p_amount, p_method, ref, 'confirmed', auth.uid(), auth.uid(), now(), n) returning id into rid;
  perform public.cka_pay_log(p_child, 'payment_recorded', p_method || ' ' || p_amount || ' receipt ' || n);
  perform public.cka_pay_notify_parents(p_child, 'payment_confirmed', 'payok:' || rid);
  return n;
end $$;

create function public.payment_receipt(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  select jsonb_build_object('receipt_no', p.receipt_no, 'child_name', c.full_name, 'month', p.month, 'amount', p.amount, 'method', p.method, 'reference', p.reference, 'confirmed_at', p.decided_at,
         'parents', coalesce((select string_agg(pp.full_name, ', ' order by pp.full_name) from public.parent_children pc join public.profiles pp on pp.id = pc.parent_id where pc.child_id = c.id), ''),
         'academy', (select jsonb_build_object('phone', phone, 'email', email, 'address_en', address_en, 'address_ar', address_ar) from public.academy_settings)) into out
    from public.payments p join public.children c on c.id = p.child_id where p.id = p_id and p.status = 'confirmed' and public.cka_pay_access(p.child_id);
  return out;
end $$;

-- The owner's view: expected against collected, overdue families, and the late fees added and waived.
create function public.payments_owner_summary(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare mo date := date_trunc('month', coalesce(p_month, public.cka_today()))::date; out jsonb;
begin
  if public.auth_role() <> 'owner' then raise exception 'Not allowed'; end if;
  select jsonb_build_object('month', mo,
    'expected', coalesce((select sum(amount) from public.charges where month = mo and not removed and not waived), 0),
    'collected', coalesce((select sum(amount) from public.payments where month = mo and status = 'confirmed'), 0),
    'waiting', coalesce((select sum(amount) from public.payments where month = mo and status = 'waiting'), 0),
    'overdue_families', (select count(*) from public.payments_month(mo) where status = 'overdue'),
    'late_fees_added', coalesce((select sum(amount) from public.charges where month = mo and kind = 'late_fee' and not removed), 0),
    'late_fees_waived', coalesce((select sum(amount) from public.charges where month = mo and kind = 'late_fee' and waived), 0)) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- The monthly routine (server only): tuition, overtime, reminders and late fees
-- ---------------------------------------------------------------------------
create function public.cka_run_billing(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l timestamp := p_now at time zone 'Africa/Cairo'; today date := l::date; cur date := date_trunc('month', l)::date; nxt date := (date_trunc('month', l) + interval '1 month')::date; prev date := (date_trunc('month', l) - interval '1 month')::date;
        s public.payment_settings; k record; mo date; ins int; tuition int := 0; ot int := 0; rem int := 0; lf int := 0; par uuid; amt numeric; minutes int;
begin
  select * into s from public.payment_settings;
  -- 1. tuition: this month, and next month from the 25th on (so families see what is coming)
  foreach mo in array case when extract(day from today) >= 25 then array[cur, nxt] else array[cur] end loop
    insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
    select fp.child_id, mo, 'tuition', 'Tuition', fp.monthly_amount, 'tuition:' || fp.child_id || ':' || to_char(mo, 'YYYY-MM'), p_now
      from public.fee_plans fp join public.children c on c.id = fp.child_id and c.active
     where fp.monthly_amount > 0 and fp.starts_on <= (mo + interval '1 month' - interval '1 day')::date and (fp.ends_on is null or fp.ends_on >= mo)
       and fp.id = (select f2.id from public.fee_plans f2 where f2.child_id = fp.child_id and f2.starts_on <= (mo + interval '1 month' - interval '1 day')::date and (f2.ends_on is null or f2.ends_on >= mo) order by f2.starts_on desc limit 1)
    on conflict (source_ref) do nothing;
    get diagnostics ins = row_count; tuition := tuition + ins;
  end loop;
  -- 2. overtime of last month, billed with this month (each started quarter of an hour at the set rate)
  if s.overtime_rate > 0 then
    for k in select a.child_id, sum(a.overtime_minutes)::int as m from public.attendance a join public.children c on c.id = a.child_id and c.active
              where a.att_date >= prev and a.att_date < cur and a.overtime_minutes > 0 group by a.child_id loop
      amt := ceil(k.m / 15.0) * s.overtime_rate;
      insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
      values (k.child_id, cur, 'overtime', 'Overtime in ' || to_char(prev, 'FMMonth') || ' (' || k.m || ' min)', amt, 'overtime:' || k.child_id || ':' || to_char(prev, 'YYYY-MM'), p_now) on conflict (source_ref) do nothing;
      get diagnostics ins = row_count; ot := ot + ins;
    end loop;
  end if;
  -- 3. reminders on the chosen days of the month, from 9:00: families with something to pay
  if extract(day from today)::int = any (s.reminder_days) and l::time >= time '09:00' then
    for par in select distinct pc.parent_id from public.parent_children pc join public.profiles p on p.id = pc.parent_id and p.active
                where exists (select 1 from public.cka_balances(pc.child_id) b where b.balance > 0 and b.waiting < b.balance)
                   or exists (select 1 from public.charges ch where ch.child_id = pc.child_id and ch.month = nxt and not ch.removed and extract(day from today) >= 25) loop
      perform public.cka_enqueue_email(par, 'payment_reminder', '{}'::jsonb, 'payrem:' || today || ':' || par);
      rem := rem + 1;
    end loop;
  end if;
  -- 4. the day after the grace period: the late fee goes onto unpaid balances (only when the owner has switched late fees on)
  if s.late_fees_on and today > (cur + (s.due_day - 1) + s.grace_days)::date then
    for k in select b.child_id, b.balance, b.waiting from public.cka_balances(null) b where b.month = cur and b.balance > 0 and b.waiting < b.balance loop
      amt := case s.late_fee_kind when 'fixed' then s.late_fee_value else round(k.balance * s.late_fee_value / 100, 2) end;
      continue when amt is null or amt <= 0;
      insert into public.charges (child_id, month, kind, description, amount, source_ref, created_at)
      values (k.child_id, cur, 'late_fee', 'Late fee', amt, 'late:' || k.child_id || ':' || to_char(cur, 'YYYY-MM'), p_now) on conflict (source_ref) do nothing;
      get diagnostics ins = row_count;
      if ins > 0 then lf := lf + 1; perform public.cka_pay_notify_parents(k.child_id, 'late_fee_added', 'latefee:' || k.child_id || ':' || to_char(cur, 'YYYY-MM')); end if;
    end loop;
  end if;
  return jsonb_build_object('tuition', tuition, 'overtime', ot, 'reminders', rem, 'late_fees', lf);
end $$;

-- ---------------------------------------------------------------------------
-- An event with a cost becomes a charge when a parent says yes (and disappears if they change their mind)
-- ---------------------------------------------------------------------------
create or replace function public.event_respond(p_event uuid, p_child uuid, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.events;
begin
  if public.auth_role() <> 'parent' or not public.can_see_child(p_child) then raise exception 'Not allowed'; end if;
  if p_answer not in ('yes', 'no') then raise exception 'Invalid request'; end if;
  select * into e from public.events where id = p_event;
  if e.id is null or not e.needs_approval then raise exception 'Not found'; end if;
  if not exists (select 1 from public.cka_event_children(p_event) k where k.child_id = p_child) then raise exception 'This event is not for your child'; end if;
  if public.cka_now() > e.approval_deadline then raise exception 'deadline_passed'; end if;
  insert into public.event_responses (event_id, child_id, answered_by, answer) values (p_event, p_child, auth.uid(), p_answer)
  on conflict (event_id, child_id) do update set answer = excluded.answer, answered_by = excluded.answered_by, answered_at = now();
  if p_answer = 'yes' and e.cost is not null and e.cost > 0 then
    insert into public.charges (child_id, month, kind, description, amount, source_ref)
    values (p_child, date_trunc('month', e.starts_at at time zone 'Africa/Cairo')::date, 'event', left(coalesce(nullif(btrim(e.title_en), ''), e.title_ar, 'Event'), 190), e.cost, 'event:' || e.id || ':' || p_child)
    on conflict (source_ref) do update set removed = false;
  elsif p_answer = 'no' then
    update public.charges set removed = true where source_ref = 'event:' || e.id || ':' || p_child;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.cka_pay_access(uuid), public.cka_pay_staff(), public.cka_pay_file_ok(text, boolean), public.cka_pay_log(uuid, text, text), public.cka_balances(uuid), public.payment_settings_save(int, int, boolean, text, numeric, int[], numeric, text, text, text),
  public.fee_plan_save(uuid, text, numeric, date), public.charge_add(uuid, date, text, text, numeric), public.charge_remove(uuid), public.late_fee_waive(uuid, text), public.payment_balances(uuid),
  public.payments_month(date), public.payments_list(date), public.payment_submit(uuid, date, numeric, text, text), public.cka_pay_notify_parents(uuid, text, text), public.payment_confirm(uuid),
  public.payment_reject(uuid, text), public.payment_record(uuid, date, numeric, text, text), public.payment_receipt(uuid), public.payments_owner_summary(date), public.cka_run_billing(timestamptz),
  public.event_respond(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.cka_pay_access(uuid), public.cka_pay_staff(), public.cka_pay_file_ok(text, boolean), public.payment_settings_save(int, int, boolean, text, numeric, int[], numeric, text, text, text),
  public.fee_plan_save(uuid, text, numeric, date), public.charge_add(uuid, date, text, text, numeric), public.charge_remove(uuid), public.late_fee_waive(uuid, text), public.payment_balances(uuid),
  public.payments_month(date), public.payments_list(date), public.payment_submit(uuid, date, numeric, text, text), public.payment_confirm(uuid),
  public.payment_reject(uuid, text), public.payment_record(uuid, date, numeric, text, text), public.payment_receipt(uuid), public.payments_owner_summary(date), public.event_respond(uuid, uuid, text)
to authenticated;
grant execute on function public.cka_run_billing(timestamptz) to service_role;
