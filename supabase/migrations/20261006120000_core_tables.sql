-- Cute Kids Academy parent portal: core tables (Prompt 3, Part 1).
-- Row-level security is switched on in a later migration; every table here is
-- locked down there. Nothing in this file contains real family data.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id),
  full_name   text not null,
  phone       text,
  language    text not null default 'ar' check (language in ('ar', 'en')),
  role        text not null check (role in ('parent', 'teacher', 'admin', 'manager', 'owner')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'One row per login. Deactivated users keep their row so history stays intact.';

create table public.classes (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  age_group        text not null,
  head_teacher_id  uuid references public.profiles (id),
  created_at       timestamptz not null default now()
);

create table public.children (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  date_of_birth  date not null,
  class_id       uuid references public.classes (id),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index children_class_idx on public.children (class_id);

-- A child can have two parents; each parent has their own login.
create table public.parent_children (
  parent_id  uuid not null references public.profiles (id),
  child_id   uuid not null references public.children (id),
  created_at timestamptz not null default now(),
  primary key (parent_id, child_id)
);
create index parent_children_child_idx on public.parent_children (child_id);

create table public.staff_classes (
  staff_id  uuid not null references public.profiles (id),
  class_id  uuid not null references public.classes (id),
  primary key (staff_id, class_id)
);

-- ---------------------------------------------------------------------------
-- Submissions (complaints and safety concerns) and their timeline
-- Ratings are NOT stored here: they live in public.ratings so that admin and
-- teachers, who can read submissions, can never read them.
-- ---------------------------------------------------------------------------
create table public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  ref_no               bigint generated always as identity unique,
  parent_id            uuid not null references public.profiles (id),
  child_id             uuid not null references public.children (id),
  type                 text not null check (type in ('complaint', 'safety_concern')),
  title                text not null check (length(btrim(title)) > 0),
  description          text not null check (length(btrim(description)) > 0),
  urgency              text not null default 'can_wait' check (urgency in ('critical', 'urgent', 'can_wait')),
  status               text not null default 'received'
                         check (status in ('received', 'acknowledged', 'in_progress', 'resolved', 'closed')),
  escalation_level     smallint not null default 1 check (escalation_level between 1 and 4),
  assigned_to          uuid references public.profiles (id),
  about_staff_member   uuid references public.profiles (id),
  acknowledge_by       timestamptz,
  resolve_by           timestamptz,
  acknowledged_at      timestamptz,
  resolved_at          timestamptz,
  parent_satisfied     boolean,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint not_assigned_to_subject check (assigned_to is null or about_staff_member is null or assigned_to <> about_staff_member)
);
create index submissions_parent_idx   on public.submissions (parent_id);
create index submissions_child_idx    on public.submissions (child_id);
create index submissions_deadline_idx on public.submissions (resolve_by) where status not in ('resolved', 'closed');
create index submissions_assigned_idx on public.submissions (assigned_to);

create table public.submission_events (
  id                 uuid primary key default gen_random_uuid(),
  submission_id      uuid not null references public.submissions (id),
  actor_id           uuid references public.profiles (id),   -- null = the system
  actor_name         text,                                    -- copied at write time so history survives deactivation
  event_type         text not null check (event_type in (
                       'created', 'acknowledged', 'status_changed', 'urgency_changed', 'assigned',
                       'escalated', 'update', 'internal_note', 'parent_reply', 'resolved',
                       'reopened', 'satisfaction', 'investigation_step')),
  message            text,
  old_value          text,
  new_value          text,
  visible_to_parent  boolean not null default false,
  created_at         timestamptz not null default now()
);
create index submission_events_sub_idx on public.submission_events (submission_id, created_at);
comment on column public.submission_events.visible_to_parent is
  'false = internal staff note or internal system event. Never shown to parents.';

-- ---------------------------------------------------------------------------
-- Accidents (logged by staff) and investigations
-- ---------------------------------------------------------------------------
create table public.incidents (
  id               uuid primary key default gen_random_uuid(),
  child_id         uuid not null references public.children (id),
  occurred_at      timestamptz not null,
  location         text not null,
  what_happened    text not null,
  injury           text,
  first_aid        text,
  severity         text not null default 'minor' check (severity in ('minor', 'needs_attention', 'serious')),
  witnesses        text[] not null default '{}',   -- staff names only, never other children
  parent_called_at timestamptz,
  parent_signed_at timestamptz,                    -- set when the parent taps "I've read this report"
  submission_id    uuid references public.submissions (id),
  reported_by      uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  -- Anything beyond a minor scrape must record that the parent was called.
  constraint parent_called_if_not_minor check (severity = 'minor' or parent_called_at is not null)
);
create index incidents_child_idx on public.incidents (child_id, occurred_at desc);

-- The part of an investigation parents may see.
create table public.investigations (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         uuid unique references public.incidents (id),
  submission_id       uuid unique references public.submissions (id),
  assigned_to         uuid references public.profiles (id),
  status              text not null default 'open' check (status in ('open', 'closed')),
  findings_for_parent text,                         -- written without other children's names
  parent_response     text check (parent_response in ('acknowledged', 'disagreed')),
  parent_responded_at timestamptz,
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  constraint linked_to_something check (incident_id is not null or submission_id is not null)
);

-- The part only manager and owner may see (admin and parents never).
create table public.investigation_internal (
  investigation_id  uuid primary key references public.investigations (id),
  internal_findings text,
  staff_statements  text,
  actions_taken     text,
  updated_at        timestamptz not null default now()
);

create table public.investigation_steps (
  id               uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations (id),
  step             text not null check (step in (
                     'opened', 'parent_called', 'facts_gathered', 'findings',
                     'actions_taken', 'parent_informed', 'closed')),
  completed_by     uuid references public.profiles (id),
  completed_at     timestamptz not null default now(),
  unique (investigation_id, step)
);

-- ---------------------------------------------------------------------------
-- Ratings (manager and owner only) and attachments
-- ---------------------------------------------------------------------------
create table public.ratings (
  id                   uuid primary key default gen_random_uuid(),
  parent_id            uuid not null references public.profiles (id),
  child_id             uuid not null references public.children (id),
  class_id             uuid references public.classes (id),
  month                date not null default (date_trunc('month', now() at time zone 'Africa/Cairo'))::date
                         check (month = date_trunc('month', month)::date),
  care_score           smallint not null check (care_score between 1 and 5),
  communication_score  smallint not null check (communication_score between 1 and 5),
  daily_reports_score  smallint not null check (daily_reports_score between 1 and 5),
  comment              text,
  compliment_staff_id  uuid references public.profiles (id),
  compliment_text      text,
  created_at           timestamptz not null default now(),
  unique (parent_id, child_id, month)
);

create table public.attachments (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.submissions (id),
  uploaded_by    uuid not null references public.profiles (id),
  storage_path   text not null unique,              -- "<submission_id>/<file>" in the private bucket
  file_name      text not null,
  mime_type      text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes     integer not null check (size_bytes > 0 and size_bytes <= 5242880),  -- 5 MB
  created_at     timestamptz not null default now()
);
create index attachments_sub_idx on public.attachments (submission_id);
