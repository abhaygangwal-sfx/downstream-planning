# Downstream Planning: online, role-based version

This is the DC Planner (`DC_Planner_v3.html`) turned into a hosted web app with **Supabase** for sign-in, storage and live updates.

- **Planners (users)** keep using the same planner. They upload the same files and see the same lane totals, and can now **Save draft** and **Submit for LH approval**.
- **The LH team (admins)** review submitted plans. They can edit them, comment, then **Approve** and **Publish**.
- Published plans reach every signed-in planner **live**: the "LH: Approved…" line under each lane updates, and so does the **Published plans** list. Nobody needs to reload the page.

All calculations still run in the browser, exactly as before. Only the lane plan goes to the server.

---

## 1. What changed in your original file (and what did not)

| Part | Status |
|---|---|
| CSS | Moved unchanged to `public/assets/theme.css` (byte-identical) |
| Logo | Moved from the embedded image to `public/assets/logo.png` (same image) |
| All calculation code (parsing, coefficients, lane resolution, LH A+B, FM Load filter, de-dup, 80% FM share, fleet → capacity → spillover, exports) | Moved unchanged to `public/assets/planner-core.js` |
| Google Sheets block (`SHEET_API`, Save & Send, Refresh Approved Plan) | Replaced by a small bridge (`window.DCPlanner`). The Supabase code in `planner-online.js` uses it to read the lane rows and to write the approved status back. |
| Lane ticks storage | **Bug fix.** The ticks were saved under the same key as the plan ID, and that key was used before it was declared, so the ticks were lost on every reload. They now use `PLAN_KEY`, which was already defined in your code for this. |
| Page markup | Same, plus a sign-in bar, a **Save draft** button, the **My submissions** and **Published plans** panels, and an updated badge (it said "shared to the sheet") |

The exact differences are in `docs/planner-core.diff` and `docs/planner-html.diff`. The automated test loads the same files into your original page and into the new one, and checks that all 16 result tables and every KPI are identical.

**Still kept on each computer, as before:** the four master sheets (client coefficients, route mapping, transportation master, vehicle capacity) and the uploaded data files.

---

## 2. How the workflow runs

```
Planner                          Database                               LH admin
───────                          ────────                               ────────
Save draft ───────────────► submissions (status = draft, private)
Submit ───────────────────► status = pending, version + 1
                            submission_versions ← frozen copy (the original)
                                                       ◄────────── Save edits (submission_reviews)
                                                       ◄────────── Comment
                                                       ◄────────── Approve  → approved_plans (final data)
                                                       ◄────────── Publish  → is_published = true
Lane table + Published plans ◄── Realtime (all members) ───────────┘
                                                       ◄────────── Request changes / Reject (with comment)
"Changes requested" → planner edits → Submit again (version 2, original v1 still kept)
```

| Status | Who sets it | Planner can edit? | Visible to |
|---|---|---|---|
| `draft` | Planner (Save draft) | Yes | Only the planner |
| `pending` | Planner (Submit) | No | Planner + admins |
| `changes_requested` | Admin | Yes, then Submit again | Planner + admins |
| `rejected` | Admin | No (start a new plan) | Planner + admins |
| `approved` | Admin | No | Planner + admins |
| `published` | Admin | No | **Every signed-in member** sees the approved plan |

**Which published plan shows in Lane totals?** The most recently published plan for the **origin hub selected** at the top. The **Published plans** panel lists all of them.

---

## 3. Database (in `supabase/migrations/001_dc_planner_schema.sql`)

| Table | Holds | Who can read | Who can write |
|---|---|---|---|
| `profiles` | Name and email of each account | Self, admins | Self (name only) |
| `user_roles` | `user` or `admin` | Self, admins | **Nobody from the browser.** Use the SQL editor only. |
| `submissions` | The planner's plan (lane rows, lane ticks, vehicles) | Owner; admins (except drafts) | Owner, only while it is a draft or sent back for changes |
| `submission_versions` | Frozen copy of every submit (the original) | Owner, admins | Only the server functions |
| `submission_reviews` | Admin's work-in-progress edits | Admins | Only the server functions |
| `approved_plans` | Final approved data, plus the published flag | Admins, owner; **all members once published** | Only the server functions |
| `submission_comments` | Admin ↔ planner comments | Owner, admins | Owner (not on drafts), admins. Author fields are set by the server. |
| `plan_events` | A feed of IDs only, which keeps every open page in sync | All members | Only the server functions |

Status changes happen **only** through these server functions (`SECURITY DEFINER`, each re-checks the caller): `submit_submission`, `admin_save_review`, `approve_submission`, `publish_submission`, `return_submission`. The browser has no permission to change `status`, `user_id` or `version` directly. Column-level grants enforce this.

---

## 4. Set up Supabase (about 15 minutes)

1. **Create a project** at [supabase.com](https://supabase.com). Choose the region closest to your users (for example, Mumbai).
2. **Create the tables and security rules.** Open **SQL Editor → New query**, paste all of `supabase/migrations/001_dc_planner_schema.sql`, and click **Run**. You can safely run it again later.
3. **Turn off public sign-up** so that only people you invite can get in. Go to **Authentication → Sign In / Providers**. Keep **Email** on and turn **Allow new users to sign up** off. Keep **Confirm email** on.
4. **Set the URLs.** Go to **Authentication → URL Configuration**:
   - **Site URL:** your app address, e.g. `https://dc-planner.netlify.app`
   - **Redirect URLs:** add `https://dc-planner.netlify.app/reset.html`, and also `http://localhost:5173/reset.html` for local testing.
5. **Add people.** Go to **Authentication → Users → Invite user** and enter their email. They get an email, click the link, and choose a password on `reset.html`. Every new account gets the planner (`user`) role automatically. Alternatively, use **Add user → Create new user** with a password and *Auto confirm*.
6. **Make the LH team admins.** In the SQL Editor, run (with their email):
   ```sql
   update public.user_roles set role = 'admin'
    where user_id = (select id from auth.users where email = 'lh.lead@yourcompany.com');
   ```
   `supabase/manage_roles.sql` has more commands: demote, remove access, set display names, list everyone.
7. **Check Realtime.** The migration already adds the tables to Realtime. To confirm, open **Database → Publications → supabase_realtime**: `submissions`, `approved_plans`, `submission_comments` and `plan_events` should be listed.
8. **Copy the two public values.** Go to **Project Settings → API Keys** (or **API**) and copy:
   - the **Project URL** → `SUPABASE_URL`
   - the **anon** / **publishable** key → `SUPABASE_ANON_KEY`

   ⚠️ **Never** use the `service_role` / `sb_secret_…` key in this project. The build script and the page both refuse to run with one.
9. **(Recommended for production) Set up email.** Supabase's built-in email sends only a few messages per hour. For real invites and password resets, configure **Authentication → Emails → SMTP Settings** with your company mail provider.

---

## 5. Run it on your computer

Needs Node.js 18+; there are no packages to install.

```bash
cp .env.example .env            # then paste your SUPABASE_URL and SUPABASE_ANON_KEY into .env
node scripts/build-config.mjs   # writes public/config.js (public values only)
node scripts/dev-server.mjs     # http://localhost:5173
```

Open `http://localhost:5173`, then choose **User login** or **Admin login**.

---

## 6. Deploy online

The app is a static site: plain HTML/JS in `public/`, with nothing to run on a server. The build step only writes `public/config.js` from the two environment variables. That file is git-ignored, so keys never go into your repository.

### Netlify
1. Push this folder to a GitHub/GitLab repository.
2. In Netlify, choose **Add new site → Import an existing project** and pick the repository. `netlify.toml` already sets the build command (`node scripts/build-config.mjs`) and the publish folder (`public`).
3. Under **Site configuration → Environment variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then **Deploy**.

### Vercel
1. **Add New → Project** and import the repository. `vercel.json` sets the build command and the `public` output folder.
2. Under **Settings → Environment Variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Production and Preview), then deploy.

### Cloudflare Pages
1. **Workers & Pages → Create → Pages → Connect to Git.**
2. Build command `node scripts/build-config.mjs`, output directory `public`, and add the two environment variables. `public/_headers` supplies the security headers.

**After the first deploy:** put the live URL into Supabase **Site URL** and **Redirect URLs** (step 4 above).

Security headers (Content-Security-Policy and others) are set in `public/_headers` (Netlify, Cloudflare) and `vercel.json` (Vercel). If you use a **custom Supabase domain**, add it to `connect-src` in both files.

---

## 7. Security summary

- The browser only ever holds the **anon/publishable key**. That is safe by design, because every table has Row Level Security and the anon role has no access at all.
- **Planners** can read and write only their own submissions. Drafts are hidden even from admins.
- **Only admins** can approve, publish, edit the review copy, or return or reject a plan. The database checks this in every function, not just in the page.
- **Roles** live in `user_roles`, which the browser cannot write to.
- The planner's **original** submitted data is never overwritten. The admin's edits and the final approved data are stored in separate tables.
- The page-level redirects (login, admin-only) are for convenience. The database enforces access even if someone bypasses the pages.

---

## 8. Tests

```bash
# Database rules (needs a local PostgreSQL; uses a small stand-in for Supabase's auth schema)
PGHOST=... PGUSER=... tests/run_sql_tests.sh        # 45 checks: RLS, column grants, RPC rules

# Browser flow with a mocked Supabase (needs Python Playwright + Chrome)
python3 tests/e2e_test.py /path/to/DC_Planner_v3.html
```
The browser test checks the following:
- the new planner's tables are identical to the original's;
- draft, submit, admin edit, comment, approve & publish, unpublish and request changes all work;
- live updates reach other signed-in users;
- the pages run under the production CSP.

---

## 9. Files

```
public/
  index.html            entry: choose User login / Admin login
  login.html            planner sign-in
  admin-login.html      admin sign-in (refuses non-admin accounts)
  reset.html            set password (invites + "forgot password")
  planner.html          the original planner + draft/submit/status panels
  admin.html            admin dashboard (review, edit, comment, approve, publish)
  assets/theme.css      original CSS (unchanged)      assets/app.css     additions
  assets/planner-core.js original logic + bridge     assets/planner-online.js  Supabase for planners
  assets/admin.js       admin dashboard               assets/common.js   guard + helpers
  assets/supabase-client.js  client (refuses secret keys)
  _headers              security headers (Netlify / Cloudflare)
supabase/migrations/001_dc_planner_schema.sql   tables, RLS, functions, realtime
supabase/manage_roles.sql                       make/remove admins
scripts/build-config.mjs                        env → public/config.js
scripts/dev-server.mjs                          local static server
docs/*.diff                                     exact changes to your original code
tests/                                          SQL + browser tests
```

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup needed" page | `public/config.js` is missing. Set the env vars and run the build step. |
| "This account has no access yet" | The account has no row in `user_roles`. Run the insert in `manage_roles.sql`. |
| "This account is not an admin" | Promote the account (step 6), or use the planner login. |
| Badge shows "Offline · use Refresh" | Realtime can't connect (network or firewall). Data still saves. Click **Refresh Approved Plan**. |
| Invite or reset link opens the home page | Add `/reset.html` to **Redirect URLs** in Supabase. The home page forwards these links automatically. |
| Plan codes or dates look a day off | Plan codes and plan dates use India time (`Asia/Kolkata`) in the migration. Change it there if needed. |

The Supabase library loads from jsDelivr (`@supabase/supabase-js@2`). To pin an exact version, change the URL in `public/assets/supabase-client.js`.
