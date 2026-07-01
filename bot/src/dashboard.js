import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import { getRunnerLogs, getDailyRunnerStats, getRunnerLogCount, stats } from './db.js';
import { listJobs } from './discord-runner.js';

const PORT     = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const sessions = new Map(); // token → expiry
let botClient  = null;
let startTime  = Date.now();

export function startDashboard(client) {
  botClient  = client;
  startTime  = Date.now();
  createServer(handleRequest).listen(PORT, () => {
    console.log(`🌐 Dashboard พร้อมใช้งาน → port ${PORT}`);
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  if (!PASSWORD) return true;
  const cookie = parseCookie(req.headers['cookie'] ?? '');
  const token  = cookie['nd_session'];
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function parseCookie(str) {
  return Object.fromEntries(str.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }).filter(([k]) => k));
}

function createSession() {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  return token;
}

// ── Router ────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url    = new URL(req.url, `http://localhost`);
  const path   = url.pathname;
  const method = req.method;

  if (path === '/health') return send(res, 200, 'text/plain', 'OK');

  if (path === '/login' && method === 'GET')  return send(res, 200, 'text/html; charset=utf-8', loginPage());
  if (path === '/login' && method === 'POST') return handleLogin(req, res);

  if (!checkAuth(req)) return redirect(res, '/login');

  if (path === '/api/status') return apiStatus(res);
  if (path === '/api/logs')   return apiLogs(res, url.searchParams);
  if (path === '/api/daily')  return apiDaily(res);

  if (path === '/' || path === '') return send(res, 200, 'text/html; charset=utf-8', dashboardPage());
  return send(res, 404, 'text/plain', 'Not found');
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const pw = params.get('password') ?? '';
  if (!PASSWORD || createHash('sha256').update(pw).digest('hex') === createHash('sha256').update(PASSWORD).digest('hex')) {
    const token = createSession();
    res.writeHead(302, {
      'Set-Cookie': `nd_session=${token}; HttpOnly; Path=/; Max-Age=86400`,
      Location: '/',
    });
    res.end();
  } else {
    send(res, 200, 'text/html; charset=utf-8', loginPage('รหัสผ่านไม่ถูกต้อง'));
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}

// ── API ───────────────────────────────────────────────────────────────────────

function apiStatus(res) {
  const mem  = process.memoryUsage();
  const jobs = listJobs();
  const q    = stats();
  const data = {
    online:      botClient?.isReady() ?? false,
    tag:         botClient?.user?.tag ?? '—',
    uptime:      formatUptime(Math.floor((Date.now() - startTime) / 1000)),
    ping:        botClient?.ws?.ping ?? -1,
    ram: {
      rss:       toMB(mem.rss),
      heapUsed:  toMB(mem.heapUsed),
      heapTotal: toMB(mem.heapTotal),
    },
    activeJobs:  jobs.length,
    jobs:        jobs.map(j => ({
      userId:    j.userId,
      status:    j.status,
      quest:     j.currentQuestName ?? '—',
      progress:  j.currentPct ?? 0,
      index:     j.currentIndex ?? 0,
      total:     j.totalFound ?? 0,
    })),
    quests: q,
  };
  send(res, 200, 'application/json', JSON.stringify(data));
}

function apiLogs(res, params) {
  const date   = params.get('date')   || null;
  const status = params.get('status') || null;
  const page   = Math.max(0, parseInt(params.get('page') || '0', 10));
  const limit  = 50;
  const offset = page * limit;
  const logs   = getRunnerLogs({ limit, offset, date, status });
  const total  = getRunnerLogCount({ date, status });
  send(res, 200, 'application/json', JSON.stringify({ logs, total, page, limit }));
}

function apiDaily(res) {
  const rows = getDailyRunnerStats(30);
  send(res, 200, 'application/json', JSON.stringify(rows));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMB(n) { return (n / 1024 / 1024).toFixed(1); }
function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Login Page ────────────────────────────────────────────────────────────────

function loginPage(error = '') {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeverDie — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e12;color:#e8e8f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#1e1e2a;border:1px solid #2a2a3a;border-radius:16px;padding:40px 36px;width:100%;max-width:380px}
h1{font-size:20px;margin-bottom:6px;text-align:center}
.sub{font-size:13px;color:#72727e;text-align:center;margin-bottom:28px}
label{font-size:13px;color:#aaa;display:block;margin-bottom:6px}
input{width:100%;padding:11px 14px;background:#12121a;border:1px solid #2a2a3a;border-radius:8px;color:#e8e8f0;font-size:14px;margin-bottom:18px}
input:focus{outline:none;border-color:#5865f2}
button{width:100%;padding:12px;background:#5865f2;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#4752c4}
.err{background:#2a1a1a;border:1px solid #ed4245;border-radius:8px;padding:10px 14px;font-size:13px;color:#ed4245;margin-bottom:16px}
</style></head><body>
<div class="box">
  <h1>🎮 NeverDie Quest Bot</h1>
  <div class="sub">Admin Dashboard</div>
  ${error ? `<div class="err">⚠️ ${error}</div>` : ''}
  <form method="POST" action="/login">
    <label>รหัสผ่าน</label>
    <input type="password" name="password" placeholder="••••••••" autofocus>
    <button type="submit">เข้าสู่ระบบ</button>
  </form>
</div>
</body></html>`;
}

// ── Dashboard Page ────────────────────────────────────────────────────────────

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeverDie — Admin Dashboard</title>
<style>
:root{--bg:#0e0e12;--surface:#16161e;--card:#1e1e2a;--border:#2a2a3a;--accent:#5865f2;--green:#57f287;--yellow:#fee75c;--red:#ed4245;--text:#e8e8f0;--muted:#72727e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}

/* Header */
header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 28px;display:flex;align-items:center;gap:12px}
header h1{font-size:17px;font-weight:700}
header .sub{font-size:12px;color:var(--muted);margin-top:2px}
.status-dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);margin-left:auto}
.status-dot.off{background:var(--red);box-shadow:0 0 6px var(--red)}
#bot-tag{font-size:13px;color:var(--muted)}
#uptime-val{font-size:13px;color:var(--muted);margin-left:12px}

/* Tabs */
.tabs{display:flex;gap:0;background:var(--surface);border-bottom:1px solid var(--border);padding:0 28px}
.tab{padding:14px 20px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted);transition:all .15s}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab:hover:not(.active){color:var(--text)}

/* Content */
main{max-width:1100px;margin:0 auto;padding:28px 24px}
.pane{display:none}.pane.active{display:block}

/* Stat grid */
.grid{display:grid;gap:14px;margin-bottom:24px}
.grid-5{grid-template-columns:repeat(5,1fr)}
.grid-3{grid-template-columns:repeat(3,1fr)}
@media(max-width:800px){.grid-5,.grid-3{grid-template-columns:repeat(2,1fr)}}

.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.stat .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.stat .val{font-size:26px;font-weight:700}
.c-green{color:var(--green)}.c-yellow{color:var(--yellow)}.c-red{color:var(--red)}.c-blue{color:var(--accent)}.c-muted{color:var(--muted)}

/* RAM bar */
.ram-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin-bottom:24px}
.ram-card h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px}
.ram-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.ram-label{font-size:13px;width:100px;color:var(--muted)}
.ram-bar{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
.ram-fill{height:100%;border-radius:4px;transition:width .4s}
.ram-val{font-size:13px;font-weight:600;width:70px;text-align:right}

/* Active jobs */
.jobs-section{margin-bottom:24px}
.jobs-section h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}
.job-row{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:8px}
.job-head{display:flex;justify-content:space-between;margin-bottom:8px}
.job-name{font-size:14px;font-weight:600}
.badge{font-size:11px;padding:2px 10px;border-radius:10px;font-weight:600}
.badge-run{background:#1a2f1a;color:var(--green);border:1px solid var(--green)}
.badge-err{background:#2a1a1a;color:var(--red);border:1px solid var(--red)}
.pbar{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.pbar-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .3s}
.pbar-lbl{font-size:11px;color:var(--muted);margin-top:4px;text-align:right}

/* Table */
.tbl-wrap{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px}
.tbl-toolbar{padding:14px 18px;display:flex;gap:10px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
.tbl-toolbar select,.tbl-toolbar input{background:#12121a;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;font-size:13px}
.tbl-toolbar select:focus,.tbl-toolbar input:focus{outline:none;border-color:var(--accent)}
table{width:100%;border-collapse:collapse}
th{padding:11px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);text-align:left;border-bottom:1px solid var(--border);background:var(--surface)}
td{padding:11px 14px;font-size:13px;border-bottom:1px solid #1a1a26;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#181826}
.pill{display:inline-block;padding:2px 9px;border-radius:8px;font-size:11px;font-weight:600}
.pill-ok{background:#1a3a1a;color:var(--green)}
.pill-fail{background:#2a1a1a;color:var(--red)}
.pill-abort{background:#2a2a1a;color:var(--yellow)}
.muted{color:var(--muted)}

/* Pagination */
.pager{display:flex;gap:8px;align-items:center;padding:12px 18px;font-size:13px;color:var(--muted)}
.pager button{padding:6px 14px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer;font-size:13px}
.pager button:hover{border-color:var(--accent);color:var(--accent)}
.pager button:disabled{opacity:.35;cursor:default}

/* Daily */
.daily-grid{display:grid;grid-template-columns:1fr;gap:0;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
</style>
</head>
<body>

<header>
  <span style="font-size:22px">🎮</span>
  <div>
    <h1>NeverDie Quest Bot — Admin</h1>
    <div class="sub">Operational Dashboard</div>
  </div>
  <div id="bot-tag" style="margin-left:auto"></div>
  <div id="uptime-val"></div>
  <div class="status-dot off" id="dot"></div>
</header>

<div class="tabs">
  <div class="tab active" data-tab="overview">📊 ภาพรวม</div>
  <div class="tab" data-tab="runners">⚡ Runner Logs</div>
  <div class="tab" data-tab="daily">📅 รายงานรายวัน</div>
</div>

<main>

<!-- ══ OVERVIEW ═══════════════════════════════════════════ -->
<div class="pane active" id="tab-overview">

  <div class="grid grid-5">
    <div class="stat"><div class="lbl">Ping</div><div class="val c-green" id="o-ping">—</div></div>
    <div class="stat"><div class="lbl">Active Runners</div><div class="val c-yellow" id="o-jobs">—</div></div>
    <div class="stat"><div class="lbl">Quest ทั้งหมด</div><div class="val c-blue" id="o-total">—</div></div>
    <div class="stat"><div class="lbl">เสร็จสิ้น</div><div class="val c-green" id="o-done">—</div></div>
    <div class="stat"><div class="lbl">เกิน Deadline</div><div class="val c-red" id="o-over">—</div></div>
  </div>

  <div class="ram-card">
    <h3>🧠 หน่วยความจำ (RAM)</h3>
    <div class="ram-row">
      <div class="ram-label">RSS (ทั้งหมด)</div>
      <div class="ram-bar"><div class="ram-fill" id="ram-rss-bar" style="background:var(--accent);width:0%"></div></div>
      <div class="ram-val c-blue" id="ram-rss">— MB</div>
    </div>
    <div class="ram-row">
      <div class="ram-label">Heap ที่ใช้</div>
      <div class="ram-bar"><div class="ram-fill" id="ram-heap-bar" style="background:var(--green);width:0%"></div></div>
      <div class="ram-val c-green" id="ram-heap">— MB</div>
    </div>
    <div class="ram-row">
      <div class="ram-label">Heap ทั้งหมด</div>
      <div class="ram-bar"><div class="ram-fill" id="ram-htotal-bar" style="background:var(--muted);width:0%"></div></div>
      <div class="ram-val c-muted" id="ram-htotal">— MB</div>
    </div>
  </div>

  <div class="jobs-section">
    <h3>⚡ Runner ที่กำลังทำงาน</h3>
    <div id="jobs-list"><div class="stat" style="text-align:center;color:var(--muted);font-size:14px">ไม่มี Runner ที่กำลังทำงาน</div></div>
  </div>

</div>

<!-- ══ RUNNER LOGS ════════════════════════════════════════ -->
<div class="pane" id="tab-runners">
  <div class="tbl-wrap">
    <div class="tbl-toolbar">
      <input type="date" id="filter-date" title="กรองตามวันที่">
      <select id="filter-status">
        <option value="">ทุกสถานะ</option>
        <option value="completed">✅ สำเร็จ</option>
        <option value="failed">❌ ล้มเหลว</option>
        <option value="aborted">⚠️ ยกเลิก</option>
      </select>
      <button onclick="loadLogs(0)" style="padding:7px 16px;background:var(--accent);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:13px">ค้นหา</button>
      <span style="margin-left:auto;font-size:13px;color:var(--muted)" id="log-count"></span>
    </div>
    <table>
      <thead><tr>
        <th>วันที่-เวลา</th>
        <th>Discord User</th>
        <th>Server</th>
        <th>ชื่อ Quest</th>
        <th>ประเภท</th>
        <th>สถานะ</th>
        <th>Error</th>
      </tr></thead>
      <tbody id="log-body"><tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">กำลังโหลด...</td></tr></tbody>
    </table>
    <div class="pager">
      <button id="btn-prev" onclick="changePage(-1)" disabled>← ก่อนหน้า</button>
      <span id="page-info">หน้า 1</span>
      <button id="btn-next" onclick="changePage(1)">ถัดไป →</button>
    </div>
  </div>
</div>

<!-- ══ DAILY ══════════════════════════════════════════════ -->
<div class="pane" id="tab-daily">
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>วันที่</th>
        <th>ทำทั้งหมด</th>
        <th>✅ สำเร็จ</th>
        <th>❌ ล้มเหลว</th>
        <th>⚠️ ยกเลิก</th>
        <th>ผู้ใช้ (unique)</th>
        <th>Server (unique)</th>
        <th>อัตราสำเร็จ</th>
      </tr></thead>
      <tbody id="daily-body"><tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">กำลังโหลด...</td></tr></tbody>
    </table>
  </div>
</div>

</main>

<script>
// ── Tabs ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'runners' && !logsLoaded) loadLogs(0);
    if (t.dataset.tab === 'daily'   && !dailyLoaded) loadDaily();
  });
});

let logsLoaded = false, dailyLoaded = false;
let currentPage = 0;

// ── Overview ────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    const dot = document.getElementById('dot');
    dot.className = 'status-dot' + (d.online ? '' : ' off');
    document.getElementById('bot-tag').textContent  = d.tag;
    document.getElementById('uptime-val').textContent = '⏱ ' + d.uptime;
    document.getElementById('o-ping').textContent   = d.ping >= 0 ? d.ping + 'ms' : '—';
    document.getElementById('o-jobs').textContent   = d.activeJobs;
    document.getElementById('o-total').textContent  = d.quests.total ?? 0;
    document.getElementById('o-done').textContent   = d.quests.done  ?? 0;
    document.getElementById('o-over').textContent   = d.quests.overdue ?? 0;

    // RAM bars (max 512 MB reference)
    const maxRef = 512;
    const setBar = (id, barId, val) => {
      document.getElementById(id).textContent     = val + ' MB';
      document.getElementById(barId).style.width  = Math.min(100, (val / maxRef) * 100) + '%';
    };
    setBar('ram-rss',    'ram-rss-bar',    d.ram.rss);
    setBar('ram-heap',   'ram-heap-bar',   d.ram.heapUsed);
    setBar('ram-htotal', 'ram-htotal-bar', d.ram.heapTotal);

    // Active jobs
    const jl = document.getElementById('jobs-list');
    if (!d.jobs.length) {
      jl.innerHTML = '<div class="stat" style="text-align:center;color:var(--muted);font-size:14px">ไม่มี Runner ที่กำลังทำงาน</div>';
    } else {
      jl.innerHTML = d.jobs.map(j => \`
        <div class="job-row">
          <div class="job-head">
            <div class="job-name">👤 \${j.userId}</div>
            <span class="badge badge-run">\${j.status}</span>
          </div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:8px">
            Quest: \${j.quest} &nbsp;·&nbsp; \${j.index}/\${j.total}
          </div>
          <div class="pbar"><div class="pbar-fill" style="width:\${j.progress}%"></div></div>
          <div class="pbar-lbl">\${j.progress}%</div>
        </div>
      \`).join('');
    }
  } catch(e) { console.error(e); }
}

// ── Logs ────────────────────────────────────────────────────────
async function loadLogs(page) {
  currentPage = page;
  logsLoaded  = true;
  const date   = document.getElementById('filter-date').value   || '';
  const status = document.getElementById('filter-status').value || '';
  const qs     = new URLSearchParams({ page, ...(date ? {date} : {}), ...(status ? {status} : {}) });
  const d      = await fetch('/api/logs?' + qs).then(r => r.json());
  const tbody  = document.getElementById('log-body');

  document.getElementById('log-count').textContent = 'ทั้งหมด ' + d.total + ' รายการ';
  document.getElementById('page-info').textContent  = 'หน้า ' + (page + 1);
  document.getElementById('btn-prev').disabled = page === 0;
  document.getElementById('btn-next').disabled = (page + 1) * d.limit >= d.total;

  if (!d.logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">ไม่พบข้อมูล</td></tr>';
    return;
  }

  tbody.innerHTML = d.logs.map(l => {
    const pill = l.status === 'completed' ? 'pill-ok' : l.status === 'failed' ? 'pill-fail' : 'pill-abort';
    const icon = l.status === 'completed' ? '✅' : l.status === 'failed' ? '❌' : '⚠️';
    return \`<tr>
      <td class="muted" style="white-space:nowrap">\${l.finished_at?.slice(0,19) ?? '—'}</td>
      <td><span style="font-weight:600">\${l.discord_username ?? '—'}</span><br><span class="muted" style="font-size:11px">\${l.discord_user_id ?? ''}</span></td>
      <td>\${l.guild_name ?? '—'}<br><span class="muted" style="font-size:11px">\${l.guild_id ?? ''}</span></td>
      <td style="max-width:200px">\${l.quest_name ?? '—'}</td>
      <td class="muted">\${l.quest_type ?? '—'}</td>
      <td><span class="pill \${pill}">\${icon} \${l.status}</span></td>
      <td class="muted" style="max-width:180px;font-size:12px;word-break:break-all">\${l.error_msg ?? ''}</td>
    </tr>\`;
  }).join('');
}

function changePage(dir) { loadLogs(currentPage + dir); }

// ── Daily ────────────────────────────────────────────────────────
async function loadDaily() {
  dailyLoaded = true;
  const rows  = await fetch('/api/daily').then(r => r.json());
  const tbody = document.getElementById('daily-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">ยังไม่มีข้อมูล</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const rate = r.total > 0 ? ((r.completed / r.total) * 100).toFixed(1) : '0.0';
    const rateColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--yellow)' : 'var(--red)';
    return \`<tr>
      <td style="font-weight:600">\${r.day}</td>
      <td style="color:var(--accent);font-weight:700">\${r.total}</td>
      <td style="color:var(--green)">\${r.completed}</td>
      <td style="color:var(--red)">\${r.failed}</td>
      <td style="color:var(--yellow)">\${r.aborted}</td>
      <td class="muted">\${r.unique_users}</td>
      <td class="muted">\${r.unique_guilds}</td>
      <td style="color:\${rateColor};font-weight:700">\${rate}%</td>
    </tr>\`;
  }).join('');
}

// ── Init ────────────────────────────────────────────────────────
loadStatus();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
}
