# Downstream Planning: online, role-based version

This is the DC Planner (`DC_Planner_v3.html`) turned into a hosted web app with **Supabase** for sign-in, storage and live updates.

- **Planners (users)** use the same planner as before. They upload the same files and see the same lane totals, and can now **Save draft** and **Submit for LH approval**.
- **The LH team (admins)** review submitted plans. They can edit them, add comments, then **Approve** and **Publish**.
- Published plans reach every signed-in planner **live**. The "LH: Approved…" line under each lane updates, and the **Published plans** list refreshes. Nobody needs to reload the page.

All calculations still run in the browser, exactly as before. Only the lane plan is sent to the server.

---

## 1. Setup order (read this first)

Do the steps in this order. Each one depends on the one before it.

| Step | What you do | Why this order |
|---|---|---|
| **A** | Create the Supabase project, run the SQL, copy the two public keys | The app needs the keys to deploy |
| **B** | Deploy the app (Netlify, Vercel or Cloudflare Pages) and note its web address | The Supabase Site URL needs the real address |
| **C** | Set the Site URL and Redirect URLs in Supabase, using the address from step B | Invite and reset links send people here |
| **D** | Turn off public sign-up, invite users, make the LH team admins | Invitations need steps B and C to be finished |

If you skip ahead, invite links open the wrong address and show "Site not found".

---

## 2. What changed in your original file (and what did not)

| Part | Status |
|---|---|
| CSS | Moved unchanged to `public/assets/theme.css` (byte-identical) |
| Logo | Moved from the embedded image to `public/assets/logo.png` (same image) |
| All calculation code (parsing, coefficients, lane resolution, LH A+B, FM Load filter, de-dup, 80% FM share, fleet → capacity → spillover, exports) | Moved unchanged to `public/assets/planner-core.js` |
| Google Sheets block (`SHEET_API`, Save & Send, Refresh Approved Plan) | Replaced by a small bridge (`window.DCPlanner`). The Supabase code in `planner-online.js` uses it to read the lane rows and write the approved status back. |
| Lane ticks storage | **Bug fix.** The ticks were saved under the same key as the plan ID, and that key was used before it was declared, so they were lost on every reload. They now use `PLAN_KEY`, which was already defined in your code. |
| Page markup | Same, plus a sign-in bar, a **Save draft** button, the **My submissions** and **Published plans** panels, and an updated badge (it previously said "shared to the sheet") |

The exact differences are in `docs/planner-core.diff` and `docs/planner-html.diff`. The automated test loads the same input files into your original page and the new one, and checks that all 16 result tables and every KPI are identical.

**Still kept on each computer, as before:** the four master sheets (client coefficients, route mapping, transportation master, vehicle capacity) and the uploaded data files.

---

## 3. How the workflow runs

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
"Changes requested" → planner edits → Submit again (version 2; original v1 is kept)
```

| Status | Set by | Planner can edit? | Visible to |
|---|---|---|---|
| `draft` | Planner (Save draft) | Yes | Only the planner |
| `pending` | Planner (Submit) | No | Planner and admins |
| `changes_requested` | Admin | Yes, then Submit again | Planner and admins |
| `rejected` | Admin | No (start a new plan) | Planner and admins |
| `approved` | Admin | No | Planner and admins |
| `published` | Admin | No | **Every signed-in member** sees the approved plan |

**Which published plan appears in Lane totals?** The most recently published plan for the **origin hub selected** at the top. The **Published plans** panel lists all of them.

---

## 4. Database (`supabase/migrations/001_dc_planner_schema.sql`)

| Table | Holds | Who can read | Who can write |
|---|---|---|---|
| `profiles` | Name and email of each account | Self, admins | Self (name only) |
| `user_roles` | `user` or `admin` | Self, admins | **Nobody from the browser.** Use the SQL editor only. |
| `submissions` | The planner's plan (lane rows, lane ticks, vehicles) | Owner; admins (not drafts) | Owner, only while a draft or sent back for changes |
| `submission_versions` | Frozen copy of every submit (the original) | Owner, admins | Server functions only |
| `submission_reviews` | Admin's work-in-progress edits | Admins | Server functions only |
| `approved_plans` | Final approved data and the published flag | Admins, owner; **all members once published** | Server functions only |
| `submission_comments` | Admin and planner comments | Owner, admins | Owner (not on drafts) and admins. Author fields are set by the server. |
| `plan_events` | An ID-only feed that keeps open pages in sync | All members | Server functions only |

Status changes happen **only** through these server functions: `submit_submission`, `admin_save_review`, `approve_submission`, `publish_submission`, `return_submission`. Each one re-checks the caller's role. The browser cannot change `status`, `user_id` or `version` directly; column-level grants enforce this.

---

## 5. Step A: Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a project. Pick the region closest to your users (for example, Mumbai).
2. Open **SQL Editor → New query**. Paste all of `supabase/migrations/001_dc_planner_schema.sql` and click **Run**. It is safe to run again later.
3. Copy the two public values from **Project Settings → API Keys** (or **API**):
   - **Project URL** → this is `SUPABASE_URL`
   - **anon / publishable** key → this is `SUPABASE_ANON_KEY`

   ⚠️ **Never** use the `service_role` or `sb_secret_…` key in this project. The build script and the page both refuse to run with it.

Do **not** set any URLs yet. You do that in step C, after deploying.

---

## 6. Step B: Deploy the app

The app is a static site: plain HTML and JavaScript in `public/`. The build step only writes `public/config.js` from the two environment variables. That file is git-ignored, so keys never enter the repository.

**Important: the app lives in the `dc-planner-online/` folder of the repository.** Set that folder as the base or root directory in your host, or the build will not find `netlify.toml` or `vercel.json`.

### Netlify
1. **Add new site → Import an existing project** and choose the repository.
2. Set **Base directory** to `dc-planner-online`. The build command (`node scripts/build-config.mjs`) and the publish folder (`public`) come from `netlify.toml`.
3. Under **Site configuration → Environment variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
4. Click **Deploy**. Wait for the deploy to show as **Published** under the **Deploys** tab.
5. Copy the address from the site overview, for example `https://your-site-name.netlify.app`. To choose a different name, go to **Site configuration → Change site name**.

### Vercel
1. **Add New → Project** and import the repository.
2. Set **Root Directory** to `dc-planner-online`. The settings come from `vercel.json`.
3. Under **Settings → Environment Variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY` for Production and Preview. Then deploy.
4. Copy the production address, for example `https://your-project.vercel.app`.

### Cloudflare Pages
1. **Workers & Pages → Create → Pages → Connect to Git**.
2. Set the root directory to `dc-planner-online`, the build command to `node scripts/build-config.mjs`, and the output directory to `public`.
3. Add the two environment variables and deploy. `public/_headers` supplies the security headers.

### Check the deploy before going on
Open `https://<your-address>/login.html` in a browser. You should see the **Sign in** page with the logo. If you see "Setup needed", the environment variables are missing; add them and redeploy. If you see "Site not found" or a 404, the base directory is wrong.

---

## 7. Step C: Set the addresses in Supabase

Go to **Authentication → URL Configuration**.

- **Site URL:** the exact address from step B, with **no trailing slash**. Example: `https://your-site-name.netlify.app`
- **Redirect URLs:** add these entries:
  - `https://your-site-name.netlify.app/reset.html`
  - `https://your-site-name.netlify.app/**`
  - For local testing only: `http://localhost:5173/reset.html`

Save. Invitation and reset emails use the Site URL, so a wrong value here causes the "Site not found" error.

---

## 8. Step D: Users, admins and sign-up

1. **Turn off public sign-up.** Go to **Authentication → Sign In / Providers**. Keep **Email** on, turn **Allow new users to sign up** off, and keep **Confirm email** on.
2. **Invite planners.** Go to **Authentication → Users → Invite user** and enter their email. They get a link, open it, and choose a password on the set-password page. Every new account gets the planner (`user`) role automatically.
3. **Make the LH team admins.** After the admin has accepted their invitation, run this in the SQL Editor with their email:
   ```sql
   update public.user_roles set role = 'admin'
    where user_id = (select id from auth.users where email = 'lh.lead@yourcompany.com');
   ```
   `supabase/manage_roles.sql` has more commands: demote an admin, remove access, set display names, and list everyone.
4. **Check Realtime.** Go to **Database → Publications → supabase_realtime**. The tables `submissions`, `approved_plans`, `submission_comments` and `plan_events` should be listed. The migration adds them automatically.
5. **(Recommended for production) Set up email.** Supabase's built-in email sends only a few messages per hour. Configure **Authentication → Emails → SMTP Settings** with your company mail provider before inviting many people.

### Resending an invitation
If someone clicked an invitation before you finished step C, resend it: open the user under **Authentication → Users** and choose **Send invite** or **Resend**. A new link uses the current Site URL.

---

## 9. Run it on your own computer

Needs Node.js 18 or later. There are no packages to install.

```bash
cp .env.example .env            # paste your SUPABASE_URL and SUPABASE_ANON_KEY into .env
node scripts/build-config.mjs   # writes public/config.js (public values only)
node scripts/dev-server.mjs     # serves http://localhost:5173
```

Open `http://localhost:5173` and choose **User login** or **Admin login**.

To test invitations locally, set the Supabase Site URL to `http://localhost:5173` and open the link on the same computer. Set it back to the live address before you invite real users.

---

## 10. Security summary

- The browser only ever holds the **anon / publishable key**. That is safe by design: every table has Row Level Security, and the anonymous role has no access.
- **Planners** can read and write only their own submissions. Drafts are hidden even from admins.
- **Only admins** can approve, publish, edit the review copy, or return or reject a plan. The database checks this in every function, not only in the page.
- **Roles** live in `user_roles`, which the browser cannot write to.
- The planner's **original** submitted data is never overwritten. Admin edits and the final approved data are stored in separate tables.
- The page-level redirects (sign-in, admin-only) are for convenience. The database enforces access even if someone bypasses the pages.

---

## 11. Tests

```bash
# Database rules (needs a local PostgreSQL; uses a small stand-in for Supabase's auth schema)
PGHOST=... PGUSER=... tests/run_sql_tests.sh        # 45 checks: RLS, column grants, RPC rules

# Browser flow with a mocked Supabase (needs Python Playwright and Chrome)
python3 tests/e2e_test.py /path/to/DC_Planner_v3.html
```

The browser test checks that:
- the new planner's tables match the original's;
- draft, submit, admin edit, comment, approve and publish, unpublish and request-changes all work;
- live updates reach other signed-in users;
- the pages run under the production Content Security Policy.

---

## 12. Files

```
public/
  index.html                 entry: choose User login or Admin login
  login.html                 planner sign-in
  admin-login.html           admin sign-in (refuses non-admin accounts)
  reset.html                 set password (invitations and "forgot password")
  planner.html               the original planner plus draft, submit and status panels
  admin.html                 admin dashboard (review, edit, comment, approve, publish)
  assets/theme.css           original CSS (unchanged)
  assets/app.css             additions
  assets/planner-core.js     original logic plus bridge
  assets/planner-online.js   Supabase code for planners
  assets/admin.js            admin dashboard
  assets/common.js           session guard and helpers
  assets/supabase-client.js  Supabase client (refuses secret keys)
  _headers                   security headers (Netlify, Cloudflare)
supabase/migrations/001_dc_planner_schema.sql   tables, RLS, functions, realtime
supabase/manage_roles.sql                       make or remove admins
scripts/build-config.mjs                        environment variables → public/config.js
scripts/dev-server.mjs                          local static server
netlify.toml, vercel.json                       host build settings
docs/*.diff                                     exact changes to your original code
tests/                                          SQL and browser tests
```

---

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| **"Site not found" when opening an invitation** | The Supabase **Site URL** does not match your deployed address. Finish step B, set the exact address in step C, then resend the invitation. |
| "Setup needed" page | `SUPABASE_URL` or `SUPABASE_ANON_KEY` is missing in the host's environment variables. Add them and redeploy. |
| Netlify or Vercel 404, or an empty site | The base or root directory is not `dc-planner-online`. |
| Invitation opens the sign-in page with no password prompt | Add `https://<your-address>/reset.html` to **Redirect URLs**, then resend the invitation. |
| "This account has no access yet" | The account has no row in `user_roles`. Run the insert in `manage_roles.sql`. |
| "This account is not an admin" | Promote the account (step D, point 3), or use the planner login. |
| Badge shows "Offline · use Refresh" | Realtime cannot connect (network or firewall). Data still saves. Click **Refresh Approved Plan**. |
| Plan codes or dates look a day off | Plan codes and dates use India time (`Asia/Kolkata`). Change it in the migration if needed. |

The Supabase library loads from jsDelivr (`@supabase/supabase-js@2`). To pin an exact version, change the URL in `public/assets/supabase-client.js`.
