/* Handles both invite links (first password) and password-reset links. */
import { sb, reveal, roleOf, errText, showConfigError } from './common.js';
import { configError } from './supabase-client.js';
const $ = id => document.getElementById(id);

(async () => {
  if (configError) { showConfigError(); return; }
  reveal();
  const q = new URLSearchParams(location.search);
  if (q.get('code')) { try { await sb.auth.exchangeCodeForSession(q.get('code')); } catch (e) { /* falls through */ } }
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {           // the URL fragment is parsed asynchronously; wait briefly for it
    session = await new Promise(res => {
      const t = setTimeout(() => res(null), 2500);
      sb.auth.onAuthStateChange((_e, s) => { if (s) { clearTimeout(t); res(s); } });
    });
  }
  if (!session) {
    $('resetWho').textContent = 'This link is invalid or has expired. Ask for a new one from the sign-in page.';
    $('resetBtn').disabled = true; return;
  }
  history.replaceState(null, '', location.pathname);
  $('resetWho').textContent = 'Signed in as ' + session.user.email + '.';

  $('resetForm').addEventListener('submit', async e => {
    e.preventDefault();
    const a = $('pw1').value, b = $('pw2').value;
    $('resetErr').textContent = '';
    if (a.length < 8) { $('resetErr').textContent = 'Use at least 8 characters.'; return; }
    if (a !== b) { $('resetErr').textContent = 'The two passwords do not match.'; return; }
    $('resetBtn').disabled = true;
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { $('resetErr').textContent = errText(error); $('resetBtn').disabled = false; return; }
    $('resetOk').textContent = 'Password saved. Opening the app…';
    const role = await roleOf(session.user.id).catch(() => null);
    setTimeout(() => location.replace(role === 'admin' ? 'admin.html' : 'planner.html'), 900);
  });
})();
