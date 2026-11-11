import { sb, reveal, roleOf, errText, showConfigError } from './common.js';
import { configError } from './supabase-client.js';

const $ = id => document.getElementById(id);
const admin = document.body.dataset.mode === 'admin';
const home = admin ? 'admin.html' : 'planner.html';
const params = new URLSearchParams(location.search);
const safeNext = n => /^[a-z-]+\.html$/.test(n || '') ? n : '';

const MSG = {
  noaccess: 'This account has no access yet. Ask your admin to add you.',
  notadmin: 'This account is not an admin. Use the planner login instead.'
};

function err(t) { $('loginErr').textContent = t || ''; if (t) $('loginOk').textContent = ''; }
function ok(t) { $('loginOk').textContent = t || ''; if (t) $('loginErr').textContent = ''; }

async function routeIfAllowed(user) {
  const role = await roleOf(user.id).catch(() => null);
  if (!role) { await sb.auth.signOut(); err(MSG.noaccess); return false; }
  if (admin && role !== 'admin') { await sb.auth.signOut(); err(MSG.notadmin); return false; }
  const next = safeNext(params.get('next'));
  location.replace(admin ? 'admin.html' : (next && next !== 'admin.html' ? next : home));
  return true;
}

(async () => {
  if (configError) { showConfigError(); return; }
  reveal();
  if (MSG[params.get('msg')]) err(MSG[params.get('msg')]);
  const { data: { session } } = await sb.auth.getSession();
  if (session && !params.get('msg')) await routeIfAllowed(session.user);

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) { err('Enter your email and password.'); return; }
    const btn = $('loginBtn'); btn.disabled = true; err('');
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await routeIfAllowed(data.user);
    } catch (e2) {
      err(/invalid login/i.test(e2.message || '') ? 'Email or password is incorrect.' : errText(e2));
    } finally { btn.disabled = false; }
  });

  $('forgotBtn').addEventListener('click', async () => {
    const email = $('email').value.trim();
    if (!email) { err('Type your email above first, then click Forgot password.'); $('email').focus(); return; }
    const redirectTo = new URL('reset.html', location.href).href;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) err(errText(error)); else ok('If that email has an account, a reset link is on its way.');
  });
})();
