/* Planner (user) dashboard: drafts, submit, status tracking, published plans, realtime.
   All calculations stay in planner-core.js; this file only reads window.DCPlanner. */
import { sb, requireUser, signOut, esc, fmtDt, fmtDate, fmtNum, statusTag, statusLabel, toast, debounce, errText } from './common.js';

const $ = id => document.getElementById(id);
const P = window.DCPlanner;
const ctx = await requireUser({ admin: false });
const uid = ctx.user.id;

const DC_NAME_KEY = 'downstreamPlanning.dcName.v1';
const CUR_KEY = 'downstreamPlanning.currentSubmission.v1.' + uid;
const EDITABLE = ['draft', 'changes_requested'];
const LIST_COLS = 'id, plan_code, origin_dc, plan_date, created_by_name, status, version, lane_count, submitted_at, decided_at, updated_at, created_at';

const S = { mine: [], pub: [], current: null, openId: null, openPub: null, busy: false };
try { S.current = localStorage.getItem(CUR_KEY) || null; } catch (e) {}

/* ---------- header ---------- */
$('acctWho').innerHTML = 'Signed in as <b>' + esc(ctx.name) + '</b>' + (ctx.name !== ctx.user.email ? ' <span class="muted">· ' + esc(ctx.user.email) + '</span>' : '');
$('acctAdmin').classList.toggle('hidden', ctx.role !== 'admin');
$('acctOut').onclick = () => signOut('login.html');

/* name recorded with the plan (was saved on this computer before; still is) */
try { $('dcName').value = localStorage.getItem(DC_NAME_KEY) || ctx.profile.full_name || ''; } catch (e) { $('dcName').value = ctx.profile.full_name || ''; }
$('dcName').onchange = () => { try { localStorage.setItem(DC_NAME_KEY, $('dcName').value.trim()); } catch (e) {} };

function sheetMsg(t, bad) { const m = $('sheetMsg'); m.textContent = t; m.style.color = bad ? '#b42318' : ''; }
function setCurrent(id) { S.current = id || null; try { id ? localStorage.setItem(CUR_KEY, id) : localStorage.removeItem(CUR_KEY); } catch (e) {} renderDraftNote(); renderMine(); }
const cur = () => S.mine.find(s => s.id === S.current) || null;
function renderDraftNote() {
  const c = cur();
  $('draftNote').textContent = c ? (EDITABLE.includes(c.status) ? 'Editing ' + c.plan_code + ' (' + statusLabel(c.status).toLowerCase() + ')' : c.plan_code + ' · ' + statusLabel(c.status)) : 'New plan (not saved yet)';
}

/* ---------- data access ---------- */
async function loadMine() {
  const { data, error } = await sb.from('submissions').select(LIST_COLS).eq('user_id', uid).order('updated_at', { ascending: false }).limit(100);
  if (error) throw error;
  S.mine = data || [];
  if (S.current && !S.mine.some(s => s.id === S.current)) setCurrent(null);
  renderMine(); renderDraftNote();
}
async function loadPublished() {
  const { data, error } = await sb.from('approved_plans')
    .select('submission_id, plan_code, origin_dc, plan_date, version, submitted_by_name, approved_by_name, approved_at, published_at, final_data')
    .eq('is_published', true).order('published_at', { ascending: false }).limit(100);
  if (error) throw error;
  S.pub = data || [];
  renderPub(); applyLHStatus();
  if (S.openPub && !S.pub.some(p => p.submission_id === S.openPub)) { S.openPub = null; $('pubDetail').classList.add('hidden'); }
  else if (S.openPub) openPublished(S.openPub);
}
async function refreshAll(quiet) {
  try { await Promise.all([loadMine(), loadPublished()]); if (S.openId) await openSub(S.openId, true); }
  catch (e) { if (!quiet) sheetMsg('Could not load from the server: ' + errText(e) + ' Your plan is still on this computer.', true); }
}

/* ---------- approved vehicle per lane, shown in Lane totals (same text as the Sheets version) ---------- */
function latestPublishedForHub() {
  const hub = P.hubDisplay() || '';
  return S.pub.filter(p => P.normLane(p.origin_dc) === P.normLane(hub))
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0] || null;
}
function applyLHStatus() {
  const p = latestPublishedForHub(), m = {};
  if (p) (p.final_data.rows || []).forEach(x => {
    m[P.normLane(x.lane)] = 'Approved v' + p.version + ' · ' + (x.approved_vehicle || 'no vehicle')
      + (x.approved_vehicle_count ? ' · count ' + x.approved_vehicle_count : '') + (x.approved_remarks ? ' - ' + x.approved_remarks : '');
  });
  P.setLHStatus(m);
  return p;
}
function statusBanner() {
  const p = applyLHStatus(), c = cur(), hub = P.hubDisplay() || 'All hubs';
  let t = p ? 'Approved: ' + p.plan_code + ' v' + p.version + ' by ' + (p.approved_by_name || 'LH') + ' on ' + fmtDt(p.published_at) + '.'
            : 'No published plan for ' + hub + ' yet.';
  if (c && c.status !== 'published' && c.status !== 'draft') {
    const why = { pending: 'Pending approval', changes_requested: 'LH asked for changes', rejected: 'Rejected', approved: 'Approved, not yet published' }[c.status] || statusLabel(c.status);
    t = why + ': ' + c.plan_code + ' v' + c.version + '. ' + (p ? 'Showing published ' + p.plan_code + ' v' + p.version + '.' : 'No published plan for ' + hub + ' yet.');
  }
  sheetMsg(t, c && c.status === 'rejected');
}
$('originSel').addEventListener('change', () => { applyLHStatus(); });

/* ---------- save draft / submit ---------- */
function buildPayload() {
  return { rows: P.planRows(), vehicles: P.vehicleOptions(), lane_plan: P.getLanePlan(), saved_at: new Date().toISOString() };
}
async function saveDraft({ quiet = false } = {}) {
  if (!P.hasData()) { sheetMsg('Load the data sources first.', true); return null; }
  const data = buildPayload();
  if (!data.rows.length) { sheetMsg('No lanes to save. Load the data first.', true); return null; }
  const fields = { origin_dc: P.hubDisplay() || '', created_by_name: $('dcName').value.trim(), data };
  const c = cur();
  let res;
  if (c && EDITABLE.includes(c.status)) res = await sb.from('submissions').update(fields).eq('id', c.id).select(LIST_COLS).single();
  else res = await sb.from('submissions').insert(fields).select(LIST_COLS).single();
  if (res.error) throw res.error;
  setCurrent(res.data.id); await loadMine();
  if (!quiet) sheetMsg('Draft ' + res.data.plan_code + ' saved (' + res.data.lane_count + ' lanes). Only you can see drafts.');
  return res.data;
}
async function guarded(btn, fn) {
  if (S.busy) return; S.busy = true; btn.disabled = true;
  try { await fn(); } catch (e) { sheetMsg('Not saved: ' + errText(e) + ' Nothing is lost; your plan is still on this computer.', true); }
  finally { S.busy = false; setTimeout(() => { btn.disabled = false; }, 1200); }
}
$('draftSave').onclick = () => guarded($('draftSave'), () => saveDraft());
$('sheetSave').onclick = () => guarded($('sheetSave'), async () => {
  const name = $('dcName').value.trim();
  if (!name) { sheetMsg('Type your name first. It is recorded with the plan.', true); $('dcName').focus(); return; }
  try { localStorage.setItem(DC_NAME_KEY, name); } catch (e) {}
  let target;
  if (P.hasData()) target = await saveDraft({ quiet: true });
  else {
    const c = cur();
    if (!c || !EDITABLE.includes(c.status) || !c.lane_count) { sheetMsg('Load the data sources first.', true); return; }
    if (!confirm('The data files are not loaded on this page. Submit the ' + c.lane_count + ' lanes saved in draft ' + c.plan_code + '?')) return;
    if (c.created_by_name !== name) { const { error } = await sb.from('submissions').update({ created_by_name: name }).eq('id', c.id); if (error) throw error; }
    target = c;
  }
  if (!target) return;
  sheetMsg('Submitting ' + target.plan_code + ' for LH approval…');
  const { data, error } = await sb.rpc('submit_submission', { p_id: target.id });
  if (error) throw error;
  await loadMine();
  sheetMsg('Submitted ' + data.plan_code + ' as version ' + data.version + '. Status: Pending LH approval. You will see the decision here automatically.');
  toast('Submitted ' + data.plan_code + ' — pending LH approval');
});
$('sheetRefresh').onclick = async () => { sheetMsg('Refreshing…'); await refreshAll(); statusBanner(); };
$('subsNew').onclick = () => {
  setCurrent(null);
  sheetMsg('Started a new plan. Your next Save draft or Submit creates a new plan code. Lane ticks are kept; change them in Lane totals.');
};

/* ---------- My submissions ---------- */
function renderMine() {
  if (!S.mine.length) { $('subsBody').innerHTML = '<tr><td colspan="7" class="muted">No plans yet. Load your data, then use Save draft or Submit under Lane totals.</td></tr>'; return; }
  $('subsBody').innerHTML = S.mine.map(s => '<tr' + (s.id === S.openId ? ' class="sel"' : '') + '><td><b>' + esc(s.plan_code) + '</b>' + (s.id === S.current ? ' <span class="tag def">current</span>' : '') + '</td><td>' + esc(s.origin_dc || 'All hubs') + '</td><td>' + fmtDate(s.plan_date) + '</td><td class="num">' + fmtNum(s.lane_count, 0) + '</td><td>' + statusTag(s.status) + (s.version ? ' <span class="muted">v' + s.version + '</span>' : '') + '</td><td>' + fmtDt(s.updated_at) + '</td><td><button class="btn" data-open="' + esc(s.id) + '">Open</button></td></tr>').join('');
}
$('subsBody').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openSub(b.dataset.open); });

const LANE_HEAD = '<th>Lane</th><th class="num">Total AWB</th><th class="num">Total volumetric</th><th>Fleet Type</th><th class="num">Vehicle Capacity</th><th class="num">Spillover</th><th>Adhoc</th><th>DC vehicle</th>';
const laneCells = x => '<td>' + esc(P.dispLane(x.lane)) + '</td><td class="num">' + fmtNum(x.total_awb, 0) + '</td><td class="num">' + fmtNum(x.total_volumetric) + '</td><td>' + esc(x.fleet_type) + '</td><td class="num">' + fmtNum(x.vehicle_capacity, 0) + '</td><td class="num ' + (Number(x.spillover) > 0 ? 'spill-pos' : Number(x.spillover) < 0 ? 'spill-neg' : '') + '">' + fmtNum(x.spillover) + '</td><td>' + esc(x.adhoc_required) + '</td><td>' + esc(x.dc_vehicle) + '</td>';
function approvedCells(a, orig) {
  const ch = (k) => orig && String(orig[k] ?? '') !== String(a[k] ?? '') ? ' class="changed" title="You submitted: ' + esc(orig[k] ?? '') + '"' : '';
  return '<td' + ch('approved_vehicle') + '><b>' + esc(a.approved_vehicle || '') + '</b></td><td class="num">' + esc(a.approved_vehicle_count ?? '') + '</td><td class="wrapcell">' + esc(a.approved_remarks || '') + '</td>';
}

async function openSub(id, keepScroll) {
  S.openId = id; renderMine();
  const box = $('subDetail'); box.classList.remove('hidden');
  if (!keepScroll) box.innerHTML = '<p class="muted">Loading…</p>';
  const [{ data: s, error }, { data: ap }, { data: cm }] = await Promise.all([
    sb.from('submissions').select('*').eq('id', id).single(),
    sb.from('approved_plans').select('*').eq('submission_id', id).maybeSingle(),
    sb.from('submission_comments').select('*').eq('submission_id', id).order('created_at')
  ]);
  if (error) { box.innerHTML = '<p class="err">' + esc(errText(error)) + '</p>'; return; }
  const rows = (s.data && s.data.rows) || [];
  const final = ap ? (ap.final_data.rows || []) : null;
  const finalBy = final ? new Map(final.map(r => [P.normLane(r.lane), r])) : null;
  const info = {
    draft: 'Private draft. Only you can see it. Submit it when ready.',
    pending: 'Submitted to the LH team. Waiting for review.',
    changes_requested: 'The LH team asked for changes (see comments). Continue editing, then Submit again.',
    rejected: 'Rejected by the LH team (see comments). Start a new plan if needed.',
    approved: 'Approved by the LH team. It becomes visible to everyone once published.',
    published: 'Approved and published. Everyone can see the approved plan below.'
  }[s.status];
  const showAp = ap && (s.status === 'approved' || s.status === 'published' || ap.is_published);
  box.innerHTML = '<div class="subcard">'
    + '<div class="sectionhead"><h3 style="margin:0">' + esc(s.plan_code) + ' ' + statusTag(s.status) + '</h3><div class="row">'
    + (EDITABLE.includes(s.status) ? '<button class="btn primary" data-act="edit">Continue editing</button>' : '')
    + (s.status !== 'draft' && !EDITABLE.includes(s.status) ? '<button class="btn" data-act="reuse">Use these lane ticks in a new plan</button>' : '')
    + (s.status === 'draft' ? '<button class="btn danger" data-act="del">Delete draft</button>' : '')
    + '<button class="btn" data-act="close">Close</button></div></div>'
    + '<p class="hint">' + esc(info) + '</p>'
    + '<div class="kv"><div><span>Origin hub</span>' + esc(s.origin_dc || 'All hubs') + '</div><div><span>Plan date</span>' + fmtDate(s.plan_date) + '</div><div><span>Recorded name</span>' + esc(s.created_by_name || '–') + '</div><div><span>Version</span>' + (s.version || '–') + '</div><div><span>Submitted</span>' + fmtDt(s.submitted_at) + '</div><div><span>Decision</span>' + fmtDt(s.decided_at) + '</div>'
    + (showAp ? '<div><span>Approved by</span>' + esc(ap.approved_by_name || 'LH') + ' · v' + ap.version + '</div>' : '') + '</div>'
    + '<div class="tablewrap" style="max-height:360px"><table class="plain"><thead><tr>' + LANE_HEAD + (showAp ? '<th>Approved vehicle</th><th class="num">Count</th><th>LH remarks</th>' : '') + '</tr></thead><tbody>'
    + (rows.length ? rows.map(x => { const a = showAp ? (finalBy.get(P.normLane(x.lane)) || {}) : null; return '<tr>' + laneCells(x) + (a ? approvedCells(a, { approved_vehicle: x.dc_vehicle }) : '') + '</tr>'; }).join('') : '<tr><td colspan="11" class="muted">No lanes saved.</td></tr>')
    + '</tbody></table></div>'
    + (showAp ? '<p class="hint" style="margin-top:6px">Highlighted: the approved vehicle differs from the DC vehicle you asked for. Hover to see yours. Other figures the LH team edited are shown in their approved values under Published plans.</p>' : '')
    + renderComments(cm || [], s.status !== 'draft')
    + '</div>';
  box.querySelector('[data-act="close"]').onclick = () => { S.openId = null; box.classList.add('hidden'); renderMine(); };
  const ed = box.querySelector('[data-act="edit"]');
  if (ed) ed.onclick = () => { restoreInto(s); setCurrent(s.id); sheetMsg('Editing ' + s.plan_code + '. Lane ticks and origin hub restored. Load the data files, adjust, then Save draft or Submit.'); $('laneView').scrollIntoView({ behavior: 'smooth' }); };
  const ru = box.querySelector('[data-act="reuse"]');
  if (ru) ru.onclick = () => { restoreInto(s); setCurrent(null); sheetMsg('Lane ticks from ' + s.plan_code + ' copied. Your next Save draft creates a new plan.'); };
  const dl = box.querySelector('[data-act="del"]');
  if (dl) dl.onclick = async () => {
    if (!confirm('Delete draft ' + s.plan_code + '? This cannot be undone.')) return;
    const { error: e2 } = await sb.from('submissions').delete().eq('id', s.id);
    if (e2) { toast(errText(e2)); return; }
    if (S.current === s.id) setCurrent(null);
    S.openId = null; box.classList.add('hidden'); await loadMine(); toast('Draft deleted');
  };
  wireComment(box, s.id);
}
function restoreInto(s) {
  if (s.origin_dc) P.setOrigin(P.normLane(s.origin_dc)); else P.setOrigin('');
  P.setLanePlan((s.data && s.data.lane_plan) || {});
  if (s.created_by_name) $('dcName').value = s.created_by_name;
}
function renderComments(list, canPost) {
  return '<h3 class="sub">Comments</h3><div class="comments">'
    + (list.length ? list.map(c => '<div class="comment' + (c.is_admin ? ' admin' : '') + '"><div class="who">' + esc(c.author_name || '–') + (c.is_admin ? ' · LH team' : '') + ' · ' + fmtDt(c.created_at) + '</div>' + esc(c.body).replace(/\n/g, '<br>') + '</div>').join('') : '<p class="muted" style="margin:0">No comments yet.</p>')
    + '</div>'
    + (canPost ? '<div style="margin-top:8px"><textarea data-cbody placeholder="Reply to the LH team…" maxlength="4000"></textarea><div class="row" style="margin-top:6px"><button class="btn" data-cpost>Post comment</button></div></div>' : '');
}
function wireComment(box, sid) {
  const b = box.querySelector('[data-cpost]'); if (!b) return;
  b.onclick = async () => {
    const ta = box.querySelector('[data-cbody]'), body = ta.value.trim(); if (!body) { ta.focus(); return; }
    b.disabled = true;
    const { error } = await sb.from('submission_comments').insert({ submission_id: sid, body });
    b.disabled = false;
    if (error) { toast(errText(error)); return; }
    ta.value = ''; openSub(sid, true);
  };
}

/* ---------- Published plans ---------- */
function renderPub() {
  if (!S.pub.length) { $('pubBody').innerHTML = '<tr><td colspan="7" class="muted">Nothing published yet.</td></tr>'; return; }
  $('pubBody').innerHTML = S.pub.map(p => '<tr' + (p.submission_id === S.openPub ? ' class="sel"' : '') + '><td><b>' + esc(p.plan_code) + '</b></td><td>' + esc(p.origin_dc || 'All hubs') + '</td><td>' + fmtDate(p.plan_date) + '</td><td class="num">v' + p.version + '</td><td>' + esc(p.submitted_by_name) + '</td><td>' + fmtDt(p.published_at) + ' <span class="muted">by ' + esc(p.approved_by_name || 'LH') + '</span></td><td><button class="btn" data-pub="' + esc(p.submission_id) + '">View</button></td></tr>').join('');
}
$('pubBody').addEventListener('click', e => { const b = e.target.closest('[data-pub]'); if (b) openPublished(b.dataset.pub); });
function openPublished(id) {
  const p = S.pub.find(x => x.submission_id === id); if (!p) return;
  S.openPub = id; renderPub();
  const rows = p.final_data.rows || [];
  const box = $('pubDetail'); box.classList.remove('hidden');
  box.innerHTML = '<div class="subcard"><div class="sectionhead"><h3 style="margin:0">' + esc(p.plan_code) + ' · ' + esc(p.origin_dc || 'All hubs') + ' · v' + p.version + ' ' + statusTag('published') + '</h3><div class="row"><button class="btn" data-pubcsv>Download</button><button class="btn" data-pubclose>Close</button></div></div>'
    + '<p class="hint">Approved by ' + esc(p.approved_by_name || 'LH') + ' on ' + fmtDt(p.approved_at) + '; published ' + fmtDt(p.published_at) + '. Submitted by ' + esc(p.submitted_by_name || '–') + '.</p>'
    + '<div class="tablewrap" style="max-height:420px"><table class="plain"><thead><tr>' + LANE_HEAD + '<th>Approved vehicle</th><th class="num">Count</th><th>LH remarks</th></tr></thead><tbody>'
    + rows.map(x => '<tr>' + laneCells(x) + approvedCells(x) + '</tr>').join('') + '</tbody></table></div></div>';
  box.querySelector('[data-pubclose]').onclick = () => { S.openPub = null; box.classList.add('hidden'); renderPub(); };
  box.querySelector('[data-pubcsv]').onclick = () => downloadRows(p.plan_code + '_v' + p.version + '_approved.csv', rows);
}
const CSV_COLS = ['lane', 'total_awb', 'total_volumetric', 'fleet_type', 'vehicle_capacity', 'spillover', 'adhoc_required', 'lh_aligned', 'dc_vehicle', 'approved_vehicle', 'approved_vehicle_count', 'approved_remarks'];
function downloadRows(name, rows) {
  const cell = v => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(k => cell(r[k])).join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- Realtime ---------- */
const reloadPub = debounce(() => loadPublished().then(statusBanner).catch(() => {}), 250);
const reloadMine = debounce(() => loadMine().then(() => { if (S.openId) openSub(S.openId, true); statusBanner(); }).catch(() => {}), 250);
function live(state) {
  const b = $('liveBadge');
  if (state === 'SUBSCRIBED') { b.textContent = '● Live'; b.className = 'badge'; }
  else { b.textContent = '● Offline · use Refresh'; b.className = 'badge tag def'; }
}
sb.channel('planner-' + uid)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions', filter: 'user_id=eq.' + uid }, payload => {
    const n = payload.new || {}, o = S.mine.find(s => s.id === n.id);
    if (o && n.status && o.status !== n.status && n.status !== 'pending' && n.status !== 'draft')
      toast(n.plan_code + ': ' + statusLabel(n.status));
    reloadMine();
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'plan_events' }, () => reloadPub())
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'submission_comments' }, payload => {
    const c = payload.new || {};
    if (c.is_admin) toast('New LH comment on ' + ((S.mine.find(s => s.id === c.submission_id) || {}).plan_code || 'your plan'));
    if (S.openId === c.submission_id) openSub(S.openId, true);
  })
  .subscribe(live);
/* Catch up after sleep / lost connection (Realtime does not replay missed events). */
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(true).then(statusBanner); });
window.addEventListener('online', () => refreshAll(true).then(statusBanner));

await refreshAll();
statusBanner();
