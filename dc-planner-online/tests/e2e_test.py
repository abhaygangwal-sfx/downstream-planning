"""End-to-end UI test with a mocked Supabase (no network needed).
   1. Same input files in the ORIGINAL planner and the new planner → lane/summary tables must be identical.
   2. Planner: login, draft, submit.  3. Admin: login guard, edit, comment, approve & publish.
   4. Realtime: planner + another user see the published plan without reloading; unpublish/return propagates.
Usage: python3 tests/e2e_test.py /path/to/original.html"""
import sys, os, re, json, subprocess, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FX = ROOT / 'tests' / 'fixtures'
OUT = ROOT / 'tests' / 'output'; OUT.mkdir(exist_ok=True)
ORIG = sys.argv[1]
PORT = 5199
BASE = f'http://localhost:{PORT}'
(ROOT / 'public' / 'config.js').write_text("window.APP_CONFIG={SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_test'};\n")
srv = subprocess.Popen(['node', str(ROOT / 'scripts' / 'dev-server.mjs'), str(PORT)], stdout=subprocess.DEVNULL)
time.sleep(0.8)
MOCK = (ROOT / 'tests' / 'mock-supabase.js').read_text()
results = []
def check(cond, label):
    results.append((bool(cond), label)); print(('PASS ' if cond else 'FAIL ') + label)
TABLES = ['laneBody', 'sumBody', 'neBody', 'ambBody', 'prevBody', 'lhSumBody', 'lhLaneBody', 'lhNEBody', 'lhPrevBody', 'whLaneBody', 'whNEBody', 'whPrevBody', 'foLaneBody', 'foNEBody', 'foPrevBody', 'coeffBody']
KPIS = ['kRows', 'kVol', 'kClients', 'kMiss', 'lhRows', 'lhHit', 'lhFall', 'lhVol', 'whRows', 'whElig', 'whVol', 'foRows', 'foElig', 'foNE', 'foVol']

def load_files(pg):
    pg.set_input_files('#coeffFile', str(FX / 'coefficients.csv'))
    pg.set_input_files('#tmFile', str(FX / 'transport_master.csv'))
    pg.set_input_files('#vcFile', str(FX / 'vehicle_capacity.csv'))
    pg.set_input_files('#rmFile', str(FX / 'route_mapping.csv'))
    pg.wait_for_function("document.getElementById('rmInfo').textContent.includes('OD pairs')")
    pg.select_option('#originSel', 'kolkata dc')
    pg.set_input_files('#dataFile', str(FX / 'floor.csv'))
    pg.set_input_files('#lhFile', str(FX / 'lh_a.csv'))
    pg.set_input_files('#whFile', str(FX / 'warehouse.csv'))
    pg.set_input_files('#foFile', str(FX / 'fm_load.csv'))
    pg.wait_for_function("document.getElementById('foRows').textContent==='3'")
    pg.wait_for_timeout(300)

def snapshot(pg):
    return pg.evaluate("([t,k])=>({t:Object.fromEntries(t.map(i=>[i,document.getElementById(i).innerHTML])),k:Object.fromEntries(k.map(i=>[i,document.getElementById(i).textContent])),note:document.getElementById('laneNote').textContent})", [TABLES, KPIS])

def new_page(ctx):
    pg = ctx.new_page(); pg.set_default_timeout(8000)
    pg.on('dialog', lambda d: d.accept())
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    pg.errs = errs
    return pg

def login(pg, page, email, pw):
    pg.goto(BASE + '/' + page)
    pg.fill('#email', email); pg.fill('#password', pw); pg.click('#loginBtn')

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    # ---------- 1. original ----------
    octx = br.new_context(viewport={'width': 1360, 'height': 1000})
    op = new_page(octx); op.goto('file://' + ORIG); load_files(op)
    orig = snapshot(op)
    check(orig['k']['kRows'] == '6' and 'Kolkata DC-Malda DC' in orig['t']['laneBody'], 'original planner computed lanes from fixtures')

    # ---------- 2. new planner ----------
    ctx = br.new_context(viewport={'width': 1360, 'height': 1000}, bypass_csp=True)  # Playwright's wait helpers use eval; CSP is checked separately below
    ctx.route(re.compile(r'https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js@2/\+esm'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=MOCK))
    a = new_page(ctx)
    a.goto(BASE + '/planner.html'); a.wait_for_url('**/login.html**')
    check(True, 'unauthenticated planner visit redirects to login')
    login(a, 'login.html', 'alice@dc.test', 'wrong')
    a.wait_for_function("document.getElementById('loginErr').textContent.length>0")
    check('incorrect' in a.text_content('#loginErr'), 'wrong password shows a clear error')
    a.fill('#password', 'pw-alice'); a.click('#loginBtn'); a.wait_for_url('**/planner.html')
    a.wait_for_function("document.getElementById('liveBadge').textContent.includes('Live')")
    check('Alice' in a.text_content('#acctWho'), 'planner shows signed-in user')
    check(a.is_hidden('#acctAdmin'), 'admin link hidden for planner')
    load_files(a)
    new = snapshot(a)
    same = [t for t in TABLES if orig['t'][t] == new['t'][t]]
    diff = [t for t in TABLES if orig['t'][t] != new['t'][t]]
    check(not diff, 'all %d result tables identical to the original (diff: %s)' % (len(TABLES), diff))
    check(orig['k'] == new['k'], 'all KPI values identical to the original')
    check(orig['note'] == new['note'], 'lane note identical to the original')
    a.screenshot(path=str(OUT / 'planner_loaded.png'), full_page=True)

    # lane ticks
    a.check('td.plan[data-lane="kolkata dc-malda dc"] input[data-k="adhoc"]')
    a.check('td.plan[data-lane="kolkata dc-siliguri dc"] input[data-k="lh"]')
    a.select_option('td.plan[data-lane="kolkata dc-siliguri dc"] select.vehsel', '32 FT')
    a.click('#draftSave'); a.wait_for_function("document.getElementById('sheetMsg').textContent.includes('saved')")
    log = a.evaluate('window.__mockLog')
    ins = [x for x in log if x.get('t') == 'submissions' and x.get('op') == 'insert'][-1]['val']
    check(sorted(ins.keys()) == ['created_by_name', 'data', 'origin_dc'], 'draft insert sends only granted columns')
    check(ins['origin_dc'] == 'Kolkata DC' and ins['data']['lane_plan']['kolkata dc-malda dc']['adhoc'] is True, 'draft stores origin hub and lane ticks')
    r0 = {x['lane']: x for x in ins['data']['rows']}
    check(r0['Kolkata DC-Siliguri DC']['dc_vehicle'] == '32 FT' and r0['Kolkata DC-Malda DC']['adhoc_required'] == 'yes', 'draft rows carry the DC choices')
    check('Draft' in a.text_content('#subsBody'), 'draft listed in My submissions')
    # reload keeps lane ticks (old version lost them)
    a.reload(); a.wait_for_function("document.getElementById('liveBadge').textContent.includes('Live')")
    check(a.evaluate("DCPlanner.getLanePlan()['kolkata dc-malda dc']?.adhoc===true"), 'lane ticks survive a page reload')
    load_files(a)
    a.fill('#dcName', ''); a.click('#sheetSave')
    a.wait_for_function("document.getElementById('sheetMsg').textContent.includes('name')")
    check(True, 'submit without a name is refused')
    a.fill('#dcName', 'Alice (Kolkata DC)'); a.click('#sheetSave')
    a.wait_for_function("document.getElementById('sheetMsg').textContent.includes('Pending')")
    check('Pending' in a.text_content('#subsBody'), 'submitted plan shows Pending')
    upd = [x for x in a.evaluate('window.__mockLog') if x.get('t') == 'submissions' and x.get('op') == 'update']
    check(len(upd) >= 1 and sorted(upd[-1]['val'].keys()) == ['created_by_name', 'data', 'origin_dc'], 'submit updates the same draft (no duplicate plan)')
    n_subs = a.evaluate("JSON.parse(localStorage.getItem('mockdb.v1')).submissions.length")
    check(n_subs == 1, 'exactly one submission stored')

    # ---------- 3. admin ----------
    ad = new_page(ctx)
    login(ad, 'admin-login.html', 'alice@dc.test', 'pw-alice')
    ad.wait_for_function("document.getElementById('loginErr').textContent.includes('not an admin')")
    check(True, 'planner account refused at admin login')
    ad.goto(BASE + '/admin.html'); ad.wait_for_url('**/admin-login.html**')
    check(True, 'admin page redirects when not signed in as admin')
    ad.fill('#email', 'lh@dc.test'); ad.fill('#password', 'pw-lh'); ad.click('#loginBtn'); ad.wait_for_url('**/admin.html')
    ad.wait_for_selector('#listBody [data-open]')
    check(ad.text_content('#kPend') == '1', 'admin sees 1 pending submission')
    ad.click('#listBody [data-open]'); ad.wait_for_selector('#edBody tr[data-row]')
    rows = ad.locator('#edBody tr[data-row]').count()
    check(rows == len(ins['data']['rows']), 'editor shows every submitted lane')
    idx = [x['lane'] for x in ins['data']['rows']].index('Kolkata DC-Malda DC')
    ad.fill(f'#edBody input[data-i="{idx}"][data-k="approved_vehicle"]', '22 FT'); ad.press(f'#edBody input[data-i="{idx}"][data-k="approved_vehicle"]', 'Tab')
    ad.fill(f'#edBody input[data-i="{idx}"][data-k="approved_vehicle_count"]', '2'); ad.press(f'#edBody input[data-i="{idx}"][data-k="approved_vehicle_count"]', 'Tab')
    ad.fill(f'#edBody input[data-i="{idx}"][data-k="approved_remarks"]', 'ok'); ad.press(f'#edBody input[data-i="{idx}"][data-k="approved_remarks"]', 'Tab')
    ad.fill(f'#edBody input[data-i="{idx}"][data-k="total_volumetric"]', '20'); ad.press(f'#edBody input[data-i="{idx}"][data-k="total_volumetric"]', 'Tab')
    sp = ad.text_content(f'#edBody tr[data-row="{idx}"] td:nth-child(6)')
    check(sp.strip() == '10', 'spillover recalculated as volumetric − capacity (20 − 10 = 10), got %r' % sp)
    check(ad.locator(f'#edBody tr[data-row="{idx}"] td.changed').count() >= 2, 'edited cells highlighted')
    ad.click('#edCopyVeh')
    ad.fill('#edCommentBody', 'Malda moved to 22 FT x2'); ad.click('#edCommentPost')
    ad.wait_for_function("document.getElementById('edComments').textContent.includes('22 FT x2')")
    ad.screenshot(path=str(OUT / 'admin_editor.png'), full_page=True)
    ad.click('#actApprovePub')
    ad.wait_for_function("document.getElementById('edMsg').textContent.includes('published')")
    check('Published' in ad.text_content('#edTitle'), 'admin approve & publish → Published')
    db = json.loads(ad.evaluate("localStorage.getItem('mockdb.v1')"))
    s = db['submissions'][0]; apd = db['approved_plans'][0]
    orow = {x['lane']: x for x in db['submission_versions'][0]['data']['rows']}
    frow = {x['lane']: x for x in apd['final_data']['rows']}
    check(orow['Kolkata DC-Malda DC'].get('approved_vehicle') is None and s['data']['rows'][idx]['total_volumetric'] != 20, 'planner original untouched')
    check(frow['Kolkata DC-Malda DC']['approved_vehicle'] == '22 FT' and frow['Kolkata DC-Malda DC']['total_volumetric'] == 20 and frow['Kolkata DC-Siliguri DC']['approved_vehicle'] == '32 FT', 'final edited data stored separately')

    # ---------- 4. realtime on the planner page (no reload) ----------
    a.wait_for_function("document.querySelector('td.plan[data-lane=\"kolkata dc-malda dc\"]').textContent.includes('Approved v1')", timeout=5000)
    cell = a.text_content('td.plan[data-lane="kolkata dc-malda dc"] .hint')
    check(cell.strip() == 'LH: Approved v1 · 22 FT · count 2 - ok', 'planner lane table updated live: %r' % cell)
    check('Published' in a.text_content('#subsBody') and 'P' in a.text_content('#pubBody'), 'My submissions + Published plans updated live')
    a.wait_for_timeout(1200); bn = a.text_content('#sheetMsg')
    check(bn.startswith('Approved:'), 'status line under Lane totals updated live: %r' % bn)
    a.click('#subsBody [data-open]'); a.wait_for_selector('#subDetail .comment')
    check('22 FT x2' in a.text_content('#subDetail'), 'planner sees admin comment')
    a.fill('#subDetail [data-cbody]', 'Thanks!'); a.click('#subDetail [data-cpost]')
    try:
        ad.wait_for_function("document.getElementById('edComments').textContent.includes('Thanks!')", timeout=5000); ok_reply = True
    except Exception:
        ok_reply = False
        print('DEBUG admin comments:', ad.text_content('#edComments')[:200])
        print('DEBUG db comments:', [c['body'] for c in json.loads(a.evaluate("localStorage.getItem('mockdb.v1')"))['submission_comments']])
        print('DEBUG alice sub detail:', a.text_content('#subDetail')[-300:])
        print('DEBUG admin S.ed?', ad.is_visible('#editor'), ad.text_content('#edMsg'))
    check(ok_reply, 'admin receives planner reply live')
    a.screenshot(path=str(OUT / 'planner_published.png'), full_page=True)

    b = new_page(ctx)
    login(b, 'login.html', 'bob@dc.test', 'pw-bob'); b.wait_for_url('**/planner.html')
    b.wait_for_selector('#pubBody [data-pub]')
    check('No plans yet' in b.text_content('#subsBody'), 'bob cannot see alice\'s submissions')
    check(b.locator('#pubBody [data-pub]').count() == 1, 'bob sees the published plan')
    ad.click('#actUnpublish');
    b.wait_for_function("document.getElementById('pubBody').textContent.includes('Nothing published')", timeout=5000)
    check(True, 'unpublish removes the plan from other users live')
    ad.wait_for_selector('#actPublish:not(.hidden)')
    ad.fill('#edCommentBody', 'Please recheck Patna'); ad.click('#actChanges')
    a.wait_for_function("document.getElementById('subsBody').textContent.includes('Changes requested')", timeout=5000)
    check(True, 'changes requested reaches the planner live')

    nr = new_page(ctx)
    login(nr, 'login.html', 'norole@dc.test', 'pw-none')
    nr.wait_for_function("document.getElementById('loginErr').textContent.includes('no access')")
    check(True, 'account without a role cannot enter')

    for name, pg in [('original', op), ('alice', a), ('admin', ad), ('bob', b)]:
        real = [e for e in pg.errs if 'Failed to load resource' not in e]
        check(not real, f'no JS errors on {name} page: {real[:3]}')
    # CSP check: real headers, no bypass. Pages must run without any CSP violation.
    cctx = br.new_context(viewport={'width': 1360, 'height': 1000})
    cctx.route(re.compile(r'https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js@2/\+esm'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=MOCK))
    for path, sess in [('planner.html', 'u-alice|alice@dc.test'), ('admin.html', 'u-lh|lh@dc.test'), ('login.html', ''), ('index.html', ''), ('reset.html', '')]:
        cp = cctx.new_page(); viol = []
        cp.on('console', lambda m, v=viol: v.append(m.text) if 'Content Security Policy' in m.text else None)
        cp.on('pageerror', lambda e, v=viol: v.append(str(e)))
        if sess:
            i, e = sess.split('|')
            cp.add_init_script('sessionStorage.setItem("mock.session", JSON.stringify({user:{id:"%s",email:"%s"}}))' % (i, e))
        cp.goto(BASE + '/' + path); cp.wait_for_timeout(1500)
        vis = cp.evaluate_handle('document.documentElement.className') if False else None
        check(not viol, f'{path} runs under the production CSP: {viol[:2]}')
        cp.close()
    lp = new_page(ctx); lp.goto(BASE + '/login.html'); lp.wait_for_timeout(300); lp.screenshot(path=str(OUT / 'login.png'))
    br.close()
srv.terminate()
(ROOT / 'public' / 'config.js').unlink()
bad = [l for ok, l in results if not ok]
print('\n%d/%d checks passed' % (len(results) - len(bad), len(results)))
sys.exit(1 if bad else 0)
