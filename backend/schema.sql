-- Beaver's pre-release database definition. There are no migrations until a
-- public deployment has data that must be preserved.
set search_path = public;
create extension if not exists "pgcrypto";
alter default privileges for role postgres in schema public
  revoke all on tables from public,anon,authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public,anon,authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public,anon,authenticated;

-- Supabase account state. Account-free local mode never executes this section.
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text, display_name text, organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text, tabular_model text, quote_model text,
  mfa_on_login boolean not null default false,
  legal_research_us boolean not null default true,
  drafting_style jsonb not null default '{"version":1}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists user_profiles_email_lower
  on user_profiles(lower(email)) where email is not null and btrim(email) <> '';

create or replace function handle_new_user() returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  insert into public.user_profiles(user_id,email) values(new.id,lower(new.email))
  on conflict(user_id) do update set email=excluded.email,updated_at=now();
  return new;
exception when others then return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure handle_new_user();
revoke execute on function public.handle_new_user() from public,anon,authenticated;

create table if not exists user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  encrypted_key text not null, iv text not null, auth_tag text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,provider)
);
create table if not exists user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, transport text not null default 'streamable_http',
  server_url text not null, auth_type text not null default 'none',
  enabled boolean not null default true, tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text, auth_config_iv text, auth_config_tag text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null unique references user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text, access_token_iv text, access_token_tag text,
  encrypted_refresh_token text, refresh_token_iv text, refresh_token_tag text,
  token_type text, scope text, expires_at timestamptz, authorization_server text,
  token_endpoint text, client_id text, encrypted_client_secret text,
  client_secret_iv text, client_secret_tag text, resource text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique, encrypted_state_config text not null,
  state_config_iv text not null, state_config_tag text not null,
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table if not exists user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references user_mcp_connectors(id) on delete cascade,
  tool_name text not null, openai_tool_name text not null unique, title text, description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb, annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true, requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique(connector_id,tool_name)
);
create table if not exists user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references user_mcp_connectors(id) on delete cascade,
  tool_id uuid references user_mcp_connector_tools(id) on delete set null,
  tool_name text not null, openai_tool_name text not null, status text not null,
  error_message text, duration_ms integer not null default 0,
  result_size_chars integer not null default 0, created_at timestamptz not null default now()
);

-- BEAVER_CORE_BEGIN
-- This section is deliberately valid in both PostgreSQL and SQLite. JSONB is
-- stored as JSON text by SQLite and decoded at the repository boundary.
create table if not exists projects (
  id text primary key, user_id text not null, name text not null,
  cm_number text, practice text, shared_with jsonb not null default '[]',
  metadata jsonb not null default '{}', notes text,
  created_at text not null, updated_at text not null
);
create table if not exists project_members (
  project_id text not null references projects(id) on delete cascade,
  email text not null, primary key(project_id,email)
);
create table if not exists project_subfolders (
  id text primary key, user_id text not null, project_id text not null references projects(id) on delete cascade,
  name text not null, parent_folder_id text references project_subfolders(id) on delete cascade,
  created_at text not null, updated_at text not null
);
create table if not exists library_folders (
  id text primary key, user_id text not null, library_kind text not null,
  name text not null, parent_folder_id text references library_folders(id) on delete cascade,
  created_at text not null, updated_at text not null,
  check(library_kind in ('file','template'))
);
create table if not exists documents (
  id text primary key, project_id text references projects(id) on delete cascade,
  user_id text not null, status text not null default 'ready',
  folder_id text references project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id text references library_folders(id) on delete cascade,
  metadata jsonb not null default '{}', notes text, filename text not null,
  current_version_id text, created_at text not null, updated_at text not null,
  check(library_kind in ('file','template')),
  check(project_id is null or library_folder_id is null),
  check(project_id is not null or folder_id is null)
);
create table if not exists document_versions (
  id text primary key, document_id text not null references documents(id) on delete cascade,
  version_number integer not null, source text not null, created_at text not null,
  filename text not null, file_type text not null, size_bytes integer not null,
  page_count integer, source_sha256 text not null, storage_path text not null,
  pdf_storage_path text, cleanup_paths jsonb not null default '[]', provenance jsonb,
  unique(document_id,version_number)
);
create table if not exists document_edits (
  id text primary key, document_id text not null references documents(id) on delete cascade,
  version_id text not null references document_versions(id) on delete cascade,
  change_id text not null, del_w_id text, ins_w_id text,
  deleted_text text not null default '', inserted_text text not null default '',
  context_before text not null default '', context_after text not null default '',
  reason text, diff jsonb not null default '[]', status text not null,
  resolved_at text, check(status in ('pending','accepted','rejected'))
);
create table if not exists object_cleanup (
  storage_path text primary key, user_id text not null, created_at text not null
);
create table if not exists library_legal_sources (
  user_id text not null, id text not null, pointer_json text not null,
  primary key(user_id,id)
);

create table if not exists tabular_reviews (
  id text primary key, user_id text not null, project_id text references projects(id) on delete cascade,
  title text, columns_config jsonb not null default '[]', document_ids jsonb not null default '[]',
  workflow_id text, shared_with jsonb not null default '[]',
  created_at text not null, updated_at text not null
);
create table if not exists tabular_review_members (
  review_id text not null references tabular_reviews(id) on delete cascade,
  email text not null, primary key(review_id,email)
);
create table if not exists tabular_cells (
  id text primary key, review_id text not null references tabular_reviews(id) on delete cascade,
  document_id text not null, column_index integer not null, content jsonb,
  status text not null default 'pending', created_at text not null, updated_at text not null,
  unique(review_id,document_id,column_index),
  check(status in ('pending','generating','done','error'))
);

create table if not exists chats (
  id text primary key, user_id text not null, project_id text references projects(id) on delete cascade,
  tabular_review_id text references tabular_reviews(id) on delete cascade, title text,
  created_at text not null, updated_at text not null, deleted_at text,
  transcript_version integer not null default 0,
  check(project_id is null or tabular_review_id is null)
);
create table if not exists chat_messages (
  id text primary key, chat_id text not null references chats(id) on delete cascade,
  turn_id text, role text not null, content jsonb not null, files jsonb,
  workflow jsonb, citations jsonb, created_at text not null,
  check(role in ('user','assistant'))
);
create table if not exists provider_sessions (
  chat_id text primary key references chats(id) on delete cascade,
  user_id text not null, project_id text, continuation_id text not null,
  compatibility_key text not null, transcript_version integer not null,
  created_at text not null, updated_at text not null
);

create table if not exists application_jobs (
  id text primary key, kind text not null, dedupe_key text, group_key text,
  user_id text not null, document_id text references documents(id) on delete cascade,
  document_version_id text references document_versions(id) on delete cascade,
  payload jsonb not null, priority integer not null default 0,
  status text not null, run_at text not null, attempts integer not null default 0,
  max_attempts integer not null default 3, locked_by text, locked_until text,
  interrupt_requested_at text, progress jsonb, result jsonb, last_error text,
  created_at text not null, updated_at text not null, completed_at text,
  unique(kind,user_id,dedupe_key),
  check(priority between -100 and 100),
  check(max_attempts between 1 and 10),
  check(attempts between 0 and max_attempts),
  check(status in ('queued','running','succeeded','failed','cancelled'))
);

create table if not exists workflows (
  id text primary key, user_id text not null, title text not null, type text not null,
  prompt_md text, columns_config jsonb, language text, version text, practice text,
  jurisdictions jsonb, contributors jsonb, created_at text not null, updated_at text not null,
  check(type in ('assistant','tabular'))
);
create table if not exists hidden_workflows (
  user_id text not null, workflow_id text not null, created_at text not null,
  primary key(user_id,workflow_id)
);
create table if not exists workflow_shares (
  id text primary key, workflow_id text not null references workflows(id) on delete cascade,
  shared_by_user_id text not null, shared_with_email text not null,
  allow_edit boolean not null default false, created_at text not null,
  unique(workflow_id,shared_with_email)
);
create table if not exists workflow_open_source_submissions (
  id text primary key, workflow_id text not null references workflows(id) on delete cascade,
  submitted_by_user_id text not null, submitter_email text, submitter_name text,
  contributor_mode text not null, snapshot jsonb not null, status text not null,
  submitted_at text not null, updated_at text not null, reviewed_at text
);

create index if not exists projects_owner_page on projects(user_id,created_at desc,id desc);
create index if not exists project_members_email on project_members(email,project_id);
create index if not exists project_folders_page on project_subfolders(project_id,parent_folder_id,name,id);
create index if not exists library_folders_page on library_folders(user_id,library_kind,parent_folder_id,name,id);
create index if not exists documents_scope on documents(user_id,project_id,library_kind,library_folder_id,filename,id);
create index if not exists document_versions_scope on document_versions(document_id,version_number);
create index if not exists document_edits_scope on document_edits(document_id,version_id);
create index if not exists tabular_reviews_page on tabular_reviews(user_id,created_at desc,id desc);
create index if not exists tabular_members_email on tabular_review_members(email,review_id);
create index if not exists tabular_cells_review on tabular_cells(review_id,document_id,column_index);
create index if not exists chats_page on chats(user_id,deleted_at,updated_at desc,id);
create index if not exists chat_messages_page on chat_messages(chat_id,created_at,id);
create index if not exists application_jobs_claim on
  application_jobs(status,priority desc,run_at,created_at,id);
create index if not exists application_jobs_group on application_jobs(group_key,status);
create index if not exists application_jobs_document on
  application_jobs(document_version_id,updated_at desc,id desc);
create index if not exists workflows_page on workflows(user_id,created_at desc,id);
create index if not exists workflow_shares_email on workflow_shares(shared_with_email,workflow_id);
-- BEAVER_CORE_END

-- Supabase administration/export code also writes shared_with. Keep the
-- indexed authorization tables synchronized without teaching every caller a
-- second persistence protocol. Local mode does this in its transaction.
create or replace function sync_shared_members() returns trigger language plpgsql
set search_path = '' as $$
begin
  if tg_table_name = 'projects' then
    delete from public.project_members where project_id=new.id;
    insert into public.project_members(project_id,email)
      select new.id,lower(value) from jsonb_array_elements_text(new.shared_with)
      on conflict do nothing;
  else
    delete from public.tabular_review_members where review_id=new.id;
    insert into public.tabular_review_members(review_id,email)
      select new.id,lower(value) from jsonb_array_elements_text(new.shared_with)
      on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists projects_sync_members on projects;
create trigger projects_sync_members after insert or update of shared_with on projects
  for each row execute procedure sync_shared_members();
drop trigger if exists reviews_sync_members on tabular_reviews;
create trigger reviews_sync_members after insert or update of shared_with on tabular_reviews
  for each row execute procedure sync_shared_members();
revoke execute on function public.sync_shared_members() from public,anon,authenticated;

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(), user_id text not null, user_email text,
  action text not null, status text not null default 'completed', title text, surface text,
  project_id text, chat_id text, document_id text, review_id text, model text, detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_user_created on audit_events(user_id,created_at desc);

-- Core application data is reachable only through Beaver's scoped HTTP API.
-- The service role remains available to account/audit/export administration.
revoke all on table projects,project_members,project_subfolders,library_folders,documents,
  document_versions,document_edits,object_cleanup,library_legal_sources,tabular_reviews,
  tabular_review_members,tabular_cells,chats,chat_messages,provider_sessions,application_jobs,workflows,
  hidden_workflows,workflow_shares,workflow_open_source_submissions,audit_events
  from public,anon,authenticated;
revoke all on table user_profiles,user_api_keys,user_mcp_connectors,user_mcp_oauth_tokens,
  user_mcp_oauth_states,user_mcp_connector_tools,user_mcp_tool_audit_logs
  from public,anon,authenticated;
grant all on table projects,project_members,project_subfolders,library_folders,documents,
  document_versions,document_edits,object_cleanup,library_legal_sources,tabular_reviews,
  tabular_review_members,tabular_cells,chats,chat_messages,provider_sessions,application_jobs,workflows,
  hidden_workflows,workflow_shares,workflow_open_source_submissions,audit_events
  to service_role;
grant all on table user_profiles,user_api_keys,user_mcp_connectors,user_mcp_oauth_tokens,
  user_mcp_oauth_states,user_mcp_connector_tools,user_mcp_tool_audit_logs
  to service_role;

alter table user_profiles enable row level security;
alter table user_api_keys enable row level security;
alter table user_mcp_connectors enable row level security;
alter table user_mcp_oauth_tokens enable row level security;
alter table user_mcp_oauth_states enable row level security;
alter table user_mcp_connector_tools enable row level security;
alter table user_mcp_tool_audit_logs enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_subfolders enable row level security;
alter table library_folders enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table document_edits enable row level security;
alter table object_cleanup enable row level security;
alter table library_legal_sources enable row level security;
alter table tabular_reviews enable row level security;
alter table tabular_review_members enable row level security;
alter table tabular_cells enable row level security;
alter table chats enable row level security;
alter table chat_messages enable row level security;
alter table provider_sessions enable row level security;
alter table application_jobs enable row level security;
alter table workflows enable row level security;
alter table hidden_workflows enable row level security;
alter table workflow_shares enable row level security;
alter table workflow_open_source_submissions enable row level security;
alter table audit_events enable row level security;
