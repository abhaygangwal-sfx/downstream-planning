-- =====================================================================
-- DC Planner (Downstream Planning) — Supabase schema, RLS and RPCs
-- Run once in Supabase → SQL Editor (or `supabase db push`).
-- Safe to re-run: objects are created with IF NOT EXISTS / OR REPLACE.
--
-- Data flow
--   submissions          the planner's own plan (draft → pending). The
--                        planner's data is never changed by an admin.
--   submission_versions  frozen copy of what the planner submitted, one
--                        row per submit (the "original" record).
--   submission_reviews   the admin's working copy while editing.
--   approved_plans       the final, admin-approved data; visible to every
--                        signed-in member once is_published = true.
--   submission_comments  admin ↔ planner comments on a submission.
--   plan_events          id-only feed so every open page refreshes live
--                        (also covers un-publish, which RLS would hide).
-- =====================================================================

-- ---------- types ----------
do $$ begin
  create type public.app_role as enum ('user', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.submission_status as enum
    ('draft', 'pending', 'changes_requested', 'rejected', 'approved', 'published');
exception when duplicate_object then null; end $$;

-- ---------- profiles & roles ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text not null default '',
  created_at  timestamptz not null default now()
);

-- Roles live in their own table. The browser can read its own row but can
-- never insert/update/delete here; roles are changed only from the SQL
-- editor / service role (see supabase/manage_roles.sql).
create table if not exists public.user_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        public.app_role not null default 'user',
  created_at  timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r
                 where r.user_id = auth.uid() and r.role = 'admin');
$$;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid());
$$;

-- Every new auth user gets a profile and the plain 'user' role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'user')
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts that existed before this migration.
insert into public.profiles (id, email)
  select id, email from auth.users on conflict (id) do nothing;
insert into public.user_roles (user_id)
  select id from auth.users on conflict (user_id) do nothing;

-- ---------- helpers ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------- submissions (planner-owned) ----------
create table if not exists public.submissions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  plan_code        text not null unique default
                     ('P' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD') || '-' ||
                      substr(md5(gen_random_uuid()::text), 1, 5)),
  origin_dc        text not null default '',
  plan_date        date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_by_name  text not null default '',
  data             jsonb not null default '{}'::jsonb,
  status           public.submission_status not null default 'draft',
  version          int  not null default 0,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  lane_count       int generated always as (
                     case when jsonb_typeof(data -> 'rows') = 'array'
                          then jsonb_array_length(data -> 'rows') else 0 end) stored,
  constraint submissions_data_object check (jsonb_typeof(data) = 'object'),
  constraint submissions_data_size   check (octet_length(data::text) < 2000000)
);
create index if not exists submissions_user_idx   on public.submissions (user_id, updated_at desc);
create index if not exists submissions_status_idx on public.submissions (status, updated_at desc);
drop trigger if exists submissions_touch on public.submissions;
create trigger submissions_touch before update on public.submissions
  for each row execute function public.touch_updated_at();

-- ---------- frozen originals ----------
create table if not exists public.submission_versions (
  id               bigint generated always as identity primary key,
  submission_id    uuid not null references public.submissions(id) on delete cascade,
  version          int  not null,
  origin_dc        text not null,
  plan_date        date not null,
  created_by_name  text not null,
  data             jsonb not null,
  submitted_by     uuid not null references public.profiles(id),
  submitted_at     timestamptz not null default now(),
  unique (submission_id, version)
);

-- ---------- admin working copy ----------
create table if not exists public.submission_reviews (
  submission_id  uuid primary key references public.submissions(id) on delete cascade,
  draft_data     jsonb not null,
  updated_by     uuid references public.profiles(id),
  updated_at     timestamptz not null default now(),
  constraint reviews_data_object check (jsonb_typeof(draft_data) = 'object')
);
drop trigger if exists reviews_touch on public.submission_reviews;
create trigger reviews_touch before update on public.submission_reviews
  for each row execute function public.touch_updated_at();

-- ---------- approved / published ----------
create table if not exists public.approved_plans (
  submission_id      uuid primary key references public.submissions(id) on delete cascade,
  plan_code          text not null,
  origin_dc          text not null,
  plan_date          date not null,
  version            int  not null,
  submitted_by_name  text not null default '',
  final_data         jsonb not null,
  approved_by        uuid references public.profiles(id),
  approved_by_name   text not null default '',
  approved_at        timestamptz not null default now(),
  is_published       boolean not null default false,
  published_by       uuid references public.profiles(id),
  published_at       timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists approved_pub_idx on public.approved_plans (is_published, origin_dc, published_at desc);
drop trigger if exists approved_touch on public.approved_plans;
create trigger approved_touch before update on public.approved_plans
  for each row execute function public.touch_updated_at();

-- ---------- comments ----------
create table if not exists public.submission_comments (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.submissions(id) on delete cascade,
  author_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  author_name    text not null default '',
  is_admin       boolean not null default false,
  body           text not null check (char_length(body) between 1 and 4000),
  created_at     timestamptz not null default now()
);
create index if not exists comments_sub_idx on public.submission_comments (submission_id, created_at);

-- author, name and admin flag are always set by the server, never by the client
create or replace function public.comment_fill()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.author_id := auth.uid();
  new.is_admin  := public.is_admin();
  select coalesce(nullif(p.full_name, ''), p.email, '') into new.author_name
    from public.profiles p where p.id = auth.uid();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists comments_fill on public.submission_comments;
create trigger comments_fill before insert on public.submission_comments
  for each row execute function public.comment_fill();

-- ---------- live feed (ids only) ----------
create table if not exists public.plan_events (
  id             bigint generated always as identity primary key,
  submission_id  uuid not null,
  origin_dc      text not null default '',
  event          text not null,
  created_at     timestamptz not null default now()
);

-- =====================================================================
-- Privileges. Supabase grants ALL to anon/authenticated by default;
-- start from nothing and grant only what the browser needs.
-- =====================================================================
revoke all on public.profiles, public.user_roles, public.submissions, public.submission_versions,
              public.submission_reviews, public.approved_plans, public.submission_comments,
              public.plan_events
  from anon, authenticated;

grant select on public.profiles, public.user_roles, public.submissions, public.submission_versions,
               public.submission_reviews, public.approved_plans, public.submission_comments,
               public.plan_events
  to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant insert (origin_dc, plan_date, created_by_name, data) on public.submissions to authenticated;
grant update (origin_dc, plan_date, created_by_name, data) on public.submissions to authenticated;
grant delete on public.submissions to authenticated;
grant insert (submission_id, body) on public.submission_comments to authenticated;
-- submission_versions, submission_reviews, approved_plans and plan_events are written only by the
-- SECURITY DEFINER functions below.

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles            enable row level security;
alter table public.user_roles          enable row level security;
alter table public.submissions         enable row level security;
alter table public.submission_versions enable row level security;
alter table public.submission_reviews  enable row level security;
alter table public.approved_plans      enable row level security;
alter table public.submission_comments enable row level security;
alter table public.plan_events         enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists roles_select on public.user_roles;
create policy roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Planners see only their own submissions (drafts included). Admins see every
-- submitted record, but not other people's private drafts.
drop policy if exists subs_select on public.submissions;
create policy subs_select on public.submissions for select to authenticated
  using (user_id = auth.uid() or (public.is_admin() and status <> 'draft'));
-- New rows are always the caller's own draft.
drop policy if exists subs_insert on public.submissions;
create policy subs_insert on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and status = 'draft' and public.is_member());
-- Planners may edit only while it is theirs and still a draft / sent back for changes.
-- Status itself is not updatable by the browser (no column grant): use submit_submission().
drop policy if exists subs_update on public.submissions;
create policy subs_update on public.submissions for update to authenticated
  using      (user_id = auth.uid() and status in ('draft', 'changes_requested'))
  with check (user_id = auth.uid() and status in ('draft', 'changes_requested'));
drop policy if exists subs_delete on public.submissions;
create policy subs_delete on public.submissions for delete to authenticated
  using (user_id = auth.uid() and status = 'draft');

drop policy if exists versions_select on public.submission_versions;
create policy versions_select on public.submission_versions for select to authenticated
  using (public.is_admin() or exists (select 1 from public.submissions s
                                      where s.id = submission_id and s.user_id = auth.uid()));

drop policy if exists reviews_select on public.submission_reviews;
create policy reviews_select on public.submission_reviews for select to authenticated
  using (public.is_admin());

-- Published plans: every member. Unpublished approvals: admins and the plan's owner.
drop policy if exists approved_select on public.approved_plans;
create policy approved_select on public.approved_plans for select to authenticated
  using (public.is_admin()
         or (is_published and public.is_member())
         or exists (select 1 from public.submissions s
                    where s.id = submission_id and s.user_id = auth.uid()));

drop policy if exists comments_select on public.submission_comments;
create policy comments_select on public.submission_comments for select to authenticated
  using (public.is_admin() or exists (select 1 from public.submissions s
                                      where s.id = submission_id and s.user_id = auth.uid()));
drop policy if exists comments_insert on public.submission_comments;
create policy comments_insert on public.submission_comments for insert to authenticated
  with check (public.is_admin() or exists (select 1 from public.submissions s
                                           where s.id = submission_id and s.user_id = auth.uid()
                                             and s.status <> 'draft'));

drop policy if exists events_select on public.plan_events;
create policy events_select on public.plan_events for select to authenticated
  using (public.is_member());

-- =====================================================================
-- RPCs (the only way to change status or publish)
-- =====================================================================
create or replace function public.rows_ok(d jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(d -> 'rows') = 'array' and jsonb_array_length(d -> 'rows') > 0, false);
$$;

-- Planner: send a draft (or a plan sent back for changes) to the LH team.
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
     set status = 'pending', version = s.version + 1, submitted_at = now(),
         decided_at = null, decided_by = null
   where id = p_id returning * into s;
  insert into public.submission_versions
    (submission_id, version, origin_dc, plan_date, created_by_name, data, submitted_by)
  values (s.id, s.version, s.origin_dc, s.plan_date, s.created_by_name, s.data, auth.uid());
  insert into public.plan_events (submission_id, origin_dc, event) values (s.id, s.origin_dc, 'submitted');
  return s;
end $$;

-- Admin: save edits without deciding yet.
create or replace function public.admin_save_review(p_id uuid, p_data jsonb)
returns public.submission_reviews language plpgsql security definer set search_path = '' as $$
declare r public.submission_reviews; st public.submission_status;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  select status into st from public.submissions where id = p_id;
  if st is null then raise exception 'Submission not found.'; end if;
  if st = 'draft' then raise exception 'Drafts cannot be reviewed until they are submitted.'; end if;
  if not public.rows_ok(p_data) then raise exception 'The edited plan has no lanes.'; end if;
  insert into public.submission_reviews (submission_id, draft_data, updated_by)
  values (p_id, p_data, auth.uid())
  on conflict (submission_id) do update set draft_data = excluded.draft_data, updated_by = excluded.updated_by
  returning * into r;
  return r;
end $$;

-- Admin: approve the (edited) plan; optionally publish it in the same step.
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

  update public.submissions
     set status = case when p_publish then 'published'::public.submission_status else 'approved' end,
         decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  insert into public.plan_events (submission_id, origin_dc, event)
  values (s.id, s.origin_dc, case when p_publish then 'published' else 'approved' end);
  return a;
end $$;

create or replace function public.publish_submission(p_id uuid, p_publish boolean default true)
returns public.approved_plans language plpgsql security definer set search_path = '' as $$
declare a public.approved_plans;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
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

-- Admin: send back for changes, or reject. Withdraws any published version.
create or replace function public.return_submission(p_id uuid, p_status text, p_comment text default '')
returns public.submissions language plpgsql security definer set search_path = '' as $$
declare s public.submissions;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  if p_status not in ('changes_requested', 'rejected') then raise exception 'Unknown status %.', p_status; end if;
  select * into s from public.submissions where id = p_id for update;
  if not found then raise exception 'Submission not found.'; end if;
  if s.status = 'draft' then raise exception 'Drafts cannot be returned.'; end if;
  update public.approved_plans set is_published = false, published_by = null, published_at = null
   where submission_id = p_id;
  update public.submissions
     set status = p_status::public.submission_status, decided_at = now(), decided_by = auth.uid()
   where id = p_id returning * into s;
  if coalesce(trim(p_comment), '') <> '' then
    insert into public.submission_comments (submission_id, body) values (p_id, trim(p_comment));
  end if;
  insert into public.plan_events (submission_id, origin_dc, event) values (p_id, s.origin_dc, p_status);
  return s;
end $$;

revoke all on function public.submit_submission(uuid)                  from public, anon;
revoke all on function public.admin_save_review(uuid, jsonb)           from public, anon;
revoke all on function public.approve_submission(uuid, jsonb, boolean) from public, anon;
revoke all on function public.publish_submission(uuid, boolean)        from public, anon;
revoke all on function public.return_submission(uuid, text, text)      from public, anon;
revoke all on function public.handle_new_user()                        from public, anon, authenticated;
revoke all on function public.comment_fill()                           from public, anon, authenticated;
grant execute on function public.submit_submission(uuid)                  to authenticated;
grant execute on function public.admin_save_review(uuid, jsonb)           to authenticated;
grant execute on function public.approve_submission(uuid, jsonb, boolean) to authenticated;
grant execute on function public.publish_submission(uuid, boolean)        to authenticated;
grant execute on function public.return_submission(uuid, text, text)      to authenticated;
grant execute on function public.is_admin(), public.is_member()           to authenticated;

-- =====================================================================
-- Realtime: RLS decides which rows each subscriber receives.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['submissions', 'approved_plans', 'submission_comments', 'plan_events'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
