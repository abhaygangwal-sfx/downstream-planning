/* In-browser stand-in for @supabase/supabase-js used only by tests/e2e_test.py.
   Data lives in localStorage (shared by all pages of the test origin); realtime uses BroadcastChannel.
   It mirrors the column grants and RPC rules of the migration closely enough to catch wiring mistakes. */
const LS = 'mockdb.v1';
const USERS = {
  'alice@dc.test': { id: 'u-alice', password: 'pw-alice', role: 'user', full_name: 'Alice' },
  'bob@dc.test': { id: 'u-bob', password: 'pw-bob', role: 'user', full_name: 'Bob' },
  'lh@dc.test': { id: 'u-lh', password: 'pw-lh', role: 'admin', full_name: 'LH Admin' },
  'norole@dc.test': { id: 'u-none', password: 'pw-none', role: null, full_name: '' }
};
const byId = id => Object.entries(USERS).find(([, u]) => u.id === id);
const db = () => JSON.parse(localStorage.getItem(LS) || '{"submissions":[],"submission_versions":[],"submission_reviews":[],"approved_plans":[],"submission_comments":[],"plan_events":[]}');
const save = d => localStorage.setItem(LS, JSON.stringify(d));
const sess = () => JSON.parse(sessionStorage.getItem('mock.session') || 'null');
const uid = () => (sess() || {}).user?.id || null;
const isAdmin = () => { const e = byId(uid()); return !!e && e[1].role === 'admin'; };
const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
window.__mockLog = [];
const bc = new BroadcastChannel('mock-rt');
const local = [];
function emit(table, eventType, row, old) { const m = { table, eventType, new: row, old: old || {} }; bc.postMessage(m); local.forEach(f => f(m)); }

/* row-level visibility, like the RLS policies */
function visible(table, r, d) {
  const me = uid(), adm = isAdmin(), owns = sid => d.submissions.some(s => s.id === sid && s.user_id === me);
  if (!me) return false;
  switch (table) {
    case 'submissions': return r.user_id === me || (adm && r.status !== 'draft');
    case 'submission_versions': case 'submission_comments': return adm || owns(r.submission_id);
    case 'submission_reviews': return adm;
    case 'approved_plans': return adm || (r.is_published && !!byId(me)[1].role) || owns(r.submission_id);
    case 'plan_events': return !!byId(me)[1].role;
    case 'user_roles': case 'profiles': return true;
  }
  return false;
}
const GRANTS = { submissions: { insert: ['origin_dc', 'plan_date', 'created_by_name', 'data'], update: ['origin_dc', 'plan_date', 'created_by_name', 'data'] }, submission_comments: { insert: ['submission_id', 'body'] } };
const lanes = d => (d && Array.isArray(d.rows)) ? d.rows.length : 0;
function tableRows(name, d) {
  if (name === 'user_roles') return Object.values(USERS).filter(u => u.role).map(u => ({ user_id: u.id, role: u.role }));
  if (name === 'profiles') return Object.entries(USERS).map(([email, u]) => ({ id: u.id, email, full_name: u.full_name }));
  return d[name] || [];
}
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.one = null; this.ord = null; this.lim = null; }
  select(c) { if (this.op === 'select') this.cols = c; else this.ret = c; return this; }
  eq(k, v) { this.f.push(r => r[k] === v); return this; }
  neq(k, v) { this.f.push(r => r[k] !== v); return this; }
  order(k, o = {}) { this.ord = [k, o.ascending !== false]; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  insert(v) { this.op = 'insert'; this.val = v; return this; }
  update(v) { this.op = 'update'; this.val = v; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
  run() {
    window.__mockLog.push({ t: this.t, op: this.op, val: this.val });
    const d = db(), me = uid();
    if (!me) return { data: null, error: { message: 'JWT expired' } };
    const g = GRANTS[this.t] || {};
    if (this.op === 'insert' || this.op === 'update') {
      const bad = Object.keys(this.val).filter(k => !(g[this.op] || []).includes(k));
      if (bad.length) return { data: null, error: { message: 'permission denied for table ' + this.t + ' (columns ' + bad.join(',') + ')' } };
    }
    let out;
    if (this.op === 'insert') {
      if (this.t === 'submissions') {
        const r = { id: rid(), user_id: me, plan_code: 'P' + now().slice(0, 10).replace(/-/g, '') + '-' + rid().slice(0, 5), origin_dc: '', plan_date: now().slice(0, 10), created_by_name: '', data: {}, status: 'draft', version: 0, submitted_at: null, decided_at: null, created_at: now(), updated_at: now(), ...this.val };
        r.lane_count = lanes(r.data); d.submissions.push(r); save(d); emit('submissions', 'INSERT', r); out = [r];
      } else if (this.t === 'submission_comments') {
        const s = d.submissions.find(x => x.id === this.val.submission_id);
        if (!s || !(isAdmin() || (s.user_id === me && s.status !== 'draft'))) return { data: null, error: { message: 'new row violates row-level security policy' } };
        const r = { id: rid(), ...this.val, author_id: me, author_name: byId(me)[1].full_name, is_admin: isAdmin(), created_at: now() };
        d.submission_comments.push(r); save(d); emit('submission_comments', 'INSERT', r); out = [r];
      }
    } else if (this.op === 'update') {
      out = [];
      d[this.t].forEach(r => {
        if (!this.f.every(f => f(r))) return;
        if (!(r.user_id === me && ['draft', 'changes_requested'].includes(r.status))) return;
        const old = { ...r }; Object.assign(r, this.val, { updated_at: now() }); r.lane_count = lanes(r.data); out.push(r); emit(this.t, 'UPDATE', r, old);
      });
      save(d);
    } else if (this.op === 'delete') {
      const keep = []; out = [];
      d[this.t].forEach(r => { if (this.f.every(f => f(r)) && r.user_id === me && r.status === 'draft') { out.push(r); emit(this.t, 'DELETE', { id: r.id }, { id: r.id }); } else keep.push(r); });
      d[this.t] = keep; save(d);
    } else {
      out = tableRows(this.t, d).filter(r => visible(this.t, r, d) && this.f.every(f => f(r))).map(r => ({ ...r }));
      if (this.cols && this.cols.includes('owner:')) out.forEach(r => { const e = byId(r.user_id); r.owner = e ? { email: e[0], full_name: e[1].full_name } : null; });
      if (this.ord) { const [k, asc] = this.ord; out.sort((a, b) => (String(a[k] ?? '') < String(b[k] ?? '') ? -1 : String(a[k] ?? '') > String(b[k] ?? '') ? 1 : 0) * (asc ? 1 : -1)); }
      if (this.lim) out = out.slice(0, this.lim);
    }
    if (this.one) { if (this.one === 'single' && out.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }; return { data: out[0] || null, error: null }; }
    return { data: out, error: null };
  }
}
function rpc(name, a) {
  window.__mockLog.push({ rpc: name, args: a });
  if (name === 'start_new_version') {
    const d0 = db(), me0 = uid();
    const p = d0.submissions.find(x => x.id === a.p_parent);
    if (!p || p.user_id !== me0) return { data: null, error: { message: 'Submission not found.' } };
    if (!['approved', 'published', 'superseded'].includes(p.status)) return { data: null, error: { message: 'Only an approved or published plan can be edited (this one is ' + p.status + ').' } };
    const root = p.root_id ? d0.submissions.find(x => x.id === p.root_id) : p;
    const fam = d0.submissions.filter(x => x.id === root.id || x.root_id === root.id);
    if (fam.some(x => ['draft', 'pending', 'changes_requested'].includes(x.status))) return { data: null, error: { message: 'A new version of ' + root.plan_code + ' is already in progress. Finish or withdraw it first.' } };
    const n = Math.max(...fam.map(x => x.version || 0)) + 1;
    const child = { ...JSON.parse(JSON.stringify(p)), id: rid(), plan_code: root.plan_code + '-V' + n, status: 'draft', version: n, parent_id: p.id, root_id: root.id, submitted_at: null, decided_at: null, decided_by: null, created_at: now(), updated_at: now() };
    d0.submissions.push(child); save(d0);
    return { data: child, error: null };
  }
  const supersede = (d1, sub) => {
    const r = sub.root_id || sub.id;
    d1.submissions.forEach(x => { if ((x.id === r || x.root_id === r) && x.id !== sub.id && x.status === 'published') x.status = 'superseded'; });
    d1.approved_plans.forEach(x => { const o = d1.submissions.find(y => y.id === x.submission_id); if (o && (o.id === r || o.root_id === r) && o.id !== sub.id) x.is_published = false; });
  };
  const d = db(), me = uid(), adm = isAdmin();
  const s = d.submissions.find(x => x.id === a.p_id);
  const err = m => ({ data: null, error: { message: m } });
  const ev = (event) => { const e = { id: d.plan_events.length + 1, submission_id: s.id, origin_dc: s.origin_dc, event, created_at: now() }; d.plan_events.push(e); return e; };
  const ok = (rows) => !!rows && Array.isArray(rows.rows) && rows.rows.length > 0;
  let result, events = [];
  if (name === 'submit_submission') {
    if (!s || s.user_id !== me) return err('Submission not found.');
    if (!['draft', 'changes_requested'].includes(s.status)) return err('This plan is already ' + s.status + '.');
    if (!ok(s.data)) return err('The plan has no lanes.');
    if (!s.created_by_name.trim()) return err('Type your name first. It is recorded with the plan.');
    const old = { ...s }; Object.assign(s, { status: 'pending', version: s.parent_id ? s.version : s.version + 1, submitted_at: now(), updated_at: now() });
    d.submission_versions.push({ id: d.submission_versions.length + 1, submission_id: s.id, version: s.version, origin_dc: s.origin_dc, plan_date: s.plan_date, created_by_name: s.created_by_name, data: JSON.parse(JSON.stringify(s.data)), submitted_by: me, submitted_at: now() });
    events.push(['submissions', 'UPDATE', s, old], ['plan_events', 'INSERT', ev('submitted')]); result = s;
  } else {
    if (!adm) return err('Admins only.');
    if (!s) return err('Submission not found.');
    const old = { ...s };
    const ap = () => d.approved_plans.find(x => x.submission_id === s.id);
    if (name === 'admin_save_review') {
      if (!ok(a.p_data)) return err('The edited plan has no lanes.');
      d.submission_reviews = d.submission_reviews.filter(x => x.submission_id !== s.id).concat([{ submission_id: s.id, draft_data: a.p_data, updated_by: me, updated_at: now() }]);
      result = d.submission_reviews.at(-1);
    } else if (name === 'approve_submission') {
      if (!['pending', 'approved', 'published'].includes(s.status)) return err('Only pending or approved plans can be approved.');
      if (!ok(a.p_final)) return err('The approved plan has no lanes.');
      d.submission_reviews = d.submission_reviews.filter(x => x.submission_id !== s.id).concat([{ submission_id: s.id, draft_data: a.p_final, updated_by: me, updated_at: now() }]);
      d.approved_plans = d.approved_plans.filter(x => x.submission_id !== s.id).concat([{ submission_id: s.id, plan_code: s.plan_code, origin_dc: s.origin_dc, plan_date: s.plan_date, version: s.version, submitted_by_name: s.created_by_name, final_data: a.p_final, approved_by: me, approved_by_name: byId(me)[1].full_name, approved_at: now(), is_published: !!a.p_publish, published_at: a.p_publish ? now() : null }]);
      if (a.p_publish) supersede(d, s);
      Object.assign(s, { status: a.p_publish ? 'published' : 'approved', decided_at: now(), updated_at: now() });
      events.push(['approved_plans', 'UPDATE', ap()], ['submissions', 'UPDATE', s, old], ['plan_events', 'INSERT', ev(a.p_publish ? 'published' : 'approved')]); result = ap();
    } else if (name === 'publish_submission') {
      const x = ap(); if (!x) return err('Approve the plan before publishing it.');
      if (a.p_publish) supersede(d, s);
      x.is_published = !!a.p_publish; x.published_at = a.p_publish ? now() : null;
      Object.assign(s, { status: a.p_publish ? 'published' : 'approved', updated_at: now() });
      events.push(['submissions', 'UPDATE', s, old], ['plan_events', 'INSERT', ev(a.p_publish ? 'published' : 'unpublished')]); result = x;
    } else if (name === 'return_submission') {
      const x = ap(); if (x) { x.is_published = false; x.published_at = null; }
      Object.assign(s, { status: a.p_status, decided_at: now(), updated_at: now() });
      if ((a.p_comment || '').trim()) { const c = { id: rid(), submission_id: s.id, body: a.p_comment.trim(), author_id: me, author_name: byId(me)[1].full_name, is_admin: true, created_at: now() }; d.submission_comments.push(c); events.push(['submission_comments', 'INSERT', c]); }
      events.push(['submissions', 'UPDATE', s, old], ['plan_events', 'INSERT', ev(a.p_status)]); result = s;
    } else return err('unknown rpc ' + name);
  }
  save(d); events.forEach(e => emit(...e));
  return { data: result, error: null };
}
export function createClient() {
  const authCbs = [];
  return {
    auth: {
      async getSession() { return { data: { session: sess() } }; },
      async signInWithPassword({ email, password }) {
        const u = USERS[email];
        if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
        const s = { user: { id: u.id, email } }; sessionStorage.setItem('mock.session', JSON.stringify(s)); return { data: s, error: null };
      },
      async signOut() { sessionStorage.removeItem('mock.session'); authCbs.forEach(f => f('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange(cb) { authCbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async resetPasswordForEmail() { return { error: null }; },
      async updateUser() { return { data: {}, error: null }; },
      async exchangeCodeForSession() { return { data: {}, error: null }; }
    },
    from: t => new Q(t),
    rpc: async (n, a) => rpc(n, a),
    channel() {
      const hs = [];
      const deliver = m => hs.forEach(([o, f]) => {
        if (o.table !== m.table || (o.event !== '*' && o.event !== m.eventType)) return;
        if (o.filter) { const [k, v] = o.filter.split('=eq.'); if ((m.new || {})[k] !== v) return; }
        if (m.eventType !== 'DELETE' && !visible(m.table, m.new, db())) return;  // RLS on realtime
        f({ eventType: m.eventType, new: m.new, old: m.old });
      });
      const ch = {
        on(_k, o, f) { hs.push([o, f]); return ch; },
        subscribe(cb) { bc.addEventListener('message', e => setTimeout(() => deliver(e.data), 150));  /* cross-tab localStorage needs a moment to sync */ local.push(deliver); setTimeout(() => cb && cb('SUBSCRIBED'), 10); return ch; }
      };
      return ch;
    }
  };
}
