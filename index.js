'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { proxyRequest, ENDPOINT_PATHS } = require('./src/proxy');

// ══════════════════════════════════════════════
//  CONFIG — edit or use env vars
// ══════════════════════════════════════════════
const config = {
  // Port this proxy listens on
  port: parseInt(process.env.PROXY_PORT ?? '4000', 10),

  // Backend LLM server base URL
  backendUrl: process.env.BACKEND_URL ?? 'https://api.openai.com',

  // Which endpoint format does the BACKEND expose?
  // 'chat'      → backend uses /v1/chat/completions  (OpenAI style)
  // 'messages'  → backend uses /v1/messages          (Anthropic style)
  // 'responses' → backend uses /v1/responses         (OpenAI Responses API)
  backendFormat: process.env.BACKEND_FORMAT ?? 'chat',

  // Optional: override API key sent to backend
  apiKey: process.env.BACKEND_API_KEY ?? '',

  // Optional: Anthropic-version header (when targeting Anthropic)
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? '2023-06-01',
};

// ══════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════
const stats = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  activeRequests: 0,
  totalLatencyMs: 0,
  lastRequest: null,
  startTime: new Date().toISOString(),
};

// ══════════════════════════════════════════════
//  EXPRESS APP
// ══════════════════════════════════════════════
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Health & info ────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    config: {
      port: config.port,
      backendUrl: config.backendUrl,
      backendFormat: config.backendFormat,
    },
    stats: {
      ...stats,
      avgLatencyMs: stats.totalRequests
        ? Math.round(stats.totalLatencyMs / stats.totalRequests)
        : 0,
    },
  });
});

app.get('/config', (req, res) => res.json({ ...config, apiKey: config.apiKey ? '***' : '' }));

// ── Live config update (runtime) ─────────────
app.patch('/config', express.json(), (req, res) => {
  const allowed = ['backendUrl', 'backendFormat', 'apiKey', 'anthropicVersion'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) config[key] = req.body[key];
  }
  console.log('[config] Updated:', req.body);
  res.json({ ok: true, config: { ...config, apiKey: config.apiKey ? '***' : '' } });
});

// ── Dashboard (served at root) ────────────────
app.get('/', (req, res) => {
  res.send(getDashboardHTML(config, stats));
});

// ══════════════════════════════════════════════
//  PROXY ENDPOINTS — all three conventions
// ══════════════════════════════════════════════

const proxyHandler = (req, res) => proxyRequest(req, res, config, stats);

// Accept any body (raw text or JSON passed through)
app.post('/v1/chat/completions', proxyHandler);
app.post('/v1/messages', proxyHandler);
app.post('/v1/responses', proxyHandler);

// Also accept without /v1/ prefix for convenience
app.post('/chat/completions', proxyHandler);
app.post('/messages', proxyHandler);
app.post('/responses', proxyHandler);

// Model listing passthrough
app.get('/v1/models', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    const r = await fetch(`${config.backendUrl}/v1/models`, { headers });
    const body = await r.text();
    res.status(r.status).set('Content-Type', 'application/json').send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════
app.listen(config.port, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         LLM Universal Proxy  v1.0            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Listening on  → http://localhost:${config.port}       ║`);
  console.log(`║  Backend URL   → ${config.backendUrl.padEnd(26)}║`);
  console.log(`║  Backend fmt   → ${config.backendFormat.padEnd(26)}║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Endpoints exposed:                           ║');
  console.log('║    POST /v1/chat/completions  (OpenAI)        ║');
  console.log('║    POST /v1/messages          (Anthropic)     ║');
  console.log('║    POST /v1/responses         (OAI Responses) ║');
  console.log('║  Dashboard → http://localhost:' + config.port + '           ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});

// ══════════════════════════════════════════════
//  DASHBOARD HTML
// ══════════════════════════════════════════════
function getDashboardHTML(cfg, st) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Proxy Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;600;800&display=swap');

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --surface2: #1a1a24;
    --border: #2a2a3a;
    --accent: #7c6cfc;
    --accent2: #fc6c8f;
    --accent3: #6cfcd4;
    --text: #e8e8f0;
    --muted: #888898;
    --success: #4ade80;
    --warning: #facc15;
    --error: #f87171;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Space Mono', monospace;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Animated grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    max-width: 1100px;
    margin: 0 auto;
    padding: 40px 24px;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 48px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 24px;
  }

  .logo {
    font-family: 'Syne', sans-serif;
    font-weight: 800;
    font-size: 28px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .version {
    font-size: 11px;
    color: var(--muted);
    background: var(--surface2);
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 8px var(--success);
    animation: pulse 2s infinite;
    margin-left: auto;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    position: relative;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent);
  }

  .card:hover { border-color: var(--accent); }

  .card-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .card-value {
    font-family: 'Syne', sans-serif;
    font-size: 32px;
    font-weight: 800;
    color: var(--text);
    line-height: 1;
  }

  .card-value.accent { color: var(--accent); }
  .card-value.success { color: var(--success); }
  .card-value.error { color: var(--error); }
  .card-value.warning { color: var(--warning); }

  .card-sub {
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
  }

  .section {
    margin-bottom: 32px;
  }

  .section-title {
    font-family: 'Syne', sans-serif;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .section-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .config-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .config-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }

  .config-key {
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 6px;
  }

  .config-val {
    font-size: 14px;
    color: var(--accent3);
    word-break: break-all;
  }

  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .badge-chat { background: rgba(124,108,252,0.2); color: var(--accent); border: 1px solid var(--accent); }
  .badge-messages { background: rgba(252,108,143,0.2); color: var(--accent2); border: 1px solid var(--accent2); }
  .badge-responses { background: rgba(108,252,212,0.2); color: var(--accent3); border: 1px solid var(--accent3); }

  .endpoints {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .endpoint {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    font-size: 13px;
  }

  .method {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(124,108,252,0.3);
    color: var(--accent);
    flex-shrink: 0;
  }

  .path { color: var(--text); flex: 1; }
  .path span { color: var(--muted); }

  .arrow {
    color: var(--muted);
    font-size: 16px;
  }

  .target-format {
    font-size: 11px;
    color: var(--muted);
  }

  .test-area {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
  }

  .test-row {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  select, input, button {
    font-family: 'Space Mono', monospace;
    font-size: 12px;
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    outline: none;
    transition: border-color 0.2s;
  }

  select:focus, input:focus { border-color: var(--accent); }

  input { flex: 1; min-width: 200px; }

  button {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
    cursor: pointer;
    font-weight: 700;
    padding: 8px 20px;
    transition: opacity 0.2s, transform 0.1s;
  }

  button:hover { opacity: 0.9; }
  button:active { transform: scale(0.98); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .response-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    font-size: 12px;
    line-height: 1.6;
    min-height: 120px;
    max-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--accent3);
    font-family: 'Space Mono', monospace;
  }

  .log-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    font-size: 11px;
    line-height: 1.8;
    max-height: 200px;
    overflow-y: auto;
    color: var(--muted);
  }

  .log-entry { margin-bottom: 2px; }
  .log-time { color: var(--accent); }
  .log-ok { color: var(--success); }
  .log-err { color: var(--error); }

  .map-diagram {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
  }

  .format-box {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }

  .format-box-title {
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .format-pills { display: flex; flex-direction: column; gap: 6px; align-items: center; }

  .arrow-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font-size: 20px;
  }

  .arrow-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    text-align: center;
  }

  footer {
    text-align: center;
    padding-top: 32px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    line-height: 2;
  }

  @media (max-width: 600px) {
    .config-grid { grid-template-columns: 1fr; }
    .map-diagram { grid-template-columns: 1fr; }
    .arrow-col { transform: rotate(90deg); }
  }
</style>
</head>
<body>
<div class="container">

  <header>
    <span class="logo">LLM Proxy</span>
    <span class="version">v1.0</span>
    <div class="status-dot" title="Running"></div>
  </header>

  <!-- Stats Grid -->
  <div class="section">
    <div class="section-title">Live Stats</div>
    <div class="grid" id="stats-grid">
      <div class="card">
        <div class="card-label">Total Requests</div>
        <div class="card-value accent" id="stat-total">0</div>
      </div>
      <div class="card">
        <div class="card-label">Active</div>
        <div class="card-value warning" id="stat-active">0</div>
      </div>
      <div class="card">
        <div class="card-label">Success</div>
        <div class="card-value success" id="stat-success">0</div>
      </div>
      <div class="card">
        <div class="card-label">Errors</div>
        <div class="card-value error" id="stat-errors">0</div>
      </div>
      <div class="card">
        <div class="card-label">Avg Latency</div>
        <div class="card-value" id="stat-latency">—</div>
        <div class="card-sub">milliseconds</div>
      </div>
    </div>
  </div>

  <!-- Config -->
  <div class="section">
    <div class="section-title">Configuration</div>
    <div class="config-grid">
      <div class="config-item">
        <div class="config-key">Backend URL</div>
        <div class="config-val" id="cfg-url">${cfg.backendUrl}</div>
      </div>
      <div class="config-item">
        <div class="config-key">Backend Format</div>
        <div class="config-val">
          <span class="badge badge-${cfg.backendFormat}" id="cfg-fmt">${cfg.backendFormat}</span>
        </div>
      </div>
      <div class="config-item">
        <div class="config-key">Proxy Port</div>
        <div class="config-val">${cfg.port}</div>
      </div>
      <div class="config-item">
        <div class="config-key">API Key</div>
        <div class="config-val">${cfg.apiKey ? '●●●●●●●●' : '(from client)'}</div>
      </div>
    </div>
  </div>

  <!-- Translation Map -->
  <div class="section">
    <div class="section-title">Translation Map</div>
    <div class="map-diagram">
      <div class="format-box">
        <div class="format-box-title">Client Sends</div>
        <div class="format-pills">
          <span class="badge badge-chat">chat/completions</span>
          <span class="badge badge-messages">messages</span>
          <span class="badge badge-responses">responses</span>
        </div>
      </div>
      <div class="arrow-col">
        <div>⇄</div>
        <div class="arrow-label">auto<br>translate</div>
      </div>
      <div class="format-box">
        <div class="format-box-title">Backend Expects</div>
        <div class="format-pills">
          <span class="badge badge-${cfg.backendFormat}" id="target-badge">${cfg.backendFormat}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Exposed Endpoints -->
  <div class="section">
    <div class="section-title">Exposed Endpoints</div>
    <div class="endpoints">
      <div class="endpoint">
        <span class="method">POST</span>
        <span class="path">/v1/chat/completions <span>— OpenAI SDK compatible</span></span>
        <span class="arrow">→</span>
        <span class="target-format" id="ep-fmt-chat">${cfg.backendFormat}</span>
      </div>
      <div class="endpoint">
        <span class="method">POST</span>
        <span class="path">/v1/messages <span>— Anthropic SDK compatible</span></span>
        <span class="arrow">→</span>
        <span class="target-format" id="ep-fmt-msg">${cfg.backendFormat}</span>
      </div>
      <div class="endpoint">
        <span class="method">POST</span>
        <span class="path">/v1/responses <span>— OpenAI Responses API compatible</span></span>
        <span class="arrow">→</span>
        <span class="target-format" id="ep-fmt-resp">${cfg.backendFormat}</span>
      </div>
    </div>
  </div>

  <!-- Live Test -->
  <div class="section">
    <div class="section-title">Live Test</div>
    <div class="test-area">
      <div class="test-row">
        <select id="test-format">
          <option value="chat">chat/completions</option>
          <option value="messages">messages</option>
          <option value="responses">responses</option>
        </select>
        <select id="test-stream">
          <option value="false">Non-streaming</option>
          <option value="true">Streaming</option>
        </select>
        <input id="test-model" placeholder="Model (e.g. gpt-4o)" value="gpt-4o">
        <input id="test-prompt" placeholder="Prompt..." value="Say hello in one sentence.">
        <button id="test-btn" onclick="runTest()">▶ Run</button>
      </div>
      <div class="response-box" id="test-output">// Response will appear here...</div>
    </div>
  </div>

  <!-- Runtime Config Update -->
  <div class="section">
    <div class="section-title">Runtime Config Update</div>
    <div class="test-area">
      <div class="test-row">
        <input id="upd-url" placeholder="Backend URL" value="${cfg.backendUrl}" style="flex:2">
        <select id="upd-fmt">
          <option value="chat" ${cfg.backendFormat === 'chat' ? 'selected' : ''}>chat</option>
          <option value="messages" ${cfg.backendFormat === 'messages' ? 'selected' : ''}>messages</option>
          <option value="responses" ${cfg.backendFormat === 'responses' ? 'selected' : ''}>responses</option>
        </select>
        <input id="upd-key" placeholder="API key (optional)" type="password">
        <button onclick="updateConfig()">Apply</button>
      </div>
      <div id="upd-status" style="font-size:12px; color: var(--muted); margin-top:8px;"></div>
    </div>
  </div>

  <footer>
    LLM Universal Proxy &nbsp;·&nbsp; 
    <a href="/health" style="color:var(--accent); text-decoration:none;">/health</a> &nbsp;·&nbsp;
    <a href="/config" style="color:var(--accent); text-decoration:none;">/config</a> &nbsp;·&nbsp;
    <a href="/v1/models" style="color:var(--accent); text-decoration:none;">/v1/models</a>
    <br>
    Uptime since <span id="uptime">${new Date().toISOString()}</span>
  </footer>

</div>

<script>
// Auto-refresh stats
async function refreshStats() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    document.getElementById('stat-total').textContent = d.stats.totalRequests;
    document.getElementById('stat-active').textContent = d.stats.activeRequests;
    document.getElementById('stat-success').textContent = d.stats.successRequests;
    document.getElementById('stat-errors').textContent = d.stats.errorRequests;
    document.getElementById('stat-latency').textContent =
      d.stats.totalRequests ? d.stats.avgLatencyMs + 'ms' : '—';
  } catch {}
}
setInterval(refreshStats, 2000);
refreshStats();

// Run test
async function runTest() {
  const fmt = document.getElementById('test-format').value;
  const stream = document.getElementById('test-stream').value === 'true';
  const model = document.getElementById('test-model').value || 'gpt-4o';
  const prompt = document.getElementById('test-prompt').value || 'Hello';
  const out = document.getElementById('test-output');
  const btn = document.getElementById('test-btn');

  btn.disabled = true;
  out.textContent = stream ? '// Streaming...' : '// Waiting...';

  const endpoints = {
    chat: '/v1/chat/completions',
    messages: '/v1/messages',
    responses: '/v1/responses',
  };

  const bodies = {
    chat: { model, stream, messages: [{ role: 'user', content: prompt }] },
    messages: { model, stream, max_tokens: 256, messages: [{ role: 'user', content: prompt }] },
    responses: { model, stream, input: prompt },
  };

  try {
    const res = await fetch(endpoints[fmt], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodies[fmt]),
    });

    if (stream) {
      out.textContent = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.textContent += decoder.decode(value);
        out.scrollTop = out.scrollHeight;
      }
    } else {
      const json = await res.json();
      out.textContent = JSON.stringify(json, null, 2);
    }
  } catch (e) {
    out.textContent = '// Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Update config
async function updateConfig() {
  const url = document.getElementById('upd-url').value;
  const fmt = document.getElementById('upd-fmt').value;
  const key = document.getElementById('upd-key').value;
  const status = document.getElementById('upd-status');

  const body = { backendUrl: url, backendFormat: fmt };
  if (key) body.apiKey = key;

  try {
    const r = await fetch('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    status.style.color = 'var(--success)';
    status.textContent = '✓ Config updated — backend: ' + d.config.backendUrl + ' [' + d.config.backendFormat + ']';
    document.getElementById('cfg-url').textContent = d.config.backendUrl;
    document.getElementById('cfg-fmt').textContent = d.config.backendFormat;
    document.getElementById('cfg-fmt').className = 'badge badge-' + d.config.backendFormat;
    document.getElementById('target-badge').textContent = d.config.backendFormat;
    document.getElementById('target-badge').className = 'badge badge-' + d.config.backendFormat;
    ['ep-fmt-chat','ep-fmt-msg','ep-fmt-resp'].forEach(id => {
      document.getElementById(id).textContent = d.config.backendFormat;
    });
  } catch (e) {
    status.style.color = 'var(--error)';
    status.textContent = '✗ ' + e.message;
  }
}
</script>
</body>
</html>`;
}

module.exports = app;