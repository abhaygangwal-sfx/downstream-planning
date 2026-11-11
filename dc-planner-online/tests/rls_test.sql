-- RLS / RPC behaviour tests. Run against a scratch database after tests/supabase_stub.sql and the migration.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a', 'alice@dc.test', '{"full_name":"Alice"}'),
 ('00000000-0000-0000-0000-00000000000b', 'bob@dc.test',   '{"full_name":"Bob"}'),
 ('00000000-0000-0000-0000-00000000000c', 'carol@dc.test', '{}'),
 ('00000000-0000-0000-0000-0000000000ad', 'lh@dc.test',    '{"full_name":"LH Admin"}');
update public.user_roles set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000ad';
delete from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000c';  -- carol: no access

create schema if not exists t;
create or replace function t.as_user(u text) returns void language sql as
$$ select set_config('request.jwt.claim.sub', u, false); $$;
create or replace function t.fails(q text, expect text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlerrm ilike '%'||expect||'%' then raise notice 'ok  (refused: %)', sqlerrm; return; end if;
    raise exception 'wrong error for [%]: %', q, sqlerrm;
  end;
  raise exception 'expected failure but succeeded: %', q;
end $$;
create or replace function t.check(cond boolean, label text) returns void language plpgsql as $$
begin if not cond then raise exception 'FAILED: %', label; end if; raise notice 'ok  %', label; end $$;
grant usage on schema t to anon, authenticated; grant execute on all functions in schema t to anon, authenticated;
set client_min_messages = notice;

-- ===== Alice (planner) =====
set role authenticated;
select t.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.submissions (origin_dc, created_by_name, data) values ('Kolkata DC', 'Alice', '{}');
select t.check((select count(*) = 1 and bool_and(status = 'draft' and user_id = auth.uid()) from public.submissions), 'alice creates her own draft');
select t.fails($q$insert into public.submissions (origin_dc, status) values ('x', 'pending')$q$, 'permission denied');
select t.fails($q$insert into public.submissions (user_id, origin_dc) values ('00000000-0000-0000-0000-00000000000b', 'x')$q$, 'permission denied');
select t.fails($q$update public.submissions set status = 'published'$q$, 'permission denied');
select t.fails($q$update public.user_roles set role = 'admin'$q$, 'permission denied');
select t.fails($q$insert into public.user_roles (user_id, role) values (auth.uid(), 'admin')$q$, 'permission denied');
select t.fails($q$select public.submit_submission((select id from public.submissions limit 1))$q$, 'no lanes');
update public.submissions set data = '{"rows":[{"lane":"Kolkata DC-Malda DC","total_awb":10,"total_volumetric":12.5,"dc_vehicle":"32 FT"}],"lane_plan":{}}';
select t.check((select (public.submit_submission(id)).status = 'pending' from public.submissions limit 1), 'alice submits → pending');
select t.check((select version = 1 and submitted_at is not null from public.submissions limit 1), 'version 1 stamped');
select t.check((select count(*) = 1 from public.submission_versions), 'original frozen in submission_versions');
update public.submissions set data = '{"rows":[]}';
select t.check((select data->'rows'->0->>'lane' = 'Kolkata DC-Malda DC' from public.submissions limit 1), 'pending plan cannot be edited by its owner');
delete from public.submissions;
select t.check((select count(*) = 1 from public.submissions), 'pending plan cannot be deleted by its owner');
select t.fails($q$select public.approve_submission((select id from public.submissions limit 1), '{"rows":[{}]}', true)$q$, 'Admins only');
select t.fails($q$select public.admin_save_review((select id from public.submissions limit 1), '{"rows":[{}]}')$q$, 'Admins only');
select t.fails($q$insert into public.approved_plans (submission_id, plan_code, origin_dc, plan_date, version, final_data) select id, 'x','x',now(),1,'{}' from public.submissions$q$, 'permission denied');
insert into public.submissions (origin_dc, created_by_name, data) values ('Kolkata DC', 'Alice', '{"rows":[{"lane":"a"}]}');  -- a second, private draft

-- ===== Bob (another planner) =====
select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.check((select count(*) = 0 from public.submissions), 'bob cannot see alice''s drafts or submissions');
update public.submissions set created_by_name = 'hacked';
delete from public.submissions;
select t.check((select count(*) = 0 from public.submission_versions), 'bob cannot see alice''s versions');
select t.check((select count(*) = 0 from public.approved_plans), 'nothing published yet for bob');
select t.fails($q$insert into public.submission_comments (submission_id, body) select id, 'hi' from (select '00000000-0000-0000-0000-000000000000'::uuid id) x$q$, 'row-level security');

-- ===== LH admin =====
select t.as_user('00000000-0000-0000-0000-0000000000ad');
select t.check((select count(*) = 1 and bool_and(status = 'pending') from public.submissions), 'admin sees submitted records but not private drafts');
select t.check((select lane_count = 1 from public.submissions), 'lane_count computed');
select t.check((select created_by_name = 'Alice' from public.submissions where status = 'pending'), 'bob''s update did not land');
select t.fails($q$select public.admin_save_review((select id from public.submissions where created_at is null), '{"rows":[{}]}')$q$, 'not found');
update public.submissions set data = '{}' where status = 'draft';
select public.admin_save_review((select id from public.submissions where status = 'pending'),
  '{"rows":[{"lane":"Kolkata DC-Malda DC","total_awb":10,"total_volumetric":12.5,"dc_vehicle":"32 FT","approved_vehicle":"22 FT","approved_vehicle_count":2,"approved_remarks":"ok"}]}');
insert into public.submission_comments (submission_id, body) select id, 'Changed to 22 FT x2' from public.submissions where status = 'pending';
select t.check((select is_published from public.approve_submission((select id from public.submissions where status = 'pending'),
  (select draft_data from public.submission_reviews limit 1), true)), 'admin approves & publishes');
select t.check((select status = 'published' from public.submissions where version = 1), 'status published');
select t.check((select data->'rows'->0->>'dc_vehicle' = '32 FT' and data->'rows'->0->>'approved_vehicle' is null from public.submissions where version = 1), 'planner original data untouched');
select t.check((select final_data->'rows'->0->>'approved_vehicle' = '22 FT' and approved_by_name = 'LH Admin' from public.approved_plans), 'final edited data stored separately');
update public.submissions set data = '{}';
select t.check((select data->'rows'->0->>'dc_vehicle' = '32 FT' from public.submissions where version = 1), 'admin cannot overwrite the planner''s original');

-- ===== Bob again: sees the published plan, not the private draft =====
select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.check((select count(*) = 1 from public.approved_plans where is_published), 'published plan visible to every member');
select t.check((select count(*) = 0 from public.submission_comments), 'bob cannot read comments on alice''s plan');
select t.check((select count(*) >= 2 from public.plan_events), 'live feed visible to members');

-- ===== Alice: sees comment, replies =====
select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.check((select count(*) = 1 and bool_and(is_admin and author_name = 'LH Admin') from public.submission_comments), 'alice sees the admin comment');
insert into public.submission_comments (submission_id, body) select id, 'Thanks' from public.submissions where status = 'published';
select t.check((select not is_admin and author_id = auth.uid() and author_name = 'Alice' from public.submission_comments where body = 'Thanks'), 'author fields are set by the server');
select t.fails($q$insert into public.submission_comments (submission_id, body) select id, 'x' from public.submissions where status = 'draft'$q$, 'row-level security');

-- ===== Admin sends it back =====
select t.as_user('00000000-0000-0000-0000-0000000000ad');
select public.return_submission((select id from public.submissions where version = 1), 'changes_requested', 'Please recheck Malda');
select t.check((select not is_published from public.approved_plans), 'returning withdraws the published version');
select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.check((select count(*) = 0 from public.approved_plans), 'bob no longer sees it');

-- ===== Alice revises and resubmits =====
select t.as_user('00000000-0000-0000-0000-00000000000a');
update public.submissions set data = '{"rows":[{"lane":"Kolkata DC-Malda DC","total_awb":11}]}' where status = 'changes_requested';
select t.check((select (public.submit_submission(id)).version = 2 from public.submissions where status = 'changes_requested'), 'resubmitted as version 2');
select t.check((select count(*) = 2 from public.submission_versions), 'both originals kept');
select t.check((select count(*) = 1 from public.approved_plans), 'owner still sees her earlier approval');
delete from public.submissions where status = 'draft';
select t.check((select count(*) = 1 from public.submissions), 'alice can delete her own draft');

-- ===== Carol (account without a role) =====
select t.as_user('00000000-0000-0000-0000-00000000000c');
select t.fails($q$insert into public.submissions (origin_dc) values ('x')$q$, 'row-level security');
select t.check((select count(*) = 0 from public.plan_events), 'no-role account sees no feed');

-- ===== anon =====
reset role; set role anon;
select t.fails($q$select * from public.submissions$q$, 'permission denied');
select t.fails($q$select * from public.approved_plans$q$, 'permission denied');
select t.fails($q$select public.submit_submission('00000000-0000-0000-0000-000000000000')$q$, 'permission denied');
reset role;
select 'ALL RLS TESTS PASSED' as result;
