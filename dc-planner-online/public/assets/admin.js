/* Admin (LH team) dashboard. Status changes go through SECURITY DEFINER functions that re-check the admin role. */
import { sb, requireUser, signOut, esc, fmtDt, fmtDate, fmtNum, statusTag, statusLabel, toast, debounce, errText } from './common.js';

const $ = id => document.getElementById(id);
const ctx = await requireUser({ admin: true });
$('acctWho').innerHTML = 'Admin · <b>' + esc(ctx.name) + '</b>';
$('acctOut').onclick = () => signOut('admin-login.html');

const LIST_COLS = 'id, plan_code, origin_dc, plan_date, created_by_name, status, version, lane_count, submitted_at, decided_at, updated_at, user_id, owner:profiles!submissions_user_id_fkey(email, full_name)';
const NUM = ['total_awb', 'total_volumetric', 'vehicle_capacity', 'approved_vehicle_count'];
const EDIT_FIELDS = ['total_awb', 'total_volumetric', 'fleet_type', 'vehicle_capacity', 'adhoc_required', 'lh_aligned', 'approved_vehicle', 'approved_vehicle_count', 'approved_remarks'];
const S = { list: [], filter: 'pending', q: '', ed: null, busy: false };
const norm = s => String(s == null ? '' : s).replace(/[_\s]+/g, ' ').trim().toLowerCase();
const disp = s => String(s == null ? '' : s).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- list ---------- */
async function loadList() {
  const { data, error } = await sb.from('submissions').select(LIST_COLS).neq('status', 'draft').order('submitted_at', { ascending: false, nullsFirst: false }).limit(500);
  if (error) { $('listBody').innerHTML = '<tr><td colspan="9" class="err">' + esc(errText(error)) + '</td></tr>'; return; }
  S.list = data || []; renderList();
}
function renderList() {
  const c = st => S.list.filter(s => s.status === st).length;
  $('kPend').textContent = c('pending'); $('kChg').textContent = c('changes_requested'); $('kAppr').textContent = c('approved'); $('kPub').textContent = c('published');
  const q = norm(S.q);
  const rows = S.list.filter(s => (S.filter === 'all' || s.status === S.filter) && (!q || norm([s.plan_code, s.origin_dc, s.created_by_name, s.owner && s.owner.email].join(' ')).includes(q)));
  $('listCount').textContent = '· ' + rows.length + ' shown';
  $('listBody').innerHTML = rows.length ? rows.map(s => '<tr' + (S.ed && S.ed.sub.id === s.id ? ' class="sel"' : '') + '><td><b>' + esc(s.plan_code) + '</b></td><td>' + esc(s.origin_dc || 'All hubs') + '</td><td>' + fmtDate(s.plan_date) + '</td><td>' + esc(s.created_by_name || '–') + '<div class="muted" style="font-size:12px">' + esc(s.owner ? s.owner.email : '') + '</div></td><td class="num">' + fmtNum(s.lane_count, 0) + '</td><td class="num">v' + s.version + '</td><td>' + statusTag(s.status) + '</td><td>' + fmtDt(s.submitted_at) + '</td><td><button class="btn' + (s.status === 'pending' ? ' primary' : '') + '" data-open="' + esc(s.id) + '">' + (s.status === 'pending' ? 'Review' : 'Open') + '</button></td></tr>').join('')
    : '<tr><td colspan="9" class="muted">No ' + (S.filter === 'all' ? '' : statusLabel(S.filter).toLowerCase() + ' ') + 'submissions.</td></tr>';
}
$('filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; [...$('filters').children].forEach(x => x.classList.toggle('on', x === b)); renderList(); });
$('listSearch').oninput = () => { S.q = $('listSearch').value; renderList(); };
$('listBody').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openEditor(b.dataset.open); });

/* ---------- editor ---------- */
const clone = o => JSON.parse(JSON.stringify(o));
function spill(r) {
  const v = Number(r.total_volumetric), c = r.vehicle_capacity;
  return (c === '' || c == null || isNaN(Number(c)) || isNaN(v)) ? '' : +(v - Number(c)).toFixed(4);
}
async function openEditor(id, { keepMsg = false } = {}) {
  if (S.ed && S.ed.dirty && S.ed.sub.id !== id && !confirm('Discard unsaved edits on ' + S.ed.sub.plan_code + '?')) return;
  const [s, v, r, a] = await Promise.all([
    sb.from('submissions').select('*, owner:profiles!submissions_user_id_fkey(email, full_name)').eq('id', id).single(),
    sb.from('submission_versions').select('*').eq('submission_id', id).order('version', { ascending: false }),
    sb.from('submission_reviews').select('*').eq('submission_id', id).maybeSingle(),
    sb.from('approved_plans').select('*').eq('submission_id', id).maybeSingle()
  ]);
  if (s.error) { toast(errText(s.error)); return; }
  const sub = s.data, versions = v.data || [];
  const origData = (versions.find(x => x.version === sub.version) || {}).data || sub.data || {};
  const original = (origData.rows || []).map(x => ({ ...x }));
  let start = original, from = 'the planner\'s submission';
  if (r.data && r.data.draft_data && r.data.draft_data.base_version === sub.version) { start = r.data.draft_data.rows; from = 'your saved edits (' + fmtDt(r.data.updated_at) + ')'; }
  else if (a.data && a.data.version === sub.version) { start = a.data.final_data.rows; from = 'the approved version'; }
  const work = clone(start).map(x => ({ approved_vehicle: '', approved_vehicle_count: '', approved_remarks: '', ...x }));
  S.ed = { sub, versions, origData, original, origBy: new Map(original.map(x => [norm(x.lane), x])), work, approved: a.data, dirty: false, from };
  $('editor').classList.remove('hidden');
  if (!keepMsg) msg('');
  renderEditor(); renderList(); loadComments();
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
/* Version comparison: this version against the version it was started from. */
async function renderCompare() {
  const box = $('edCompare'), sub = S.ed.sub;
  if (!sub.parent_id) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="muted">Loading the previous version…</p>';
  const { data: par, error } = await sb.from('submissions').select('plan_code, version, data').eq('id', sub.parent_id).maybeSingle();
  if (!S.ed || S.ed.sub.id !== sub.id) return;
  if (error || !par) { box.innerHTML = '<p class="err">Could not load the previous version.</p>'; return; }
  const oldRows = new Map(((par.data && par.data.rows) || []).map(x => [norm(x.lane), x]));
  const newRows = new Map(((sub.data && sub.data.rows) || []).map(x => [norm(x.lane), x]));
  const FIELDS = ['total_awb', 'total_volumetric', 'fleet_type', 'vehicle_capacity', 'adhoc_required', 'dc_vehicle'];
  const out = [];
  newRows.forEach((n, k) => {
    const o = oldRows.get(k);
    if (!o) { out.push({ lane: n.lane, kind: 'Added', changes: '' }); return; }
    const diffs = FIELDS.filter(f => String(o[f] ?? '') !== String(n[f] ?? '')).map(f => f + ': ' + (o[f] ?? '–') + ' → ' + (n[f] ?? '–'));
    if (diffs.length) out.push({ lane: n.lane, kind: 'Changed', changes: diffs.join('; ') });
  });
  oldRows.forEach((o, k) => { if (!newRows.has(k)) out.push({ lane: o.lane, kind: 'Removed', changes: '' }); });
  box.innerHTML = '<h3 class="sub">Compared with ' + esc(par.plan_code) + ' v' + par.version + '</h3>'
    + (out.length ? '<div class="tablewrap" style="max-height:260px"><table class="plain"><thead><tr><th>Lane</th><th>Change</th><th>Details</th></tr></thead><tbody>'
      + out.map(x => '<tr><td>' + esc(x.lane) + '</td><td>' + esc(x.kind) + '</td><td>' + esc(x.changes) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<p class="muted">No lane changes from the previous version.</p>');
}
function msg(t, bad) { $('edMsg').textContent = t; $('edMsg').style.color = bad ? '#b42318' : ''; }
function readOnly() { return ['changes_requested', 'rejected'].includes(S.ed.sub.status); }
function renderEditor() {
  const { sub, approved, versions } = S.ed;
  $('edTitle').innerHTML = esc(sub.plan_code) + ' ' + statusTag(sub.status) + ' <span class="muted" style="font-weight:400;font-size:13px">v' + sub.version + '</span>';
  $('edInfo').textContent = readOnly() ? 'Waiting for the planner (' + statusLabel(sub.status).toLowerCase() + '). Edits are locked until they submit again.' : 'Started from ' + S.ed.from + '.';
  $('edKv').innerHTML = '<div><span>Origin hub</span>' + esc(sub.origin_dc || 'All hubs') + '</div><div><span>Plan date</span>' + fmtDate(sub.plan_date) + '</div><div><span>Submitted by</span>' + esc(sub.created_by_name) + ' · ' + esc(sub.owner ? sub.owner.email : '') + '</div><div><span>Submitted</span>' + fmtDt(sub.submitted_at) + '</div>'
    + '<div><span>Approved</span>' + (approved ? fmtDt(approved.approved_at) + ' by ' + esc(approved.approved_by_name) + ' (v' + approved.version + ')' : '–') + '</div><div><span>Published</span>' + (approved && approved.is_published ? fmtDt(approved.published_at) : '–') + '</div>';
  $('vehList').innerHTML = (S.ed.origData.vehicles || []).map(x => '<option value="' + esc(x) + '">').join('');
  renderRows();
  renderCompare();
  const st = sub.status, ro = readOnly();
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  show('actSave', !ro); show('actApprove', st === 'pending' || st === 'approved'); show('actApprovePub', !ro);
  $('actApprovePub').textContent = st === 'published' ? 'Save & republish' : 'Approve & Publish';
  show('actPublish', st === 'approved'); show('actUnpublish', st === 'published');
  show('actChanges', !ro); show('actReject', !ro);
  ['edCopyVeh', 'edReset'].forEach(id => $(id).disabled = ro);
  $('edHist').innerHTML = versions.map(x => '<tr><td class="num">v' + x.version + '</td><td>' + fmtDt(x.submitted_at) + '</td><td>' + esc(x.created_by_name) + '</td><td class="num">' + ((x.data.rows || []).length) + '</td><td><button class="btn" data-ver="' + x.version + '">View original</button></td></tr>').join('') || '<tr><td colspan="5" class="muted">–</td></tr>';
  $('edAlert').classList.add('hidden');
}
function cellIn(i, k, val, orig, kind) {
  const changed = orig && String(orig[k] ?? '') !== String(val ?? '');
  const t = changed ? ' title="Submitted: ' + esc(orig[k] ?? '(blank)') + '"' : '';
  const dis = readOnly() ? ' disabled' : '';
  let input;
  if (kind === 'yn') input = '<select data-i="' + i + '" data-k="' + k + '"' + dis + '><option' + (val === 'yes' ? ' selected' : '') + '>yes</option><option' + (val !== 'yes' ? ' selected' : '') + '>no</option></select>';
  else input = '<input type="' + (kind === 'num' ? 'number" step="any" min="0' : 'text') + '" data-i="' + i + '" data-k="' + k + '" value="' + esc(val ?? '') + '"' + (k === 'approved_vehicle' ? ' list="vehList" placeholder="vehicle"' : '') + (k === 'approved_remarks' ? ' placeholder="remarks" style="min-width:160px"' : '') + dis + '>';
  return '<td class="edit' + (kind === 'num' ? ' num' : '') + (changed ? ' changed' : '') + '"' + t + '>' + input + '</td>';
}
function rowHtml(r, i) {
  const o = S.ed.origBy.get(norm(r.lane));
  const sp = r.spillover;
  return '<tr data-row="' + i + '"><td>' + esc(disp(r.lane)) + '</td>'
    + cellIn(i, 'total_awb', r.total_awb, o, 'num') + cellIn(i, 'total_volumetric', r.total_volumetric, o, 'num')
    + cellIn(i, 'fleet_type', r.fleet_type, o, 'text') + cellIn(i, 'vehicle_capacity', r.vehicle_capacity, o, 'num')
    + '<td class="num ' + (Number(sp) > 0 ? 'spill-pos' : Number(sp) < 0 ? 'spill-neg' : '') + (o && String(o.spillover ?? '') !== String(sp ?? '') ? ' changed' : '') + '"' + (o && String(o.spillover ?? '') !== String(sp ?? '') ? ' title="Submitted: ' + esc(o.spillover ?? '') + '"' : '') + '>' + (sp === '' ? '–' : fmtNum(sp)) + '</td>'
    + cellIn(i, 'adhoc_required', r.adhoc_required, o, 'yn') + cellIn(i, 'lh_aligned', r.lh_aligned || 'no', o && { lh_aligned: o.lh_aligned || 'no' }, 'yn')
    + '<td>' + esc(r.dc_vehicle || '') + '</td>'
    + cellIn(i, 'approved_vehicle', r.approved_vehicle, null, 'text') + cellIn(i, 'approved_vehicle_count', r.approved_vehicle_count, null, 'num') + cellIn(i, 'approved_remarks', r.approved_remarks, null, 'text')
    + '</tr>';
}
function isChanged(r) { const o = S.ed.origBy.get(norm(r.lane)); return !o || EDIT_FIELDS.slice(0, 6).some(k => String(o[k] ?? (k === 'lh_aligned' ? 'no' : '')) !== String(r[k] ?? (k === 'lh_aligned' ? 'no' : ''))); }
function renderRows() {
  const only = $('edOnlyChanged').checked;
  const list = S.ed.work.map((r, i) => [r, i]).filter(([r]) => !only || isChanged(r));
  $('edBody').innerHTML = list.map(([r, i]) => rowHtml(r, i)).join('') || '<tr><td colspan="12" class="muted">' + (only ? 'No figures changed from the submission.' : 'No lanes.') + '</td></tr>';
  const n = S.ed.work.filter(isChanged).length;
  $('edChanged').textContent = '· ' + S.ed.work.length + ' lanes' + (n ? ' · ' + n + ' with edited figures' : '');
}
$('edOnlyChanged').onchange = renderRows;
$('edBody').addEventListener('change', e => {
  const t = e.target; if (!t.dataset || t.dataset.i == null) return;
  const r = S.ed.work[+t.dataset.i], k = t.dataset.k;
  r[k] = NUM.includes(k) ? (t.value.trim() === '' ? '' : Number(t.value)) : t.value.trim();
  if (k === 'lh_aligned' && r[k] === 'no') { /* keep the DC vehicle as submitted; approval fields stay editable */ }
  r.spillover = spill(r);
  S.ed.dirty = true;
  const tr = $('edBody').querySelector('tr[data-row="' + t.dataset.i + '"]');
  if (tr) { const tmp = document.createElement('tbody'); tmp.innerHTML = rowHtml(r, +t.dataset.i); tr.replaceWith(tmp.firstElementChild); }
  const n = S.ed.work.filter(isChanged).length;
  $('edChanged').textContent = '· ' + S.ed.work.length + ' lanes' + (n ? ' · ' + n + ' with edited figures' : '');
  msg('Unsaved edits.');
});
$('edCopyVeh').onclick = () => { let n = 0; S.ed.work.forEach(r => { if (!r.approved_vehicle && r.dc_vehicle) { r.approved_vehicle = r.dc_vehicle; n++; } }); if (n) { S.ed.dirty = true; renderRows(); } msg(n ? 'Copied the DC vehicle into ' + n + ' lane(s). Not saved yet.' : 'No blank approved vehicles with a DC vehicle.'); };
$('edReset').onclick = () => { if (!confirm('Discard all edits and start again from the planner\'s submission?')) return; S.ed.work = clone(S.ed.original).map(x => ({ approved_vehicle: '', approved_vehicle_count: '', approved_remarks: '', ...x })); S.ed.dirty = true; renderRows(); msg('Reset to the original. Not saved yet.'); };
$('edClose').onclick = () => { if (S.ed && S.ed.dirty && !confirm('Discard unsaved edits?')) return; S.ed = null; $('editor').classList.add('hidden'); renderList(); };
window.addEventListener('beforeunload', e => { if (S.ed && S.ed.dirty) { e.preventDefault(); e.returnValue = ''; } });
$('edHist').addEventListener('click', e => {
  const b = e.target.closest('[data-ver]'); if (!b) return;
  const v = S.ed.versions.find(x => x.version === +b.dataset.ver); if (!v) return;
  $('edAlert').classList.remove('hidden');
  $('edAlertT').textContent = 'Original submission v' + v.version + ' (read-only) · ' + fmtDt(v.submitted_at);
  $('edAlertB').innerHTML = '<div class="tablewrap" style="max-height:300px"><table class="plain"><thead><tr><th>Lane</th><th class="num">Total AWB</th><th class="num">Total volumetric</th><th>Fleet Type</th><th class="num">Vehicle Capacity</th><th class="num">Spillover</th><th>Adhoc</th><th>LH aligned</th><th>DC vehicle</th></tr></thead><tbody>'
    + (v.data.rows || []).map(x => '<tr><td>' + esc(disp(x.lane)) + '</td><td class="num">' + fmtNum(x.total_awb, 0) + '</td><td class="num">' + fmtNum(x.total_volumetric) + '</td><td>' + esc(x.fleet_type) + '</td><td class="num">' + fmtNum(x.vehicle_capacity, 0) + '</td><td class="num">' + fmtNum(x.spillover) + '</td><td>' + esc(x.adhoc_required) + '</td><td>' + esc(x.lh_aligned || '') + '</td><td>' + esc(x.dc_vehicle) + '</td></tr>').join('')
    + '</tbody></table></div><div class="row" style="margin-top:8px"><button class="btn" id="edAlertClose">Hide</button></div>';
  $('edAlertClose').onclick = () => $('edAlert').classList.add('hidden');
  $('edAlert').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('edCsv').onclick = () => {
  const cols = ['lane', 'total_awb', 'total_volumetric', 'fleet_type', 'vehicle_capacity', 'spillover', 'adhoc_required', 'lh_aligned', 'dc_vehicle', 'approved_vehicle', 'approved_vehicle_count', 'approved_remarks'];
  const cell = v => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [cols.join(',')].concat(S.ed.work.map(r => cols.map(k => cell(r[k])).join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = S.ed.sub.plan_code + '_v' + S.ed.sub.version + '_review.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};

/* ---------- actions ---------- */
function validate() {
  for (const r of S.ed.work) for (const k of NUM) {
    const v = r[k]; if (v === '' || v == null) continue;
    if (isNaN(Number(v)) || Number(v) < 0) return disp(r.lane) + ': ' + k.replace(/_/g, ' ') + ' must be a number ≥ 0.';
  }
  return '';
}
function finalData() {
  return { ...clone(S.ed.origData), rows: clone(S.ed.work), base_version: S.ed.sub.version, edited_by: ctx.name, edited_at: new Date().toISOString() };
}
async function act(btn, label, fn) {
  if (S.busy) return; S.busy = true; btn.disabled = true; msg(label + '…');
  try { const done = await fn(); if (done !== false) { S.ed.dirty = false; await loadList(); await openEditor(S.ed.sub.id, { keepMsg: true }); msg(done || label + ' done.'); toast(done || label + ' done.'); } else msg(''); }
  catch (e) { msg(label + ' failed: ' + errText(e), true); }
  finally { S.busy = false; btn.disabled = false; }
}
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
const commentText = () => $('edCommentBody').value.trim();
$('actSave').onclick = () => act($('actSave'), 'Save edits', async () => {
  const bad = validate(); if (bad) throw new Error(bad);
  await rpc('admin_save_review', { p_id: S.ed.sub.id, p_data: finalData() }); return 'Edits saved (not approved yet).';
});
$('actApprove').onclick = () => act($('actApprove'), 'Approve', async () => {
  const bad = validate(); if (bad) throw new Error(bad);
  if (!confirm('Approve ' + S.ed.sub.plan_code + ' with the values shown? It will not be visible to planners until you publish it.')) return false;
  await rpc('approve_submission', { p_id: S.ed.sub.id, p_final: finalData(), p_publish: false }); return 'Approved. Publish it to make it visible to all planners.';
});
$('actApprovePub').onclick = () => act($('actApprovePub'), S.ed.sub.status === 'published' ? 'Republish' : 'Approve & publish', async () => {
  const bad = validate(); if (bad) throw new Error(bad);
  if (!confirm((S.ed.sub.status === 'published' ? 'Replace the published version of ' : 'Approve and publish ') + S.ed.sub.plan_code + '? Every planner will see it immediately.')) return false;
  await rpc('approve_submission', { p_id: S.ed.sub.id, p_final: finalData(), p_publish: true }); return 'Approved and published. Planners see it now.';
});
$('actPublish').onclick = () => act($('actPublish'), 'Publish', async () => {
  if (S.ed.dirty && !confirm('You have unsaved edits. Publish the last approved version without them?')) return false;
  await rpc('publish_submission', { p_id: S.ed.sub.id, p_publish: true }); return 'Published.';
});
$('actUnpublish').onclick = () => act($('actUnpublish'), 'Unpublish', async () => {
  if (!confirm('Unpublish ' + S.ed.sub.plan_code + '? Planners will no longer see it.')) return false;
  await rpc('publish_submission', { p_id: S.ed.sub.id, p_publish: false }); return 'Unpublished. It stays approved.';
});
async function sendBack(status, label) {
  const c = commentText();
  if (!c) { $('edCommentBody').focus(); throw new Error('Write a comment first, so the planner knows what to change.'); }
  if (!confirm(label + ' ' + S.ed.sub.plan_code + '? The planner will see your comment.' + (S.ed.sub.status === 'published' ? ' The published version will be withdrawn.' : ''))) return false;
  await rpc('return_submission', { p_id: S.ed.sub.id, p_status: status, p_comment: c });
  $('edCommentBody').value = ''; return label === 'Reject' ? 'Rejected.' : 'Sent back to the planner for changes.';
}
$('actChanges').onclick = () => act($('actChanges'), 'Request changes', () => sendBack('changes_requested', 'Request changes on'));
$('actReject').onclick = () => act($('actReject'), 'Reject', () => sendBack('rejected', 'Reject'));

/* ---------- comments ---------- */
async function loadComments() {
  if (!S.ed) return;
  const { data } = await sb.from('submission_comments').select('*').eq('submission_id', S.ed.sub.id).order('created_at');
  $('edComments').innerHTML = (data && data.length) ? data.map(c => '<div class="comment' + (c.is_admin ? ' admin' : '') + '"><div class="who">' + esc(c.author_name || '–') + (c.is_admin ? ' · LH team' : ' · planner') + ' · ' + fmtDt(c.created_at) + '</div>' + esc(c.body).replace(/\n/g, '<br>') + '</div>').join('') : '<p class="muted" style="margin:0">No comments yet.</p>';
}
$('edCommentPost').onclick = async () => {
  const body = commentText(); if (!body) { $('edCommentBody').focus(); return; }
  $('edCommentPost').disabled = true;
  const { error } = await sb.from('submission_comments').insert({ submission_id: S.ed.sub.id, body });
  $('edCommentPost').disabled = false;
  if (error) { toast(errText(error)); return; }
  $('edCommentBody').value = ''; loadComments();
};

/* ---------- realtime ---------- */
const reloadList = debounce(() => loadList(), 300);
sb.channel('admin-' + ctx.user.id)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, payload => {
    const n = payload.new || {};
    if (payload.eventType === 'UPDATE' && n.status === 'pending' && (payload.old || {}).status !== 'pending') toast('New submission: ' + n.plan_code);
    reloadList();
    if (S.ed && n.id === S.ed.sub.id && !S.busy) {
      if (n.version !== S.ed.sub.version || n.status !== S.ed.sub.status) {
        if (S.ed.dirty) { $('edAlert').classList.remove('hidden'); $('edAlertT').textContent = n.plan_code + ' changed: now ' + statusLabel(n.status) + ' v' + n.version + '.'; $('edAlertB').innerHTML = '<button class="btn" id="edReload">Reload (discards your unsaved edits)</button>'; $('edReload').onclick = () => { S.ed.dirty = false; openEditor(n.id); }; }
        else openEditor(n.id, { keepMsg: true });
      }
    }
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'submission_comments' }, payload => {
    if (S.ed && payload.new && payload.new.submission_id === S.ed.sub.id) loadComments();
    else if (payload.new && !payload.new.is_admin) toast('New planner comment');
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'plan_events' }, () => reloadList())
  .subscribe(state => { const b = $('liveBadge'); b.textContent = state === 'SUBSCRIBED' ? '● Live' : '● Offline · reload to refresh'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadList(); });

await loadList();
