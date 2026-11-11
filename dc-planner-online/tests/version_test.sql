-- Plan versions (migration 002). Run after 001 and 002 on a scratch database that already has the RLS test users.
-- Expects the users created by tests/rls_test.sql. Run it after rls_test.sql in the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role postgres;
create schema if not exists t;
create or replace function t.as_user(u text) returns void language sql as
$$ select set_config('request.jwt.claim.sub', u, false); $$;
create or replace function t.check(cond boolean, label text) returns void language plpgsql as $$
begin if not cond then raise exception 'FAILED: %', label; end if; raise notice 'ok  %', label; end $$;
grant usage on schema t to anon, authenticated; grant execute on all functions in schema t to anon, authenticated;
set client_min_messages = notice;

-- Alice gets a fresh root plan, submits, and LH approves and publishes v1.
set role authenticated;
select t.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.submissions (origin_dc, created_by_name, data)
  values ('Kolkata DC v', 'Alice', '{"rows":[{"lane":"VX-A","total_awb":5,"dc_vehicle":"32 FT"}],"lane_plan":{}}');
select t.check((select (public.submit_submission(id)).version = 1 from public.submissions where origin_dc = 'Kolkata DC v'), 'root submits as v1');
reset role;
select t.as_user('00000000-0000-0000-0000-0000000000ad');
set role authenticated;
select t.check((select (public.approve_submission(id, data, true)).submission_id is not null from public.submissions where origin_dc = 'Kolkata DC v'), 'LH approves and publishes v1');
select t.check((select status = 'published' from public.submissions where origin_dc = 'Kolkata DC v'), 'v1 is published');

-- Alice starts a new version (V2) of the published plan. The old version must stay published.
select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.check((select count(*) = 1 from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'root row unchanged before editing');
select t.check((select (public.start_new_version(id)).id is not null from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'start_new_version creates V2');
select t.check((select count(*) = 1 from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null and status = 'draft' and version = 2), 'V2 is a draft with version 2');
select t.check((select status = 'published' and is_published from public.submissions s join public.approved_plans a on a.submission_id = s.id where s.origin_dc = 'Kolkata DC v' and s.root_id is null), 'V1 stays published while V2 is a draft');
select t.check((select plan_code like '%-V2' from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null), 'V2 code is root code + -V2');

-- Only one version can be in progress at a time: starting from the root is refused while V2 is a draft.
select t.fails($q$select public.start_new_version((select id from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null))$q$, 'already in progress');
select t.fails($q$select public.start_new_version((select id from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null))$q$, 'Only an approved or published');

-- Bob cannot start a version of Alice's plan.
select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.fails($q$select public.start_new_version((select id from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null))$q$, 'not found');

-- Alice submits V2: still version 2, pending, and V1 still published.
select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.check((select (public.submit_submission(id)).version = 2 from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null), 'V2 submits and keeps version 2');
select t.check((select status = 'published' from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'V1 still published while V2 is pending');
select t.fails($q$select public.start_new_version((select id from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null))$q$, 'Only an approved or published');

-- LH approves V2 without publishing: V1 stays published.
reset role;
select t.as_user('00000000-0000-0000-0000-0000000000ad');
set role authenticated;
select t.check((select (public.approve_submission(id, data, false)).submission_id is not null from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null), 'LH approves V2 without publishing');
select t.check((select status = 'published' from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'V1 stays published after V2 is approved but not published');

-- LH publishes V2: V1 is superseded and unpublished.
select t.check((select (public.publish_submission(id, true)).submission_id is not null from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null), 'LH publishes V2');
select t.check((select status = 'superseded' from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'V1 becomes superseded');
select t.check((select is_published = false from public.approved_plans a join public.submissions s on s.id = a.submission_id where s.origin_dc = 'Kolkata DC v' and s.root_id is null), 'V1 is no longer published');
select t.check((select count(*) = 1 from public.approved_plans a join public.submissions s on s.id = a.submission_id where s.origin_dc = 'Kolkata DC v' and a.is_published), 'exactly one published version');

-- A superseded plan can be edited again: V3.
select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.check((select (public.start_new_version(id)).id is not null from public.submissions where origin_dc = 'Kolkata DC v' and root_id is null), 'V3 starts from the superseded V1');
select t.check((select count(*) = 1 from public.submissions where origin_dc = 'Kolkata DC v' and root_id is not null and version = 3), 'V3 has version 3');

-- Submission history: each version is frozen once submitted.
select t.check((select count(*) = 2 from public.submission_versions v join public.submissions s on s.id = v.submission_id where s.origin_dc = 'Kolkata DC v'), 'two frozen versions (V1 and V2)');
reset role;
