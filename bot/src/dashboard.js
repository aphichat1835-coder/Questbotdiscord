import { createServer } from 'http';
import { stats } from './db.js';
import { listJobs } from './discord-runner.js';

const PORT = process.env.PORT || 3000;
let botClient = null;
let startTime = Date.now();

export function startDashboard(client) {
  botClient = client;
  startTime = Date.now();

  createServer((req, res) => {
    if (req.url === '/api/status') return handleApi(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHTML());
  }).listen(PORT, () => {
    console.log(`🌐 Dashboard พร้อมใช้งาน → port ${PORT}`);
  });
}

function handleApi(res) {
  try {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const jobs = listJobs();
    const questStats = stats();
    const data = {
      online: botClient?.isReady() ?? false,
      tag: botClient?.user?.tag ?? '—',
      uptime,
      uptimeStr: formatUptime(uptime),
      ping: botClient?.ws?.ping ?? -1,
      jobs: jobs.map(j => ({
        userId: j.userId,
        status: j.status ?? 'running',
        current: j.currentQuest ?? '—',
        progress: j.progress ?? 0,
        total: j.totalQuests ?? 0,
        done: j.completedQuests ?? 0,
      })),
      quests: questStats,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NeverDie Quest Bot — Dashboard</title>
<style>
  :root {
    --bg: #0e0e12;
    --surface: #16161e;
    --card: #1e1e2a;
    --border: #2a2a3a;
    --accent: #5865f2;
    --accent2: #57f287;
    --warn: #fee75c;
    --danger: #ed4245;
    --text: #e8e8f0;
    --muted: #72727e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 18px 32px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  header .logo { font-size: 24px; }
  header h1 { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; }
  header .tag { font-size: 13px; color: var(--muted); margin-top: 2px; }
  header .badge {
    margin-left: auto;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    background: #1a3a1a;
    color: var(--accent2);
    border: 1px solid var(--accent2);
  }
  header .badge.offline { background: #3a1a1a; color: var(--danger); border-color: var(--danger); }

  main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }

  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
  @media (max-width: 700px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } }

  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    text-align: center;
  }
  .stat-card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .value.green { color: var(--accent2); }
  .stat-card .value.yellow { color: var(--warn); }
  .stat-card .value.red { color: var(--danger); }
  .stat-card .value.blue { color: var(--accent); }

  .section { margin-bottom: 28px; }
  .section h2 { font-size: 15px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px; }

  .info-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px;
    display: flex;
    gap: 32px;
    flex-wrap: wrap;
  }
  .info-item .label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .info-item .val { font-size: 15px; font-weight: 600; }

  .jobs-list { display: flex; flex-direction: column; gap: 12px; }
  .job-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 22px;
  }
  .job-card .job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .job-card .user { font-size: 14px; font-weight: 600; }
  .job-card .status { font-size: 12px; padding: 3px 10px; border-radius: 10px; background: #1a2f1a; color: var(--accent2); border: 1px solid var(--accent2); }
  .job-card .quest-name { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .progress-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.4s ease; }
  .progress-label { font-size: 12px; color: var(--muted); margin-top: 5px; text-align: right; }

  .empty {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
  }

  .refresh-bar {
    text-align: center;
    padding: 16px;
    color: var(--muted);
    font-size: 12px;
  }
  #countdown { color: var(--accent); font-weight: 600; }
</style>
</head>
<body>

<header>
  <span class="logo">🎮</span>
  <div>
    <h1>NeverDie Quest Bot</h1>
    <div class="tag" id="bot-tag">กำลังโหลด...</div>
  </div>
  <div class="badge offline" id="status-badge">⏳ กำลังเชื่อมต่อ</div>
</header>

<main>

  <div class="grid-4">
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value blue" id="uptime">—</div>
    </div>
    <div class="stat-card">
      <div class="label">Ping</div>
      <div class="value green" id="ping">—</div>
    </div>
    <div class="stat-card">
      <div class="label">Active Runners</div>
      <div class="value yellow" id="active-runners">—</div>
    </div>
    <div class="stat-card">
      <div class="label">Quest ทั้งหมด</div>
      <div class="value blue" id="quest-total">—</div>
    </div>
  </div>

  <div class="section">
    <h2>สถิติ Quest</h2>
    <div class="info-card">
      <div class="info-item">
        <div class="label">เสร็จสิ้น</div>
        <div class="val" id="q-done" style="color:var(--accent2)">—</div>
      </div>
      <div class="info-item">
        <div class="label">ค้างอยู่</div>
        <div class="val" id="q-pending" style="color:var(--warn)">—</div>
      </div>
      <div class="info-item">
        <div class="label">เกิน Deadline</div>
        <div class="val" id="q-overdue" style="color:var(--danger)">—</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Runner ที่กำลังทำงาน</h2>
    <div id="jobs-container"><div class="empty">ไม่มี Runner ที่กำลังทำงานอยู่</div></div>
  </div>

</main>

<div class="refresh-bar">อัปเดตอัตโนมัติทุก <span id="countdown">10</span> วินาที</div>

<script>
let countdown = 10;

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    // Header
    const badge = document.getElementById('status-badge');
    document.getElementById('bot-tag').textContent = data.tag;
    if (data.online) {
      badge.textContent = '🟢 Online';
      badge.className = 'badge';
    } else {
      badge.textContent = '🔴 Offline';
      badge.className = 'badge offline';
    }

    // Stats
    document.getElementById('uptime').textContent = data.uptimeStr;
    document.getElementById('ping').textContent = data.ping >= 0 ? data.ping + 'ms' : '—';
    document.getElementById('active-runners').textContent = data.jobs.length;
    document.getElementById('quest-total').textContent = data.quests.total ?? 0;
    document.getElementById('q-done').textContent = data.quests.done ?? 0;
    document.getElementById('q-pending').textContent = data.quests.pending ?? 0;
    document.getElementById('q-overdue').textContent = data.quests.overdue ?? 0;

    // Jobs
    const container = document.getElementById('jobs-container');
    if (!data.jobs.length) {
      container.innerHTML = '<div class="empty">ไม่มี Runner ที่กำลังทำงานอยู่</div>';
    } else {
      container.innerHTML = '<div class="jobs-list">' + data.jobs.map(j => \`
        <div class="job-card">
          <div class="job-header">
            <div class="user">👤 \${j.userId}</div>
            <div class="status">● \${j.status}</div>
          </div>
          <div class="quest-name">Quest: \${j.current} (\${j.done}/\${j.total})</div>
          <div class="progress-bar"><div class="progress-fill" style="width:\${j.progress}%"></div></div>
          <div class="progress-label">\${j.progress.toFixed(1)}%</div>
        </div>
      \`).join('') + '</div>';
    }
  } catch (e) {
    console.error('fetch error', e);
  }
}

function tick() {
  countdown--;
  document.getElementById('countdown').textContent = countdown;
  if (countdown <= 0) {
    countdown = 10;
    fetchStatus();
  }
}

fetchStatus();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
