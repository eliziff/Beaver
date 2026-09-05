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
  email text,
  mfa_on_login boolean not null default false,
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
  insert into public.user_preferences(user_id,display_name,organisation,updated_at)
  values(
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data->>'display_name',
      new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name','')),160),''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data->>'organisation','')),240),''),
    now()
  ) on conflict(user_id) do update set
    display_name=coalesce(public.user_preferences.display_name,excluded.display_name),
    organisation=coalesce(public.user_preferences.organisation,excluded.organisation),
    updated_at=now();
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
-- BEAVER_CORE_BEGIN
-- This section is deliberately valid in both PostgreSQL and SQLite. JSONB is
-- stored as JSON text by SQLite and decoded at the repository boundary.
create table if not exists user_mcp_connectors (
  id text primary key, user_id uuid not null, name text not null,
  transport text not null default 'streamable_http', server_url text not null,
  auth_type text not null default 'none', enabled integer not null default 1,
  tool_policy jsonb not null default '{}', encrypted_auth_config text,
  auth_config_iv text, auth_config_tag text, created_at text not null,
  updated_at text not null
);
create table if not exists user_mcp_oauth_tokens (
  id text primary key, connector_id text not null unique references user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text, access_token_iv text, access_token_tag text,
  encrypted_refresh_token text, refresh_token_iv text, refresh_token_tag text,
  token_type text, scope text, expires_at text, authorization_server text,
  token_endpoint text, client_id text, encrypted_client_secret text,
  client_secret_iv text, client_secret_tag text, resource text,
  created_at text not null, updated_at text not null
);
create table if not exists user_mcp_oauth_states (
  id text primary key, user_id uuid not null,
  connector_id text not null references user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique, encrypted_state_config text not null,
  state_config_iv text not null, state_config_tag text not null,
  expires_at text not null, created_at text not null
);
create table if not exists user_mcp_connector_tools (
  id text primary key, connector_id text not null references user_mcp_connectors(id) on delete cascade,
  tool_name text not null, openai_tool_name text not null unique, title text, description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}',
  output_schema jsonb, annotations jsonb not null default '{}',
  enabled integer not null default 1, requires_confirmation integer not null default 0,
  last_seen_at text not null, created_at text not null, updated_at text not null,
  unique(connector_id,tool_name)
);
create table if not exists user_mcp_tool_audit_logs (
  id text primary key, user_id uuid not null,
  connector_id text not null references user_mcp_connectors(id) on delete cascade,
  tool_id text references user_mcp_connector_tools(id) on delete set null,
  tool_name text not null, openai_tool_name text not null, status text not null,
  error_message text, duration_ms integer not null default 0,
  result_size_chars integer not null default 0, created_at text not null
);
create table if not exists projects (
  id text primary key, user_id uuid not null, name text not null,
  cm_number text, practice text, shared_with jsonb not null default '[]',
  metadata jsonb not null default '{}', notes text,
  created_at text not null, updated_at text not null
);
create table if not exists project_members (
  project_id text not null references projects(id) on delete cascade,
  email text not null, primary key(project_id,email)
);
create table if not exists project_subfolders (
  id text primary key, user_id uuid not null, project_id text not null references projects(id) on delete cascade,
  name text not null, parent_folder_id text references project_subfolders(id) on delete cascade,
  created_at text not null, updated_at text not null
);
create table if not exists library_folders (
  id text primary key, user_id uuid not null, library_kind text not null,
  name text not null, parent_folder_id text references library_folders(id) on delete cascade,
  created_at text not null, updated_at text not null,
  check(library_kind in ('file','template'))
);
create table if not exists documents (
  id text primary key, project_id text references projects(id) on delete cascade,
  user_id uuid not null, status text not null default 'ready',
  folder_id text references project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id text references library_folders(id) on delete cascade,
  metadata jsonb not null default '{}', notes text, filename text not null,
  current_version_id text not null, created_at text not null, updated_at text not null,
  check(library_kind in ('file','template')),
  check(project_id is null or library_folder_id is null),
  check(project_id is not null or folder_id is null)
);
create table if not exists document_versions (
  id text primary key, document_id text not null references documents(id) on delete cascade,
  parent_version_id text,
  version_number integer not null, working_revision integer not null default 0,
  source text not null, created_by uuid, author_email text, comment text, created_at text not null,
  filename text not null, file_type text not null, size_bytes integer not null,
  page_count integer, source_sha256 text not null, storage_path text not null,
  pdf_storage_path text, pdf_profile jsonb, provenance jsonb,
  unique(document_id,version_number), unique(id,document_id),
  foreign key(parent_version_id,document_id) references document_versions(id,document_id),
  check(version_number>0), check(working_revision>=0),
  check(comment is null or length(comment)<=1000),
  check((version_number=1)=(parent_version_id is null)),
  check(parent_version_id is null or parent_version_id<>id)
);
create table if not exists document_version_parts (
  document_id text not null, version_id text not null, name text not null,
  size_bytes integer not null, sha256 text not null, storage_path text not null,
  primary key(version_id,name),
  foreign key(version_id,document_id) references document_versions(id,document_id) on delete cascade,
  check(length(name) between 1 and 200), check(size_bytes>=0), check(length(sha256)=64)
);
create table if not exists document_edits (
  id text primary key, document_id text not null references documents(id) on delete cascade,
  version_id text not null,
  change_id text not null, del_w_id text, ins_w_id text,
  deleted_text text not null default '', inserted_text text not null default '',
  context_before text not null default '', context_after text not null default '',
  reason text, diff jsonb not null default '[]', status text not null,
  resolved_at text, check(status in ('pending','accepted','rejected')),
  foreign key(version_id,document_id) references document_versions(id,document_id) on delete cascade
);
create table if not exists object_cleanup (
  storage_path text primary key, created_at text not null,
  claim_id text, claimed_at text,
  check((claim_id is null)=(claimed_at is null))
);
create index if not exists object_cleanup_created_at_idx on object_cleanup(created_at);
create index if not exists object_cleanup_claim_idx on object_cleanup(claim_id)
  where claim_id is not null;
create table if not exists library_legal_sources (
  user_id uuid not null, id text not null, pointer_json text not null,
  primary key(user_id,id)
);

create table if not exists tabular_reviews (
  id text primary key, user_id uuid not null, project_id text references projects(id) on delete cascade,
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
  id text primary key, user_id uuid not null, project_id text references projects(id) on delete cascade,
  tabular_review_id text references tabular_reviews(id) on delete cascade, title text,
  model text, reasoning_effort text,
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
create table if not exists chat_message_events (
  message_id text not null references chat_messages(id) on delete cascade,
  ordinal integer not null, event jsonb not null, created_at text not null,
  primary key(message_id,ordinal)
);
create table if not exists provider_sessions (
  chat_id text primary key references chats(id) on delete cascade,
  user_id uuid not null, project_id text, continuation_id text not null,
  compatibility_key text not null, transcript_version integer not null,
  created_at text not null, updated_at text not null
);

create table if not exists application_jobs (
  id text primary key, kind text not null, dedupe_key text, group_key text,
  user_id uuid not null, document_id text references documents(id) on delete cascade,
  document_version_id text references document_versions(id) on delete cascade,
  payload jsonb not null, priority integer not null default 0,
  status text not null, run_at text not null, attempts integer not null default 0,
  max_attempts integer not null default 3, locked_by text, locked_until text,
  interrupt_requested_at text, cancel_requested_at text,
  progress jsonb, result jsonb, last_error text,
  created_at text not null, updated_at text not null, completed_at text,
  unique(kind,user_id,dedupe_key),
  check(priority between -100 and 100),
  check(max_attempts between 1 and 10),
  check(attempts between 0 and max_attempts),
  check(status in ('queued','running','succeeded','failed','cancelled'))
);

create table if not exists application_job_events (
  job_id text references application_jobs(id) on delete cascade,
  sequence integer not null, event jsonb not null, created_at text not null,
  primary key(job_id,sequence)
);

create table if not exists application_job_commands (
  id text primary key, job_id text references application_jobs(id) on delete cascade,
  kind text not null, payload jsonb not null, created_at text not null, handled_at text
);

create table if not exists workflows (
  id text primary key, user_id uuid not null, title text not null, execution text not null,
  variant_label text not null, variant_result text,
  prompt_md text, columns_config jsonb, language text, version text, category text not null,
  audiences jsonb not null, jurisdictions jsonb, contributors jsonb,
  created_at text not null, updated_at text not null,
  check(execution in ('assistant','tabular'))
);
create table if not exists work_products (
  id text primary key, user_id uuid not null,
  project_id text references projects(id) on delete cascade,
  kind text not null, title text not null,
  state_json jsonb not null default '{}', outputs_json jsonb not null default '{}',
  revision integer not null default 1, created_at text not null, updated_at text not null,
  check(kind in ('court-record','authorities','research-set')), check(revision > 0)
);
create table if not exists workflow_shares (
  id text primary key, workflow_id text not null references workflows(id) on delete cascade,
  shared_by_user_id uuid not null, shared_with_email text not null,
  allow_edit boolean not null default false, created_at text not null,
  unique(workflow_id,shared_with_email)
);
create table if not exists workflow_open_source_submissions (
  id text primary key, workflow_id text not null references workflows(id) on delete cascade,
  submitted_by_user_id uuid not null, submitter_email text, submitter_name text,
  contributor_mode text not null, snapshot jsonb not null, status text not null,
  submitted_at text not null, updated_at text not null, reviewed_at text
);
create table if not exists audit_events (
  id text primary key, user_id uuid not null, user_email text,
  action text not null, status text not null default 'completed', title text, surface text,
  project_id text, chat_id text, document_id text, review_id text, model text, detail jsonb,
  created_at text not null, check(status in ('completed','cancelled','failed'))
);
create table if not exists user_preferences (
  user_id uuid primary key,
  display_name text, organisation text,
  practice_setting text, professional_title text,
  practice_areas jsonb not null default '[]',
  jurisdiction_mode text not null default 'ask',
  jurisdictions jsonb not null default '[]',
  onboarding_completed integer not null default 0,
  title_model text, tabular_model text,
  last_selected_chat_model text, last_selected_reasoning_effort text,
  legal_research_us integer not null default 1,
  features jsonb not null default '{"authorities":true}',
  workflow_file_targets jsonb not null default '{}',
  filing_contact jsonb not null default '{}',
  drafting_style jsonb not null default '{"version":1}',
  updated_at text not null
);

create index if not exists projects_owner_page on projects(user_id,created_at desc,id desc);
create index if not exists project_members_email on project_members(email,project_id);
create index if not exists project_folders_page on project_subfolders(project_id,parent_folder_id,name,id);
create index if not exists library_folders_page on library_folders(user_id,library_kind,parent_folder_id,name,id);
create index if not exists documents_scope on documents(user_id,project_id,library_kind,library_folder_id,filename,id);
create index if not exists document_versions_parent on document_versions(parent_version_id);
create index if not exists document_versions_blob on document_versions(storage_path);
create index if not exists document_versions_pdf_blob on document_versions(pdf_storage_path);
create index if not exists document_version_parts_blob on document_version_parts(storage_path);
create index if not exists document_version_parts_document on document_version_parts(document_id,version_id);
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
create index if not exists application_job_commands_pending on
  application_job_commands(job_id,handled_at,created_at,id);
create index if not exists workflows_page on workflows(user_id,created_at desc,id);
create index if not exists work_products_page on work_products(user_id,updated_at desc,id desc);
create index if not exists work_products_project on work_products(project_id,updated_at desc,id desc);
create index if not exists workflow_shares_email on workflow_shares(shared_with_email,workflow_id);
create index if not exists audit_events_user_created on audit_events(user_id,created_at desc);
create index if not exists audit_events_project_created on audit_events(project_id,created_at desc);
-- BEAVER_CORE_END

-- Cloud owns identity; local mode uses the same UUID-shaped values without
-- importing Supabase into application code.
alter table user_mcp_connectors add constraint user_mcp_connectors_auth_user
  foreign key(user_id) references auth.users(id) on delete cascade;
alter table user_mcp_oauth_states add constraint user_mcp_oauth_states_auth_user
  foreign key(user_id) references auth.users(id) on delete cascade;
alter table user_mcp_tool_audit_logs add constraint user_mcp_tool_logs_auth_user
  foreign key(user_id) references auth.users(id) on delete cascade;
alter table projects add constraint projects_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table project_subfolders add constraint project_subfolders_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table library_folders add constraint library_folders_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table documents add constraint documents_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table document_versions add constraint document_versions_auth_user foreign key(created_by) references auth.users(id) on delete set null;
alter table library_legal_sources add constraint library_sources_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table tabular_reviews add constraint tabular_reviews_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table chats add constraint chats_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table provider_sessions add constraint provider_sessions_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table application_jobs add constraint application_jobs_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table workflows add constraint workflows_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table work_products add constraint work_products_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table workflow_shares add constraint workflow_shares_auth_user foreign key(shared_by_user_id) references auth.users(id) on delete cascade;
alter table workflow_open_source_submissions add constraint workflow_submissions_auth_user foreign key(submitted_by_user_id) references auth.users(id) on delete cascade;
alter table audit_events add constraint audit_events_auth_user foreign key(user_id) references auth.users(id) on delete cascade;
alter table user_preferences add constraint user_preferences_auth_user foreign key(user_id) references auth.users(id) on delete cascade;

-- Keep object cleanup crash-safe even when an identity/project cascade, rather
-- than an application delete, removes the final version reference.
create or replace function queue_deleted_document_version() returns trigger language plpgsql
security definer set search_path = '' as $$
declare deleted_at text := to_char(clock_timestamp() at time zone 'utc',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  insert into public.object_cleanup(storage_path,created_at)
    select distinct path,deleted_at from
      (values(to_jsonb(old)->>'storage_path'),
        (to_jsonb(old)->>'pdf_storage_path')) paths(path)
      where path is not null
    on conflict(storage_path) do update set created_at=excluded.created_at,
      claim_id=null,claimed_at=null;
  return old;
end $$;
drop trigger if exists document_versions_queue_cleanup on document_versions;
create trigger document_versions_queue_cleanup after delete on document_versions
  for each row execute procedure queue_deleted_document_version();
drop trigger if exists document_version_parts_queue_cleanup on document_version_parts;
create trigger document_version_parts_queue_cleanup after delete on document_version_parts
  for each row execute procedure queue_deleted_document_version();
revoke execute on function public.queue_deleted_document_version()
  from public,anon,authenticated;

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

-- Core application data is reachable only through Beaver's scoped HTTP API.
-- The service role remains available to account/audit/export administration.
revoke all on table projects,project_members,project_subfolders,library_folders,documents,
  document_versions,document_version_parts,document_edits,object_cleanup,library_legal_sources,tabular_reviews,
  tabular_review_members,tabular_cells,chats,chat_messages,chat_message_events,
  provider_sessions,application_jobs,
  application_job_events,application_job_commands,workflows,work_products,
  workflow_shares,workflow_open_source_submissions,audit_events,user_preferences
  from public,anon,authenticated;
revoke all on table user_profiles,user_api_keys,user_mcp_connectors,user_mcp_oauth_tokens,
  user_mcp_oauth_states,user_mcp_connector_tools,user_mcp_tool_audit_logs
  from public,anon,authenticated;
grant all on table projects,project_members,project_subfolders,library_folders,documents,
  document_versions,document_version_parts,document_edits,object_cleanup,library_legal_sources,tabular_reviews,
  tabular_review_members,tabular_cells,chats,chat_messages,chat_message_events,
  provider_sessions,application_jobs,
  application_job_events,application_job_commands,workflows,work_products,
  workflow_shares,workflow_open_source_submissions,audit_events,user_preferences
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
alter table document_version_parts enable row level security;
alter table document_edits enable row level security;
alter table object_cleanup enable row level security;
alter table library_legal_sources enable row level security;
alter table tabular_reviews enable row level security;
alter table tabular_review_members enable row level security;
alter table tabular_cells enable row level security;
alter table chats enable row level security;
alter table chat_messages enable row level security;
alter table chat_message_events enable row level security;
alter table provider_sessions enable row level security;
alter table application_jobs enable row level security;
alter table application_job_events enable row level security;
alter table application_job_commands enable row level security;
alter table workflows enable row level security;
alter table work_products enable row level security;
alter table workflow_shares enable row level security;
alter table workflow_open_source_submissions enable row level security;
alter table audit_events enable row level security;
alter table user_preferences enable row level security;
