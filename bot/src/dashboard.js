import { createServer } from 'http';
import { stats } from './db.js';

const PORT = process.env.PORT || 3000;
let botClient = null;
let startTime = Date.now();
let serverStarted = false;

export function startDashboard(client) {
  if (client) {
    botClient = client;
    // startTime intentionally NOT reset here — tracks uptime since process start,
    // not since last reconnect
  }
  if (!serverStarted) {
    serverStarted = true;
    createServer(handleRequest).listen(PORT, () => {
      console.log(`🌐 Dashboard พร้อมใช้งาน → port ${PORT}`);
    });
  }
}

function handleRequest(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/status') return apiStatus(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(dashboardHTML());
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function apiStatus(res) {
  const mem = process.memoryUsage();
  const q   = stats();
  const data = {
    online:    botClient?.isReady() ?? false,
    tag:       botClient?.user?.tag ?? '—',
    uptime:    formatUptime(Math.floor((Date.now() - startTime) / 1000)),
    ping:      botClient?.ws?.ping ?? -1,
    ram: {
      rss:       toMB(mem.rss),
      heapUsed:  toMB(mem.heapUsed),
      heapTotal: toMB(mem.heapTotal),
    },
    quests: q,
  };
  send(res, 200, 'application/json', JSON.stringify(data));
}

const toMB = (n) => (n / 1024 / 1024).toFixed(1);

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeverDie — Dashboard</title>
<style>
:root{--bg:#0e0e12;--surface:#16161e;--card:#1e1e2a;--border:#2a2a3a;--accent:#5865f2;--green:#57f287;--yellow:#fee75c;--red:#ed4245;--text:#e8e8f0;--muted:#72727e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}

header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 28px;display:flex;align-items:center;gap:14px}
.logo{font-size:22px}
header h1{font-size:17px;font-weight:700}
header .sub{font-size:12px;color:var(--muted);margin-top:2px}
#bot-tag{font-size:13px;color:var(--muted);margin-left:auto}
#uptime-val{font-size:13px;color:var(--muted);margin-left:14px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);margin-left:10px;flex-shrink:0}
.dot.off{background:var(--red);box-shadow:0 0 6px var(--red)}

main{max-width:900px;margin:0 auto;padding:32px 24px}

.grid{display:grid;gap:14px;margin-bottom:24px}
.g4{grid-template-columns:repeat(4,1fr)}
.g3{grid-template-columns:repeat(3,1fr)}
@media(max-width:700px){.g4,.g3{grid-template-columns:repeat(2,1fr)}}

.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px}
.card .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.card .val{font-size:28px;font-weight:700}
.cg{color:var(--green)}.cy{color:var(--yellow)}.cr{color:var(--red)}.cb{color:var(--accent)}.cm{color:var(--muted)}

.section-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}

.ram-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin-bottom:24px}
.ram-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.ram-row:last-child{margin-bottom:0}
.ram-lbl{font-size:13px;width:110px;color:var(--muted)}
.ram-bar{flex:1;height:7px;background:var(--border);border-radius:4px;overflow:hidden}
.ram-fill{height:100%;border-radius:4px;transition:width .5s}
.ram-val{font-size:13px;font-weight:600;width:65px;text-align:right}

.refresh{text-align:center;padding:20px;font-size:12px;color:var(--muted)}
#cd{color:var(--accent);font-weight:600}
</style>
</head>
<body>

<header>
  <span class="logo">🎮</span>
  <div>
    <h1>NeverDie Quest Bot</h1>
    <div class="sub">Admin Dashboard</div>
  </div>
  <div id="bot-tag">กำลังโหลด...</div>
  <div id="uptime-val"></div>
  <div class="dot off" id="dot"></div>
</header>

<main>

  <div class="grid g4" style="margin-bottom:24px">
    <div class="card"><div class="lbl">Ping</div><div class="val cb" id="ping">—</div></div>
    <div class="card"><div class="lbl">Quest ทั้งหมด</div><div class="val cb" id="q-total">—</div></div>
    <div class="card"><div class="lbl">เสร็จสิ้น</div><div class="val cg" id="q-done">—</div></div>
    <div class="card"><div class="lbl">เกิน Deadline</div><div class="val cr" id="q-over">—</div></div>
  </div>

  <div class="grid g3" style="margin-bottom:24px">
    <div class="card"><div class="lbl">ค้างอยู่</div><div class="val cy" id="q-pending">—</div></div>
    <div class="card"><div class="lbl">Uptime</div><div class="val cm" id="uptime">—</div></div>
    <div class="card"><div class="lbl">สถานะ</div><div class="val cg" id="status-txt">—</div></div>
  </div>

  <div class="ram-card">
    <div class="section-title" style="margin-bottom:14px">🧠 หน่วยความจำ (RAM)</div>
    <div class="ram-row">
      <div class="ram-lbl">RSS (ทั้งหมด)</div>
      <div class="ram-bar"><div class="ram-fill cb" id="bar-rss" style="background:var(--accent);width:0%"></div></div>
      <div class="ram-val cb" id="val-rss">—</div>
    </div>
    <div class="ram-row">
      <div class="ram-lbl">Heap ที่ใช้</div>
      <div class="ram-bar"><div class="ram-fill" id="bar-heap" style="background:var(--green);width:0%"></div></div>
      <div class="ram-val cg" id="val-heap">—</div>
    </div>
    <div class="ram-row">
      <div class="ram-lbl">Heap ทั้งหมด</div>
      <div class="ram-bar"><div class="ram-fill" id="bar-htotal" style="background:var(--muted);width:0%"></div></div>
      <div class="ram-val cm" id="val-htotal">—</div>
    </div>
  </div>

</main>

<div class="refresh">อัปเดตอัตโนมัติทุก <span id="cd">10</span> วินาที</div>

<script>
async function load() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    const dot = document.getElementById('dot');
    dot.className = 'dot' + (d.online ? '' : ' off');
    document.getElementById('bot-tag').textContent    = d.tag;
    document.getElementById('uptime-val').textContent = '⏱ ' + d.uptime;
    document.getElementById('uptime').textContent     = d.uptime;
    document.getElementById('ping').textContent       = d.ping >= 0 ? d.ping + 'ms' : '—';
    document.getElementById('status-txt').textContent = d.online ? '🟢 Online' : '🔴 Offline';
    document.getElementById('status-txt').className   = 'val ' + (d.online ? 'cg' : 'cr');
    document.getElementById('q-total').textContent    = d.quests.total   ?? 0;
    document.getElementById('q-done').textContent     = d.quests.done    ?? 0;
    document.getElementById('q-over').textContent     = d.quests.overdue ?? 0;
    document.getElementById('q-pending').textContent  = d.quests.pending ?? 0;

    const max = 512;
    const setRam = (valId, barId, val) => {
      document.getElementById(valId).textContent   = val + ' MB';
      document.getElementById(barId).style.width   = Math.min(100, (val / max) * 100) + '%';
    };
    setRam('val-rss',    'bar-rss',    d.ram.rss);
    setRam('val-heap',   'bar-heap',   d.ram.heapUsed);
    setRam('val-htotal', 'bar-htotal', d.ram.heapTotal);
  } catch(e) { console.error(e); }
}

let cd = 10;
load();
setInterval(() => {
  cd--;
  document.getElementById('cd').textContent = cd;
  if (cd <= 0) { cd = 10; load(); }
}, 1000);
</script>
</body>
</html>`;
}
