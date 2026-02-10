const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3500;

// Data directory (live) or bundled fallback
const DATA_DIR = process.env.CT_DATA_DIR || path.join(process.env.HOME || '/root', 'ct-scanner/data');
const BUNDLE_PATH = path.join(__dirname, 'scans-bundle.json');
let bundledScans = null;

// Try to load bundled scans for deployment
try {
  if (fs.existsSync(BUNDLE_PATH)) {
    bundledScans = JSON.parse(fs.readFileSync(BUNDLE_PATH));
    console.log(`Loaded ${bundledScans.length} bundled scans`);
  }
} catch (e) {
  console.log('No bundled scans available');
}

// ── Helpers ──────────────────────────────────────────────

function loadScans(hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  
  // Try live directory first
  let allScans = [];
  try {
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();
      
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
          const ts = data.timestamp ? new Date(data.timestamp).getTime() : 0;
          allScans.push({ ...data, _ts: ts });
        } catch (e) {}
      }
    }
  } catch (e) {}
  
  // Fall back to bundled data
  if (allScans.length === 0 && bundledScans) {
    allScans = bundledScans.map(s => ({
      ...s,
      _ts: s.timestamp ? new Date(s.timestamp).getTime() : 0
    }));
  }
  
  // Filter by time window
  if (hours === 0) return allScans;
  return allScans.filter(s => s._ts >= cutoff);
}

function analyzeSentiment(scans) {
  if (!scans.length) return { bull: 0, bear: 0, ratio: 0, trend: 'NO DATA' };
  
  let totalBull = 0, totalBear = 0;
  for (const s of scans) {
    totalBull += (s.sentiment?.bullish || 0);
    totalBear += (s.sentiment?.bearish || 0);
  }
  const avgBull = totalBull / scans.length;
  const avgBear = totalBear / scans.length;
  const ratio = avgBear > 0 ? (avgBull / avgBear).toFixed(2) : avgBull > 0 ? '∞' : '0';
  
  // Trend: compare first half vs second half
  const mid = Math.floor(scans.length / 2);
  const firstHalf = scans.slice(0, mid);
  const secondHalf = scans.slice(mid);
  const firstBull = firstHalf.reduce((a, s) => a + (s.sentiment?.bullish || 0), 0) / (firstHalf.length || 1);
  const secondBull = secondHalf.reduce((a, s) => a + (s.sentiment?.bullish || 0), 0) / (secondHalf.length || 1);
  const trend = secondBull > firstBull * 1.1 ? 'RISING' : secondBull < firstBull * 0.9 ? 'DECLINING' : 'STABLE';
  
  return {
    bull: parseFloat(avgBull.toFixed(1)),
    bear: parseFloat(avgBear.toFixed(1)),
    ratio: parseFloat(ratio) || 0,
    trend,
    scans: scans.length
  };
}

function extractTickers(scans) {
  const tickers = {};
  for (const s of scans) {
    // Format 1: topTickers as array of [name, count]
    if (Array.isArray(s.topTickers)) {
      for (const entry of s.topTickers) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const name = entry[0].replace(/^\$/, '');
          tickers[name] = (tickers[name] || 0) + entry[1];
        }
      }
    }
    // Format 2: tickers as object
    if (s.tickers && typeof s.tickers === 'object') {
      for (const [ticker, count] of Object.entries(s.tickers)) {
        const name = ticker.replace(/^\$/, '');
        tickers[name] = (tickers[name] || 0) + count;
      }
    }
    // Format 3: byCategory
    if (s.byCategory) {
      for (const cat of Object.values(s.byCategory)) {
        if (Array.isArray(cat)) {
          for (const item of cat) {
            if (item.ticker && item.count) {
              const name = item.ticker.replace(/^\$/, '');
              tickers[name] = (tickers[name] || 0) + item.count;
            }
          }
        }
      }
    }
  }
  return Object.entries(tickers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, mentions]) => ({ name, mentions }));
}

function extractCommodities(scans) {
  const comms = {};
  for (const s of scans) {
    if (s.keywordMentions) {
      // Structured keyword mentions from scanner
      for (const category of ['commodities', 'metals', 'macro', 'industry']) {
        const cat = s.keywordMentions[category];
        if (cat && typeof cat === 'object') {
          for (const [key, count] of Object.entries(cat)) {
            comms[key] = (comms[key] || 0) + count;
          }
        }
      }
    }
  }
  // Deduplicate: gold appears in both commodities and metals
  // Keep the higher count (they're the same signal)
  return Object.entries(comms)
    .sort((a, b) => b[1] - a[1])
    .map(([name, mentions]) => ({ name, mentions }));
}

function detectRegime(sentiment) {
  if (sentiment.ratio >= 4) return 'EUPHORIA';
  if (sentiment.ratio >= 2.5) return 'BULLISH';
  if (sentiment.ratio >= 1.5) return 'LEANING BULL';
  if (sentiment.ratio >= 0.7) return 'NEUTRAL';
  if (sentiment.ratio >= 0.4) return 'LEANING BEAR';
  return 'BEARISH';
}

function fearGauge(commodities) {
  const gold = commodities.find(c => c.name === 'gold')?.mentions || 0;
  const silver = commodities.find(c => c.name === 'silver')?.mentions || 0;
  const total = gold + silver;
  if (total > 50) return 'EXTREME';
  if (total > 30) return 'HIGH';
  if (total > 15) return 'ELEVATED';
  if (total > 5) return 'MODERATE';
  return 'LOW';
}

function getHighEngagement(scans, limit = 5) {
  const posts = [];
  for (const s of scans) {
    if (s.highEngagement) {
      for (const p of s.highEngagement) {
        posts.push(p);
      }
    }
    // Also check tweets array
    if (s.tweets) {
      for (const t of s.tweets) {
        if (t.likes && t.likes > 100) {
          posts.push({
            author: t.username || t.author,
            likes: t.likes,
            text: t.text?.substring(0, 200),
            url: t.url
          });
        }
      }
    }
  }
  return posts
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, limit)
    .filter((p, i, arr) => arr.findIndex(q => q.url === p.url) === i); // dedup
}

function generateBrief(hours = 24) {
  const scans = loadScans(hours);
  const sentiment = analyzeSentiment(scans);
  const regime = detectRegime(sentiment);
  const tickers = extractTickers(scans);
  const commodities = extractCommodities(scans);
  const fear = fearGauge(commodities);
  const topPosts = getHighEngagement(scans, 5);
  
  // Momentum: split-half comparison for top tickers
  const mid = Math.floor(scans.length / 2);
  const firstScans = scans.slice(0, mid);
  const secondScans = scans.slice(mid);
  const firstTickers = extractTickers(firstScans);
  const secondTickers = extractTickers(secondScans);
  
  const momentum = tickers.slice(0, 10).map(t => {
    const first = firstTickers.find(ft => ft.name === t.name)?.mentions || 0;
    const second = secondTickers.find(st => st.name === t.name)?.mentions || 0;
    const perScanFirst = firstScans.length ? first / firstScans.length : 0;
    const perScanSecond = secondScans.length ? second / secondScans.length : 0;
    const change = perScanFirst > 0 ? ((perScanSecond - perScanFirst) / perScanFirst * 100).toFixed(0) : 'NEW';
    return { name: t.name, mentions: t.mentions, change: change === 'NEW' ? 'NEW' : parseInt(change) };
  });

  // Narratives
  const narratives = [];
  const memecoins = tickers.filter(t => !['BTC', 'ETH', 'SOL', 'MSTR', 'SPX', 'NVDA', 'TSLA'].includes(t.name));
  if (memecoins.length > 5) narratives.push({ type: '🎰', label: 'Memecoin attention dominates', strength: memecoins.reduce((a, t) => a + t.mentions, 0) });
  const tradfi = tickers.filter(t => ['MSTR', 'SPX', 'NVDA', 'TSLA', 'AAPL'].includes(t.name));
  if (tradfi.length > 0) narratives.push({ type: '🏦', label: 'TradFi crossover active', strength: tradfi.reduce((a, t) => a + t.mentions, 0) });
  if (fear === 'HIGH' || fear === 'EXTREME') narratives.push({ type: '🥇', label: 'Precious metals elevated — flight to safety', strength: (commodities.find(c => c.name === 'gold')?.mentions || 0) });

  const now = new Date();
  return {
    generated: now.toISOString(),
    generatedHuman: now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }),
    window: `${hours}h`,
    scanCount: scans.length,
    regime: {
      label: regime,
      sentiment,
      fear
    },
    tickers: tickers.slice(0, 15),
    momentum,
    commodities: commodities.slice(0, 8),
    narratives,
    topPosts,
    meta: {
      source: 'Phil\'s CT Scanner — 477+ scans across 15 days',
      description: 'Automated intelligence from Crypto Twitter monitoring',
      agent: 'Phil (Clawdbot AI Agent)',
      frequency: '~30 min scan interval'
    }
  };
}

// ── API Routes ───────────────────────────────────────────

app.get('/api/brief', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(generateBrief(hours));
});

app.get('/api/brief/compact', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const brief = generateBrief(hours);
  res.json({
    regime: brief.regime.label,
    sentiment: `${brief.regime.sentiment.bull}%↑ ${brief.regime.sentiment.bear}%↓`,
    ratio: brief.regime.sentiment.ratio + ':1',
    trend: brief.regime.sentiment.trend,
    fear: brief.regime.fear,
    topTickers: brief.tickers.slice(0, 5).map(t => `$${t.name}(${t.mentions})`).join(' '),
    scans: brief.scanCount
  });
});

app.get('/api/tickers', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  res.json(extractTickers(scans));
});

app.get('/api/fear', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  const commodities = extractCommodities(scans);
  res.json({ gauge: fearGauge(commodities), commodities });
});

// ── Web Dashboard ────────────────────────────────────────

app.get('/', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const brief = generateBrief(hours);
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CT Intelligence — Phil's Daily Brief</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap');
  
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --text: #e0e0e8;
    --dim: #6b6b80;
    --accent: #4ade80;
    --warn: #fbbf24;
    --danger: #f87171;
    --info: #60a5fa;
  }
  
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, sans-serif;
    min-height: 100vh;
    padding: 0;
  }
  
  .header {
    background: linear-gradient(135deg, #0f1a12 0%, #0a0a0f 50%, #0f0f1a 100%);
    border-bottom: 1px solid var(--border);
    padding: 2rem;
  }
  
  .header-inner {
    max-width: 900px;
    margin: 0 auto;
  }
  
  .header h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.1rem;
    font-weight: 400;
    color: var(--accent);
    letter-spacing: 0.05em;
  }
  
  .header .subtitle {
    font-size: 0.85rem;
    color: var(--dim);
    margin-top: 0.3rem;
  }
  
  .header .generated {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--dim);
    margin-top: 0.5rem;
    opacity: 0.7;
  }
  
  .content {
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem;
  }
  
  .regime-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1.5rem;
  }
  
  .regime-item {
    text-align: center;
  }
  
  .regime-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
  }
  
  .regime-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.5rem;
    font-weight: 600;
  }
  
  .regime-value.bullish { color: var(--accent); }
  .regime-value.bearish { color: var(--danger); }
  .regime-value.neutral { color: var(--warn); }
  .regime-value.fear-high { color: var(--warn); }
  .regime-value.fear-extreme { color: var(--danger); }
  .regime-value.fear-low { color: var(--accent); }
  
  .regime-detail {
    font-size: 0.8rem;
    color: var(--dim);
    margin-top: 0.3rem;
  }
  
  .section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  
  .section h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  
  .ticker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.5rem;
  }
  
  .ticker {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: rgba(255,255,255,0.02);
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  
  .ticker-name { color: var(--info); font-weight: 500; }
  .ticker-count { color: var(--dim); }
  
  .momentum-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  
  .momentum-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  
  .momentum-name { color: var(--info); width: 100px; }
  .momentum-bar {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .momentum-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .momentum-fill.up { background: var(--accent); }
  .momentum-fill.down { background: var(--danger); }
  .momentum-fill.new { background: var(--info); }
  
  .momentum-change { width: 60px; text-align: right; }
  .momentum-change.up { color: var(--accent); }
  .momentum-change.down { color: var(--danger); }
  .momentum-change.new { color: var(--info); }
  
  .narrative-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .narrative {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: rgba(255,255,255,0.02);
    border-radius: 6px;
    font-size: 0.85rem;
  }
  
  .narrative-icon { font-size: 1.2rem; }
  .narrative-text { color: var(--text); }
  .narrative-strength { color: var(--dim); font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; margin-left: auto; }
  
  .post-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  
  .post {
    padding: 0.75rem;
    background: rgba(255,255,255,0.02);
    border-radius: 6px;
    border-left: 2px solid var(--border);
  }
  
  .post-author {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--info);
    margin-bottom: 0.3rem;
  }
  
  .post-text {
    font-size: 0.85rem;
    color: var(--text);
    line-height: 1.4;
    opacity: 0.9;
  }
  
  .post-likes {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--dim);
    margin-top: 0.3rem;
  }
  
  .commodity-bars {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  
  .commodity-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  
  .commodity-name { width: 80px; color: var(--warn); }
  .commodity-bar-bg {
    flex: 1;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .commodity-bar-fill {
    height: 100%;
    background: var(--warn);
    border-radius: 3px;
    opacity: 0.7;
  }
  .commodity-count { width: 40px; text-align: right; color: var(--dim); }
  
  .footer {
    max-width: 900px;
    margin: 0 auto;
    padding: 0 2rem 2rem;
    text-align: center;
  }
  
  .footer p {
    font-size: 0.75rem;
    color: var(--dim);
    opacity: 0.5;
  }
  
  .footer a { color: var(--accent); text-decoration: none; opacity: 0.7; }
  .footer a:hover { opacity: 1; }
  
  .api-note {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--dim);
    background: rgba(255,255,255,0.02);
    padding: 0.75rem;
    border-radius: 6px;
    margin-top: 1rem;
    opacity: 0.6;
  }
  
  .api-note code {
    color: var(--accent);
    opacity: 0.8;
  }

  .time-controls {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  
  .time-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    text-decoration: none;
  }
  
  .time-btn:hover, .time-btn.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  @media (max-width: 600px) {
    .regime-card { grid-template-columns: 1fr; }
    .header, .content { padding: 1rem; }
    .ticker-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <h1>📡 CT Intelligence — Daily Brief</h1>
    <div class="subtitle">Automated Crypto Twitter intelligence from Phil's 477+ scan dataset</div>
    <div class="generated">${brief.generatedHuman} · ${brief.scanCount} scans · ${brief.window} window</div>
    <div class="time-controls">
      <a class="time-btn ${hours === 8 ? 'active' : ''}" href="/?hours=8">8h</a>
      <a class="time-btn ${hours === 24 ? 'active' : ''}" href="/?hours=24">24h</a>
      <a class="time-btn ${hours === 48 ? 'active' : ''}" href="/?hours=48">48h</a>
      <a class="time-btn ${hours === 168 ? 'active' : ''}" href="/?hours=168">7d</a>
    </div>
  </div>
</div>

<div class="content">

  <!-- Regime Card -->
  <div class="regime-card">
    <div class="regime-item">
      <div class="regime-label">Regime</div>
      <div class="regime-value ${brief.regime.label.includes('BULL') ? 'bullish' : brief.regime.label.includes('BEAR') ? 'bearish' : 'neutral'}">${brief.regime.label}</div>
      <div class="regime-detail">${brief.regime.sentiment.ratio}:1 ratio · ${brief.regime.sentiment.trend}</div>
    </div>
    <div class="regime-item">
      <div class="regime-label">Sentiment</div>
      <div class="regime-value" style="color: var(--text)">${brief.regime.sentiment.bull}% <span style="color:var(--accent)">↑</span> ${brief.regime.sentiment.bear}% <span style="color:var(--danger)">↓</span></div>
      <div class="regime-detail">${brief.scanCount} scans analyzed</div>
    </div>
    <div class="regime-item">
      <div class="regime-label">Fear Gauge</div>
      <div class="regime-value ${brief.regime.fear === 'HIGH' || brief.regime.fear === 'EXTREME' ? 'fear-high' : 'fear-low'}">${brief.regime.fear}</div>
      <div class="regime-detail">Gold: ${brief.commodities.find(c => c.name === 'gold')?.mentions || 0} mentions</div>
    </div>
  </div>

  <!-- Tickers -->
  <div class="section">
    <h2>📊 Top Tickers</h2>
    <div class="ticker-grid">
      ${brief.tickers.map(t => `<div class="ticker"><span class="ticker-name">$${t.name}</span><span class="ticker-count">${t.mentions}</span></div>`).join('')}
    </div>
  </div>

  <!-- Momentum -->
  <div class="section">
    <h2>📈 Momentum (Split-Half Comparison)</h2>
    <div class="momentum-list">
      ${brief.momentum.map(m => {
        const isNew = m.change === 'NEW';
        const isUp = !isNew && m.change > 0;
        const dir = isNew ? 'new' : isUp ? 'up' : 'down';
        const pct = isNew ? 50 : Math.min(Math.abs(m.change), 100);
        return `<div class="momentum-item">
          <span class="momentum-name">$${m.name}</span>
          <div class="momentum-bar"><div class="momentum-fill ${dir}" style="width:${pct}%"></div></div>
          <span class="momentum-change ${dir}">${isNew ? '🆕 NEW' : (isUp ? '+' : '') + m.change + '%'}</span>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Narratives -->
  ${brief.narratives.length ? `
  <div class="section">
    <h2>📡 Active Narratives</h2>
    <div class="narrative-list">
      ${brief.narratives.map(n => `<div class="narrative">
        <span class="narrative-icon">${n.type}</span>
        <span class="narrative-text">${n.label}</span>
        <span class="narrative-strength">${n.strength} signals</span>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Fear Gauge Detail -->
  <div class="section">
    <h2>🥇 Commodity & Macro Signals</h2>
    <div class="commodity-bars">
      ${brief.commodities.map(c => {
        const maxMentions = brief.commodities[0]?.mentions || 1;
        const pct = (c.mentions / maxMentions * 100).toFixed(0);
        return `<div class="commodity-row">
          <span class="commodity-name">${c.name}</span>
          <div class="commodity-bar-bg"><div class="commodity-bar-fill" style="width:${pct}%"></div></div>
          <span class="commodity-count">${c.mentions}</span>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Top Posts -->
  ${brief.topPosts.length ? `
  <div class="section">
    <h2>⚡ Highest Engagement Posts</h2>
    <div class="post-list">
      ${brief.topPosts.slice(0, 5).map(p => `<div class="post">
        <div class="post-author">@${p.author || 'unknown'}</div>
        <div class="post-text">${(p.text || '').substring(0, 200)}${(p.text || '').length > 200 ? '...' : ''}</div>
        <div class="post-likes">❤️ ${(p.likes || 0).toLocaleString()}${p.url ? ` · <a href="${p.url}" target="_blank" style="color:var(--info);text-decoration:none;">View →</a>` : ''}</div>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- API -->
  <div class="api-note">
    📡 API available: <code>GET /api/brief</code> · <code>/api/brief/compact</code> · <code>/api/tickers</code> · <code>/api/fear</code><br>
    Params: <code>?hours=24</code> (8, 24, 48, 168)
  </div>

</div>

<div class="footer">
  <p>Built by Phil · AI Agent Intelligence · <a href="https://phil-portfolio-production.up.railway.app">Portfolio</a></p>
  <p style="margin-top:0.3rem">Data from 477+ CT scans across 15 days of autonomous monitoring</p>
</div>

</body>
</html>`);
});

// ── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`CT Intelligence running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/brief`);
});
