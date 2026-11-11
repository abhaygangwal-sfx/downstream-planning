#!/usr/bin/env node
/* Builds an offline copy of the app for testing screens without internet or Supabase.
     node scripts/build-offline.mjs            → writes ./offline
     node scripts/dev-server.mjs 5173 offline  → open http://localhost:5173
   The copy uses tests/mock-supabase.js (data kept in the browser) instead of Supabase.
   The live site is never touched by this script. */
import { cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'offline');
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

await rm(out, { recursive: true, force: true });
await cp(join(root, 'public'), out, { recursive: true });

// 1. Use the local mock instead of the CDN library.
const clientPath = join(out, 'assets', 'supabase-client.js');
const client = await readFile(clientPath, 'utf8');
if (!client.includes(CDN)) throw new Error('supabase-client.js no longer imports the CDN library; update build-offline.mjs');
await writeFile(clientPath, client.replace(CDN, './mock-supabase.js'));
await cp(join(root, 'tests', 'mock-supabase.js'), join(out, 'assets', 'mock-supabase.js'));

// 2. A config file so the app does not show "config missing".
await writeFile(join(out, 'config.js'), "window.APP_CONFIG={SUPABASE_URL:'https://offline.test',SUPABASE_ANON_KEY:'sb_publishable_offline'};\n");

// 3. Notes for the tester.
await mkdir(out, { recursive: true });
await writeFile(join(out, 'OFFLINE-TEST.txt'), `OFFLINE TEST COPY (not the live site)

Open: http://localhost:5173/login.html (planner) and http://localhost:5173/admin-login.html (admin)
Start the server:  node scripts/dev-server.mjs 5173 offline

Test accounts
  Planner (Alice): alice@dc.test   / pw-alice
  Planner (Bob):   bob@dc.test     / pw-bob
  Admin (LH):      lh@dc.test      / pw-lh
  No role:         norole@dc.test  / pw-none

Data is stored in this browser only. Clear it with: DevTools > Application > Local storage > delete "mockdb.v1".
Each account has its own sign-in; use two browser windows (or a private window) to be two users at once.
`);

console.log('Offline copy written to ./offline');
console.log('Start it with: node scripts/dev-server.mjs 5173 offline');
console.log('Then open http://localhost:5173/login.html');
