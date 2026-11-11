/* Shared helpers: session/role guard and small UI utilities. Page guards are for convenience only;
   the database (RLS + SECURITY DEFINER functions) is what actually enforces access. */
import { sb, configError } from './supabase-client.js';
export { sb };

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDt = iso => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
export const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '–';
export const fmtNum = (n, d = 2) => (n === '' || n == null || isNaN(Number(n))) ? (n ?? '') : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 });

const STATUS = {
  draft: ['Draft', 'draft'], pending: ['Pending', 'pend'], changes_requested: ['Changes requested', 'def'],
  rejected: ['Rejected', 'miss'], approved: ['Approved', 'ok'], published: ['Published', 'pub']
};
export const statusLabel = s => (STATUS[s] || [s])[0];
export const statusTag = s => '<span class="tag ' + ((STATUS[s] || [])[1] || 'draft') + '">' + esc(statusLabel(s)) + '</span>';

export function reveal() { document.documentElement.classList.remove('auth-pending'); }

let toastTimer;
export function toast(msg) {
  let t = document.getElementById('appToast');
  if (!t) { t = document.createElement('div'); t.id = 'appToast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

export function debounce(fn, ms = 300) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

export function errText(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Unknown error');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
  if (/JWT expired|invalid JWT/i.test(m)) return 'Your session expired. Sign in again.';
  return m;
}

/* Show a full-page message when config.js is not set up (instead of a blank page). */
export function showConfigError() {
  reveal();
  document.body.innerHTML = '<div class="wrap"><div class="panel"><h2>Setup needed</h2><p class="hint">' + esc(configError) +
    '</p><p class="hint">Set <b>SUPABASE_URL</b> and <b>SUPABASE_ANON_KEY</b> in your hosting environment (or in <code>.env</code> locally) and run <code>node scripts/build-config.mjs</code>. See README.md.</p></div></div>';
}

export async function currentUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session ? session.user : null;
}
export async function roleOf(uid) {
  const { data, error } = await sb.from('user_roles').select('role').eq('user_id', uid).maybeSingle();
  if (error) throw error;
  return data ? data.role : null;
}
export async function profileOf(uid) {
  const { data } = await sb.from('profiles').select('email, full_name').eq('id', uid).maybeSingle();
  return data || {};
}

/* Guard a page. admin=true → only admin accounts; otherwise any account with a role. */
export async function requireUser({ admin = false } = {}) {
  if (configError) { showConfigError(); return new Promise(() => {}); }
  const loginPage = admin ? 'admin-login.html' : 'login.html';
  const user = await currentUser();
  if (!user) { location.replace(loginPage + '?next=' + encodeURIComponent(location.pathname.split('/').pop() || '')); return new Promise(() => {}); }
  let role = null;
  try { role = await roleOf(user.id); } catch (e) { /* treated as no access below */ }
  if (!role || (admin && role !== 'admin')) {
    await sb.auth.signOut();
    location.replace(loginPage + '?msg=' + (role ? 'notadmin' : 'noaccess'));
    return new Promise(() => {});   // page is leaving; stop here quietly
  }
  const profile = await profileOf(user.id);
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') location.replace(loginPage); });
  reveal();
  return { user, role, profile, name: profile.full_name || user.email };
}

export async function signOut(to) {
  try { await sb.auth.signOut(); } finally { location.replace(to); }
}
