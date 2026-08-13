alter table public.documents
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists notes text;

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
