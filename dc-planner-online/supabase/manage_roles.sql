-- Run these in Supabase → SQL Editor (it runs with full rights, so RLS does not block it).
-- The browser can never change roles.

-- Make an account an admin (LH team). The account must exist first (Authentication → Users → Invite).
update public.user_roles set role = 'admin'
 where user_id = (select id from auth.users where email = 'lh.admin@example.com');

-- Turn an admin back into a normal planner.
-- update public.user_roles set role = 'user'
--  where user_id = (select id from auth.users where email = 'someone@example.com');

-- Remove all access but keep the account (they can sign in but see nothing).
-- delete from public.user_roles
--  where user_id = (select id from auth.users where email = 'someone@example.com');

-- Give a removed account the planner role again.
-- insert into public.user_roles (user_id, role)
-- select id, 'user' from auth.users where email = 'someone@example.com'
-- on conflict (user_id) do update set role = excluded.role;

-- Set a display name (shown on plans and comments).
-- update public.profiles set full_name = 'Asha (Kolkata DC)'
--  where email = 'someone@example.com';

-- Who has which role
select u.email, p.full_name, r.role
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.user_roles r on r.user_id = u.id
 order by r.role nulls last, u.email;
