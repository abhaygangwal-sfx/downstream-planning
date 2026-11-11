/* One Supabase client for every page. Values come from config.js (written from environment
   variables at build time). Only the public anon/publishable key may ever be used here. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.APP_CONFIG || {};
const url = String(cfg.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(cfg.SUPABASE_ANON_KEY || '').trim();

function keyRole(k) {
  if (k.startsWith('sb_secret_')) return 'service_role';
  if (k.startsWith('sb_publishable_')) return 'anon';
  try { return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; }
  catch (e) { return ''; }
}

export let configError = '';
if (!/^https:\/\/[^/]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) configError = 'SUPABASE_URL is missing or not a valid https URL.';
else if (!key) configError = 'SUPABASE_ANON_KEY is missing.';
else if (keyRole(key) === 'service_role') configError = 'config.js contains a service-role / secret key. Replace it with the anon (publishable) key and rotate the secret key in Supabase now.';

export const sb = configError ? null : createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 5 } }
});
