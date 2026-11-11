-- =====================================================================
-- 002: plan versions as child submissions, and origin hub on the profile.
--
-- Model:
--   * A plan's first submission is a "root" row (parent_id is null).
--   * "Edit Existing Plan" on an approved, published or superseded plan creates a
--     new child row (parent_id = the plan it started from, root_id = the root).
--     The child is a draft with the same data, status 'draft', version n.
--   * Submitting the child moves it to 'pending'. The approved version stays
--     published until the child is approved AND published.
--   * Publishing a child marks the other published rows in the same lineage as
--     'superseded' (approved_plans.is_published = false for them).
--   * Existing rows are unchanged: root_id, parent_id are null for them.
-- =====================================================================

alter type public.submission_status add value if not exists 'superseded';

alter table public.submissions
  add column if not exists parent_id uuid references public.submissions(id) on delete cascade,
  add column if not exists root_id   uuid references public.submissions(id) on delete cascade;
create index if not exists submissions_root_idx on public.submissions (root_id);

alter table public.profiles add column if not exists last_origin_dc text not null default '';
grant update (last_origin_dc) on public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- Planner: start a new version of an existing plan.
-- ---------------------------------------------------------------------
create or replace function public.start_new_version(p_parent uuid)
returns public.submissions language plpgsql security definer set search_path = '' as $$
declare p public.submissions; root_row public.submissions; n int; s public.submissions;
begin
  select * into p from public.submissions where id = p_parent;
  if not found or p.user_id is distinct from auth.uid() then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if p.status not in ('approved', 'published', 'superseded') then
    raise exception 'Only an approved or published plan can be edited (this one is %).', replace(p.status::text, '_', ' ');
  end if;
  if p.root_id is null then
    root_row := p;
  else
    select * into root_row from public.submissions where id = p.root_id;
  end if;
  if exists (select 1 from public.submissions
              where (id = root_row.id or root_id = root_row.id) and status in ('draft', 'pending', 'changes_requested')) then
    raise exception 'A new version of % is already in progress. Finish or withdraw it first.', root_row.plan_code;
  end if;
  select coalesce(max(version), 0) + 1 into n
    from public.submissions where id = root_row.id or root_id = root_row.id;
  insert into public.submissions
    (user_id, plan_code, origin_dc, plan_date, created_by_name, data, status, version, parent_id, root_id)
  values
    (p.user_id, root_row.plan_code || '-V' || n, p.origin_dc, p.plan_date, p.created_by_name, p.data,
     'draft', n, p.id, root_row.id)
  returning * into s;
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Planner submit: a version keeps the version number it was created with.
-- ---------------------------------------------------------------------
create or replace function public.submit_submission(p_id uuid)
returns public.submissions language plpgsql security definer set search_path = '' as $$
declare s public.submissions;
begin
  select * into s from public.submissions where id = p_id for update;
  if not found or s.user_id is distinct from auth.uid() then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if s.status not in ('draft', 'changes_requested') then
    raise exception 'This plan is already %. Start a new plan to make changes.', replace(s.status::text, '_', ' ');
  end if;
  if not public.rows_ok(s.data) then
    raise exception 'The plan has no lanes. Load the data sources and save again.';
  end if;
  if coalesce(trim(s.created_by_name), '') = '' then
    raise exception 'Type your name first. It is recorded with the plan.';
  end if;
  update public.submissions
     set status = 'pending',
         version = case when s.parent_id is null then s.version + 1 else s.version end,
         submitted_at = now(), decided_at = null, decided_by = null
   where id = p_id returning * into s;
  insert into public.submission_versions
    (submission_id, version, origin_dc, plan_date, created_by_name, data, submitted_by)
  values (s.id, s.version, s.origin_dc, s.plan_date, s.created_by_name, s.data, auth.uid());
  insert into public.plan_events (submission_id, origin_dc, event) values (s.id, s.origin_dc, 'submitted');
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Publishing a version retires the previously published one in its lineage.
-- ---------------------------------------------------------------------
create or replace function public.supersede_lineage(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r uuid := (select coalesce(root_id, id) from public.submissions where id = p_id);
begin
  update public.approved_plans set is_published = false, published_by = null, published_at = null
   where submission_id in (select id from public.submissions
                            where (id = r or root_id = r) and id <> p_id);
  update public.submissions set status = 'superseded'
   where (id = r or root_id = r) and id <> p_id and status = 'published';
end $$;

-- approve_submission: when publishing, retire the older published version.
create or replace function public.approve_submission(p_id uuid, p_final jsonb, p_publish boolean default false)
returns public.approved_plans language plpgsql security definer set search_path = '' as $$
declare s public.submissions; a public.approved_plans; nm text;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  select * into s from public.submissions where id = p_id for update;
  if not found then raise exception 'Submission not found.'; end if;
  if s.status not in ('pending', 'approved', 'published') then
    raise exception 'Only pending or approved plans can be approved (this one is %).', replace(s.status::text, '_', ' ');
  end if;
  if not public.rows_ok(p_final) then raise exception 'The approved plan has no lanes.'; end if;
  select coalesce(nullif(full_name, ''), email, '') into nm from public.profiles where id = auth.uid();

  insert into public.submission_reviews (submission_id, draft_data, updated_by)
  values (p_id, p_final, auth.uid())
  on conflict (submission_id) do update set draft_data = excluded.draft_data, updated_by = excluded.updated_by;

  insert into public.approved_plans as ap
    (submission_id, plan_code, origin_dc, plan_date, version, submitted_by_name, final_data,
     approved_by, approved_by_name, approved_at, is_published, published_by, published_at)
  values
    (s.id, s.plan_code, s.origin_dc, s.plan_date, s.version, s.created_by_name, p_final,
     auth.uid(), nm, now(), p_publish,
     case when p_publish then auth.uid() end, case when p_publish then now() end)
  on conflict (submission_id) do update set
     plan_code = excluded.plan_code, origin_dc = excluded.origin_dc, plan_date = excluded.plan_date,
     version = excluded.version, submitted_by_name = excluded.submitted_by_name,
     final_data = excluded.final_data, approved_by = excluded.approved_by,
     approved_by_name = excluded.approved_by_name, approved_at = excluded.approved_at,
     is_published = excluded.is_published,
     published_by = case when excluded.is_published then excluded.published_by end,
     published_at = case when excluded.is_published then excluded.published_at end
  returning * into a;

  if p_publish then perform public.supersede_lineage(p_id); end if;

  update public.submissions
     set status = case when p_publish then 'published'::public.submission_status else 'approved' end,
         decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  insert into public.plan_events (submission_id, origin_dc, event)
  values (s.id, s.origin_dc, case when p_publish then 'published' else 'approved' end);
  return a;
end $$;

-- publish_submission: same rule when a version is published later.
create or replace function public.publish_submission(p_id uuid, p_publish boolean default true)
returns public.approved_plans language plpgsql security definer set search_path = '' as $$
declare a public.approved_plans;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  if p_publish then perform public.supersede_lineage(p_id); end if;
  update public.approved_plans
     set is_published = p_publish,
         published_by = case when p_publish then auth.uid() end,
         published_at = case when p_publish then now() end
   where submission_id = p_id returning * into a;
  if not found then raise exception 'Approve the plan before publishing it.'; end if;
  update public.submissions
     set status = case when p_publish then 'published'::public.submission_status else 'approved' end,
         decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  insert into public.plan_events (submission_id, origin_dc, event)
  values (p_id, a.origin_dc, case when p_publish then 'published' else 'unpublished' end);
  return a;
end $$;

revoke all on function public.start_new_version(uuid)     from public, anon;
revoke all on function public.supersede_lineage(uuid)     from public, anon, authenticated;
grant execute on function public.start_new_version(uuid)  to authenticated;
