const http = require('http');

// ── Env vars ──────────────────────────────────────────────────────────────────
const BASE_URL       = (process.env.BASE_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN;
const ALERT_TOKEN    = process.env.ALERT_TOKEN;
const ALERT_PHONE    = process.env.ALERT_PHONE;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || '300000', 10);
const PORT           = parseInt(process.env.PORT || '3000', 10);
const TZ             = process.env.TZ || 'America/Sao_Paulo';

// ── Validate required vars ────────────────────────────────────────────────────
['BASE_URL', 'ADMIN_TOKEN', 'ALERT_TOKEN', 'ALERT_PHONE'].forEach(key => {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

// ── State tracking ────────────────────────────────────────────────────────────
const states   = new Map(); // instanceId -> true|false
let   firstRun = true;
let   lastCheck = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function now() {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ });
}

async function fetchJSON(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── uazapiGO API calls ────────────────────────────────────────────────────────
async function getAllInstances() {
  return fetchJSON(`${BASE_URL}/instance/all`, {
    headers: { admintoken: ADMIN_TOKEN },
  });
}

async function getInstanceStatus(token) {
  return fetchJSON(`${BASE_URL}/instance/status`, {
    headers: { token },
  });
}

async function sendAlert(text) {
  const res = await fetch(`${BASE_URL}/send/text`, {
    method: 'POST',
    headers: { token: ALERT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: ALERT_PHONE, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
}

function label(instance) {
  return instance.name || instance.systemName || instance.id;
}

function isConnectedState(state) {
  return state === 'open';
}

// ── Monitor loop ──────────────────────────────────────────────────────────────
async function monitor() {
  log('Checking instances…');

  let instances;
  try {
    instances = await getAllInstances();
  } catch (err) {
    log(`ERROR fetching instances: ${err.message}`);
    return;
  }

  if (!Array.isArray(instances)) {
    log(`ERROR: /instance/all returned unexpected format`);
    return;
  }

  log(`Found ${instances.length} instance(s)`);

  for (const inst of instances) {
    const id    = inst.id;
    const name  = label(inst);
    const token = inst.token;

    if (!token) {
      log(`  SKIP [${name}]: no token available`);
      continue;
    }

    let statusData;
    try {
      statusData = await getInstanceStatus(token);
    } catch (err) {
      log(`  ERROR [${name}]: ${err.message}`);
      continue;
    }

    // uazapiGO returns { state: "open" | "close" | "connecting" | ... }
    const state       = statusData?.state || statusData?.status || 'unknown';
    const connected   = isConnectedState(state);
    const prev        = states.get(id);

    log(`  [${name}] state=${state}`);

    if (!firstRun) {
      if (!connected && prev === true) {
        // Just went down
        const msg =
          `⚠️ *ALERTA — Instância caiu!*\n` +
          `*Nome:* ${name}\n` +
          `*Estado:* ${state}\n` +
          `*Hora:* ${now()}`;
        log(`ALERT: [${name}] went down`);
        try {
          await sendAlert(msg);
          log(`  Alert sent ✓`);
        } catch (err) {
          log(`  ERROR sending alert: ${err.message}`);
        }
      } else if (connected && prev === false) {
        // Just recovered
        const msg =
          `✅ *RECUPERADO — Instância voltou!*\n` +
          `*Nome:* ${name}\n` +
          `*Hora:* ${now()}`;
        log(`RECOVERY: [${name}] reconnected`);
        try {
          await sendAlert(msg);
          log(`  Recovery alert sent ✓`);
        } catch (err) {
          log(`  ERROR sending recovery alert: ${err.message}`);
        }
      }
    }

    states.set(id, connected);
  }

  lastCheck = new Date().toISOString();

  if (firstRun) {
    const summary = [...states.entries()]
      .map(([, v]) => (v ? '🟢' : '🔴'))
      .join(' ');
    log(`Baseline captured ${summary}. Monitoring ${instances.length} instance(s) every ${CHECK_INTERVAL / 1000}s.`);
    firstRun = false;
  }
}

// ── Health-check HTTP server (for EasyPanel / Docker) ────────────────────────
http.createServer((req, res) => {
  if (req.url === '/health') {
    const connected   = [...states.values()].filter(Boolean).length;
    const disconnected = states.size - connected;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      lastCheck,
      instances: { total: states.size, connected, disconnected },
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => log(`Health-check server listening on port ${PORT}`));

// ── Start ─────────────────────────────────────────────────────────────────────
log(`Starting uazapiGO instance monitor`);
log(`  BASE_URL:        ${BASE_URL}`);
log(`  CHECK_INTERVAL:  ${CHECK_INTERVAL / 1000}s`);
log(`  ALERT_PHONE:     ${ALERT_PHONE}`);

monitor();
setInterval(monitor, CHECK_INTERVAL);
