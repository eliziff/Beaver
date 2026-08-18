-- Beaver Supabase schema
-- Use this for a fresh Supabase database. Existing deployments should instead
-- apply the dated incremental migration files in backend/migrations that are
-- newer than the version of Beaver they currently have deployed.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text,
  tabular_model text not null default 'gemini-3-flash-preview',
  quote_model text,
  mfa_on_login boolean not null default false,
  legal_research_us boolean not null default true,
  drafting_style jsonb not null default '{"version":1,"documents":{"memo":{"citationPlacement":"footnotes","citationHyperlinks":true,"numberHeadings":false},"factum":{"citationPlacement":"inline","citationHyperlinks":true,"numberHeadings":true},"letter":{"citationPlacement":"footnotes","citationHyperlinks":true,"numberHeadings":false},"other":{"citationPlacement":"inline","citationHyperlinks":true,"numberHeadings":"auto"}},"memoHeader":{"to":"File","from":"AI Assistant"}}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create unique index if not exists user_profiles_email_lower_unique
  on public.user_profiles (lower(email))
  where email is not null and btrim(email) <> '';

create index if not exists idx_user_profiles_email
  on public.user_profiles(email);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai', 'deepseek', 'openrouter', 'courtlistener')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

alter table public.user_api_keys enable row level security;

create table if not exists public.user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http')),
  server_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth')),
  enabled boolean not null default true,
  tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text,
  auth_config_iv text,
  auth_config_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
  on public.user_mcp_connectors(user_id);

alter table public.user_mcp_connectors enable row level security;

create table if not exists public.user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_type text,
  scope text,
  expires_at timestamptz,
  authorization_server text,
  token_endpoint text,
  client_id text,
  encrypted_client_secret text,
  client_secret_iv text,
  client_secret_tag text,
  resource text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id)
);

alter table public.user_mcp_oauth_tokens enable row level security;

create table if not exists public.user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique,
  encrypted_state_config text not null,
  state_config_iv text not null,
  state_config_tag text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
  on public.user_mcp_oauth_states(expires_at);

alter table public.user_mcp_oauth_states enable row level security;

create table if not exists public.user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_name text not null,
  openai_tool_name text not null,
  title text,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb,
  annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id, tool_name),
  unique(openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
  on public.user_mcp_connector_tools(connector_id);

alter table public.user_mcp_connector_tools enable row level security;

create table if not exists public.user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  tool_name text not null,
  openai_tool_name text not null,
  status text not null check (status in ('ok', 'error')),
  error_message text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc);

alter table public.user_mcp_tool_audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  cm_number text,
  practice text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id uuid references public.library_folders(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_library_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  filename text,
  file_type text,
  size_bytes integer,
  page_count integer,
  provenance jsonb,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_doc_version_unique'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_doc_version_unique
      unique (document_id, version_number);
  end if;
end;
$$;

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Audit history (cloud mode)
-- ---------------------------------------------------------------------------

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
  on public.audit_events(user_id, created_at desc);

create index if not exists audit_events_project_created
  on public.audit_events(project_id, created_at desc);

alter table public.audit_events enable row level security;

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  language text default 'English',
  practice text default 'General Transactions',
  jurisdictions text[] default array['General']::text[],
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id text not null,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

-- Review queue for user-submitted workflows that may later be published to the
-- open-source workflow repository. The backend writes with the service role.
create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  submitted_by_user_id text not null,
  submitter_email text,
  submitter_name text,
  contributor_mode text not null default 'anonymous',
  status text not null default 'pending',
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint workflow_open_source_submissions_contributor_mode_check
    check (contributor_mode in ('named', 'anonymous'))
);

create unique index if not exists idx_workflow_open_source_submissions_pending
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending';

create index if not exists idx_workflow_open_source_submissions_reviewer_queue
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists idx_workflow_open_source_submissions_submitter
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

alter table public.workflow_open_source_submissions enable row level security;


-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  tabular_review_id uuid,
  user_id text not null,
  title text,
  transcript_version bigint not null default 0 check (transcript_version >= 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (project_id is null or tabular_review_id is null)
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create index if not exists idx_chats_tabular_review
  on public.chats(tabular_review_id);

create index if not exists chats_deleted_user_idx
  on public.chats(user_id, deleted_at desc)
  where deleted_at is not null;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  turn_id uuid,
  role text not null,
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_chat on public.chat_messages(chat_id);
create index if not exists idx_chat_messages_turn on public.chat_messages(chat_id, turn_id)
  where turn_id is not null;

-- The backend is the sole application-data caller. This security-invoker RPC
-- requires its service-role context, locks the chat revision, verifies the
-- authenticated actor's resource capability, and applies one transcript write.
create or replace function public.commit_chat_turn(
  p_actor_user_id text,
  p_actor_user_email text,
  p_chat_id uuid,
  p_expected_version bigint,
  p_user_message jsonb default null,
  p_assistant_message jsonb default null,
  p_append_event jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_chat public.chats%rowtype;
  v_actor_email text := lower(trim(coalesce(p_actor_user_email, '')));
  v_allowed boolean := false;
  v_assistant_id uuid;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), current_user)
       <> 'service_role'
     and current_user <> 'service_role' then
    raise insufficient_privilege using message = 'service role required';
  end if;

  select * into v_chat
  from public.chats
  where id = p_chat_id and deleted_at is null
  for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;

  v_allowed := v_chat.user_id = p_actor_user_id
    or exists (
      select 1 from public.projects p
      where p.id = v_chat.project_id
        and (p.user_id = p_actor_user_id or (v_actor_email <> '' and exists (
          select 1 from jsonb_array_elements_text(p.shared_with) member
          where lower(trim(member)) = v_actor_email
        )))
    )
    or exists (
      select 1 from public.tabular_reviews r
      where r.id = v_chat.tabular_review_id
        and (
          r.user_id = p_actor_user_id
          or (v_actor_email <> '' and exists (
            select 1 from jsonb_array_elements_text(r.shared_with) member
            where lower(trim(member)) = v_actor_email
          ))
          or exists (
            select 1 from public.projects p
            where p.id = r.project_id
              and (p.user_id = p_actor_user_id or (v_actor_email <> '' and exists (
                select 1 from jsonb_array_elements_text(p.shared_with) member
                where lower(trim(member)) = v_actor_email
              )))
          )
        )
    );
  if not v_allowed then return jsonb_build_object('status', 'missing'); end if;
  if p_expected_version is not null
     and v_chat.transcript_version <> p_expected_version then
    return jsonb_build_object(
      'status', 'conflict',
      'current_version', v_chat.transcript_version
    );
  end if;
  if p_user_message is null and p_assistant_message is null and p_append_event is null then
    raise invalid_parameter_value using message = 'turn commit is empty';
  end if;
  if p_expected_version is null and p_append_event is null then
    raise invalid_parameter_value using message = 'turn snapshot requires an expected version';
  end if;
  if p_append_event is not null
     and (p_user_message is not null or p_assistant_message is not null) then
    raise invalid_parameter_value using message = 'append mode cannot include a turn snapshot';
  end if;

  if p_user_message is not null then
    insert into public.chat_messages
      (id, chat_id, turn_id, role, content, files, workflow)
    values (
      (p_user_message->>'id')::uuid,
      p_chat_id,
      nullif(p_user_message->>'turn_id', '')::uuid,
      'user',
      p_user_message->'content',
      p_user_message->'files',
      p_user_message->'workflow'
    );
  end if;

  if p_assistant_message is not null then
    v_assistant_id := (p_assistant_message->>'id')::uuid;
    update public.chat_messages
    set turn_id = coalesce(
          nullif(p_assistant_message->>'turn_id', '')::uuid,
          turn_id
        ),
        content = coalesce(p_assistant_message->'content', '[]'::jsonb),
        citations = p_assistant_message->'citations'
    where id = v_assistant_id and chat_id = p_chat_id and role = 'assistant';
    if not found then
      insert into public.chat_messages
        (id, chat_id, turn_id, role, content, citations)
      values (
        v_assistant_id,
        p_chat_id,
        nullif(p_assistant_message->>'turn_id', '')::uuid,
        'assistant',
        coalesce(p_assistant_message->'content', '[]'::jsonb),
        p_assistant_message->'citations'
      );
    end if;
  end if;

  if p_append_event is not null then
    v_assistant_id := nullif(p_append_event->>'message_id', '')::uuid;
    update public.chat_messages
    set content = coalesce(content, '[]'::jsonb)
      || jsonb_build_array(p_append_event->'event')
    where id = v_assistant_id and chat_id = p_chat_id and role = 'assistant';
    if not found then return jsonb_build_object('status', 'missing'); end if;
  end if;

  update public.chats
  set transcript_version = transcript_version + 1
  where id = p_chat_id
  returning * into v_chat;
  return jsonb_build_object(
    'status', 'committed',
    'current_version', v_chat.transcript_version
  );
end;
$$;

revoke all on function public.commit_chat_turn(
  text, text, uuid, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_chat_turn(
  text, text, uuid, bigint, jsonb, jsonb, jsonb
) to service_role;

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null
)
returns table (
  id uuid,
  project_id uuid,
  tabular_review_id uuid,
  user_id text,
  title text,
  created_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.tabular_review_id,
    c.user_id,
    c.title,
    c.created_at
  from public.chats c
  where c.deleted_at is null
    and c.tabular_review_id is null
    and exists (
      select 1 from public.chat_messages m where m.chat_id = c.id
    )
    and (c.user_id = p_user_id or exists (
      select 1 from public.projects p
      where p.id = c.project_id and p.user_id = p_user_id
    ))
  order by c.created_at desc
  limit case when p_limit is null then null
    else greatest(1, least(p_limit, 100)) end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

do $$
begin
  if not exists (select 1 from pg_constraint
    where conname = 'chats_tabular_review_id_fkey'
      and conrelid = 'public.chats'::regclass) then
    alter table public.chats
      add constraint chats_tabular_review_id_fkey
      foreign key (tabular_review_id)
      references public.tabular_reviews(id)
      on delete cascade;
  end if;
end;
$$;


create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);


-- ---------------------------------------------------------------------------
-- CourtListener bulk-data indexes
-- ---------------------------------------------------------------------------

create table if not exists public.courtlistener_citation_index (
  id bigint primary key,
  volume text not null,
  reporter text not null,
  page text not null,
  type integer,
  cluster_id bigint not null,
  date_created timestamptz,
  date_modified timestamptz
);

create index if not exists courtlistener_citation_lookup_idx
  on public.courtlistener_citation_index(volume, reporter, page);

create index if not exists courtlistener_citation_cluster_idx
  on public.courtlistener_citation_index(cluster_id);

alter table public.courtlistener_citation_index enable row level security;

create table if not exists public.courtlistener_opinion_cluster_index (
  id bigint primary key,
  case_name text,
  case_name_short text,
  case_name_full text,
  slug text,
  date_filed date,
  citation_count integer,
  precedential_status text,
  filepath_pdf_harvard text,
  filepath_json_harvard text,
  docket_id bigint
);

alter table public.courtlistener_opinion_cluster_index enable row level security;

-- ---------------------------------------------------------------------------
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.library_folders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.workflow_shares from anon, authenticated;
revoke all on public.workflow_open_source_submissions from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.user_mcp_connectors from anon, authenticated;
revoke all on public.user_mcp_oauth_tokens from anon, authenticated;
revoke all on public.user_mcp_oauth_states from anon, authenticated;
revoke all on public.user_mcp_connector_tools from anon, authenticated;
revoke all on public.user_mcp_tool_audit_logs from anon, authenticated;
revoke all on public.courtlistener_citation_index from anon, authenticated;
revoke all on public.courtlistener_opinion_cluster_index from anon, authenticated;

-- Tables created by this file are owned by the database bootstrap role. The
-- backend connects as service_role, so grant it only the data privileges that
-- the direct browser roles above intentionally do not have. RLS is still
-- enabled as defense in depth; service_role bypasses it for the backend path.
grant select, insert, update, delete
  on all tables in schema public
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;

-- Current bounded collection contracts.
-- One bounded read model for the three flat, user-owned collections.
create index if not exists projects_user_created_page_idx
  on public.projects (user_id, created_at desc, id desc);
create index if not exists workflows_user_created_page_idx
  on public.workflows (user_id, created_at desc, id desc);
create index if not exists workflow_shares_email_workflow_idx
  on public.workflow_shares (lower(shared_with_email), workflow_id);
create index if not exists tabular_reviews_user_created_page_idx
  on public.tabular_reviews (user_id, created_at desc, id desc);
create index if not exists tabular_reviews_project_created_page_idx
  on public.tabular_reviews (project_id, created_at desc, id desc);

create or replace function public.get_collection_page(
  p_resource text, p_user_id text, p_user_email text default null,
  p_q text default '', p_filter text default null,
  p_after_created_at timestamptz default null, p_after_id uuid default null,
  p_limit integer default 51
) returns table (payload jsonb, created_at timestamptz, id uuid)
language plpgsql stable as $$
begin
  if p_resource = 'projects' then return query
    select to_jsonb(x), x.created_at, x.id from (
      select p.*, p.user_id=p_user_id is_owner,
        nullif(trim(up.display_name),'') owner_display_name, null::text owner_email
      from public.projects p left join public.user_profiles up on up.user_id::text=p.user_id
      where (p.user_id=p_user_id or (coalesce(p_user_email,'')<>'' and
          p.shared_with @> jsonb_build_array(p_user_email)))
        and (coalesce(p_filter,'all')='all' or
          (p_filter='mine' and p.user_id=p_user_id) or
          (p_filter='shared-with-me' and p.user_id<>p_user_id))
        and (p_q='' or lower(p.name||' '||coalesce(p.cm_number,'')||' '||
          coalesce(p.practice,'')) like '%'||lower(p_q)||'%')
        and (p_after_created_at is null or (p.created_at,p.id)<(p_after_created_at,p_after_id))
      order by p.created_at desc,p.id desc limit least(p_limit,201)) x;
  elsif p_resource = 'workflows' then return query
    select to_jsonb(x), x.created_at, x.id from (
      select w.id,w.user_id::text user_id,w.title,w.type,w.language,w.practice,
        w.jurisdictions,false is_system,w.created_at,w.user_id::text=p_user_id is_owner,
        case when w.user_id::text=p_user_id then true else coalesce((select bool_or(s.allow_edit)
          from public.workflow_shares s where s.workflow_id=w.id and
          lower(s.shared_with_email)=lower(coalesce(p_user_email,''))),false) end allow_edit,
        case when w.user_id::text=p_user_id then null else nullif(trim(up.display_name),'') end shared_by_name
      from public.workflows w left join public.user_profiles up on up.user_id::text=w.user_id::text
      where (w.user_id::text=p_user_id or exists(select 1 from public.workflow_shares s
          where s.workflow_id=w.id and lower(s.shared_with_email)=lower(coalesce(p_user_email,''))))
        and (p_filter is null or w.type=p_filter) and (p_q='' or lower(w.title) like '%'||lower(p_q)||'%')
        and (p_after_created_at is null or (w.created_at,w.id)<(p_after_created_at,p_after_id))
      order by w.created_at desc,w.id desc limit least(p_limit,201)) x;
  elsif p_resource = 'tabular' then return query
    select to_jsonb(x), x.created_at, x.id from (
      select tr.id,tr.user_id,tr.project_id,p.name project_name,tr.title,tr.workflow_id,
        tr.shared_with,tr.user_id=p_user_id is_owner,tr.created_at,tr.updated_at,
        jsonb_array_length(coalesce(tr.document_ids,'[]')) document_count,
        jsonb_array_length(coalesce(tr.columns_config,'[]')) column_count
      from public.tabular_reviews tr left join public.projects p on p.id=tr.project_id
      where (tr.user_id=p_user_id or (coalesce(p_user_email,'')<>'' and
          tr.shared_with @> jsonb_build_array(p_user_email)))
        and (p_filter is null or tr.project_id::text=p_filter or
          (p_filter='in-project' and tr.project_id is not null) or
          (p_filter='standalone' and tr.project_id is null))
        and (p_q='' or lower(coalesce(tr.title,'')) like '%'||lower(p_q)||'%')
        and (p_after_created_at is null or (tr.created_at,tr.id)<(p_after_created_at,p_after_id))
      order by tr.created_at desc,tr.id desc limit least(p_limit,201)) x;
  else raise exception 'unknown collection'; end if;
end $$;

create extension if not exists pg_trgm;
create index if not exists document_versions_filename_trgm_idx
  on public.document_versions using gin(lower(filename) gin_trgm_ops) where deleted_at is null;
create index if not exists document_versions_filename_page_idx
  on public.document_versions(lower(filename),id) where deleted_at is null;
create index if not exists documents_current_version_idx
  on public.documents(current_version_id);
create index if not exists library_folders_page_idx
  on public.library_folders(user_id,library_kind,parent_folder_id,lower(name),id);
create index if not exists project_subfolders_page_idx
  on public.project_subfolders(project_id,parent_folder_id,lower(name),id);

create or replace function public.get_directory_page(
  p_user_id text,p_user_email text default null,p_project_id uuid default null,
  p_library_kind text default null,p_parent_id uuid default null,p_q text default '',
  p_documents_only boolean default false,p_after_bucket integer default null,
  p_after_name text default null,p_after_id uuid default null,p_limit integer default 51
) returns table(kind text,id uuid,bucket integer,sort_name text,payload jsonb)
language plpgsql stable as $$ declare n integer:=0; permitted boolean;
begin
  select p_project_id is null or exists(select 1 from public.projects p
    where p.id=p_project_id and (p.user_id=p_user_id or
      (coalesce(p_user_email,'')<>'' and p.shared_with @> jsonb_build_array(p_user_email))))
    into permitted;
  if not permitted then return; end if;
  if not p_documents_only and p_q='' and coalesce(p_after_bucket,0)=0 then
    if p_project_id is null then return query select 'folder',f.id,0,lower(f.name),to_jsonb(f)
      from public.library_folders f where f.user_id=p_user_id and f.library_kind=p_library_kind
        and f.parent_folder_id is not distinct from p_parent_id and (p_after_bucket is null or
          (lower(f.name),f.id)>(p_after_name,p_after_id))
      order by lower(f.name),f.id limit least(p_limit,201);
    else return query select 'folder',f.id,0,lower(f.name),to_jsonb(f)
      from public.project_subfolders f where f.project_id=p_project_id
        and f.parent_folder_id is not distinct from p_parent_id and (p_after_bucket is null or
          (lower(f.name),f.id)>(p_after_name,p_after_id))
      order by lower(f.name),f.id limit least(p_limit,201); end if;
    get diagnostics n=row_count;
  end if;
  if n<least(p_limit,201) then return query select 'document',v.id,1,lower(v.filename),
    jsonb_build_object('id',d.id,'user_id',d.user_id,'project_id',d.project_id,
      'library_kind',d.library_kind,'library_folder_id',d.library_folder_id,
      'folder_id',coalesce(d.folder_id,d.library_folder_id),'status',d.status,
      'metadata',d.metadata,'notes',d.notes,
      'created_at',d.created_at,'updated_at',d.updated_at,
      'current_version_id',d.current_version_id,'active_version_number',v.version_number,
      'filename',v.filename,'file_type',v.file_type,'size_bytes',v.size_bytes,'page_count',v.page_count)
    from public.document_versions v join public.documents d on d.current_version_id=v.id
    where v.deleted_at is null and ((p_project_id is null and d.user_id=p_user_id and
      d.project_id is null and d.library_kind=p_library_kind) or d.project_id=p_project_id)
      and (p_documents_only or p_q<>'' or coalesce(d.folder_id,d.library_folder_id)
        is not distinct from p_parent_id) and (p_q='' or lower(v.filename) like '%'||lower(p_q)||'%')
      and (p_after_bucket is null or p_after_bucket=0 or
        (lower(v.filename),v.id)>(p_after_name,p_after_id))
    order by lower(v.filename),v.id limit least(p_limit,201)-n; end if;
end
$$;

create or replace function public.get_project_folder_document_ids(p_project_id uuid,p_folder_id uuid)
returns table(id uuid) language sql stable as $$
  with recursive folders(id) as (select p_folder_id union select f.id
    from public.project_subfolders f join folders p on f.parent_folder_id=p.id
    where f.project_id=p_project_id)
  select d.id from public.documents d where d.project_id=p_project_id and d.folder_id in(select id from folders)
$$;
create or replace function public.get_library_folder_document_ids(p_user_id text,p_kind text,p_folder_id uuid)
returns table(id uuid) language sql stable as $$
  with recursive folders(id) as (select p_folder_id union select f.id
    from public.library_folders f join folders p on f.parent_folder_id=p.id
    where f.user_id=p_user_id and f.library_kind=p_kind)
  select d.id from public.documents d where d.user_id=p_user_id and d.project_id is null
    and d.library_kind=p_kind and d.library_folder_id in(select id from folders)
$$;
