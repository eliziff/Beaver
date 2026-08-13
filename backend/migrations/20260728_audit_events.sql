-- Backend-only history of cloud user actions.
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null,
  user_email text,
  action text not null,
  status text not null default 'completed',
  title text,
  surface text,
  project_id uuid,
  chat_id uuid,
  document_id uuid,
  review_id uuid,
  model text,
  detail jsonb
);

create index if not exists audit_events_user_created
  on public.audit_events (user_id, created_at desc);
create index if not exists audit_events_project_created
  on public.audit_events (project_id, created_at desc);

revoke all on public.audit_events from anon, authenticated;
alter table public.audit_events enable row level security;
grant select, insert, update, delete on public.audit_events to service_role;
