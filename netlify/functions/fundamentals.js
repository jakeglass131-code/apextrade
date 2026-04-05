// fundamentals.js v4 — Netlify serverless function
// Uses OUR OWN candles endpoint (same proxy) to avoid Yahoo 429 rate limits
// Scores ASX stocks on technical value: 52w position, momentum, consistency, volume

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const BASE_URL = 'https://apextrade-proxy.netlify.app/.netlify/functions';

// Fetch candle data via our own candles endpoint (no Yahoo 429 issues)
async function fetchCandles(ticker, interval, range) {
  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  const url = `${BASE_URL}/candles?ticker=${sym}&period=${range}&interval=${interval}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`candles ${r.status} for ${sym}`);
  const d = await r.json();
  if (!d.candles || d.candles.length < 6) throw new Error(`insufficient candles for ${sym}`);
  return d;
}

function scoreStock(ticker, monthly, weekly) {
  const mc = monthly.candles || [];
  const wc = weekly.candles  || [];

  if (mc.length < 6) throw new Error('Need at least 6 monthly candles');

  const closes = mc.map(c => c.c).filter(Boolean);
  const highs  = mc.map(c => c.h).filter(Boolean);
  const lows   = mc.map(c => c.l).filter(Boolean);
  const vols   = mc.map(c => c.v).filter(Boolean);

  const price  = closes[closes.length - 1];
  const w52h   = Math.max(...highs);
  const w52l   = Math.min(...lows.filter(v => v > 0));
  const w52pos = w52h > w52l ? (price - w52l) / (w52h - w52l) : 0.5;
  const avgVol = vols.length ? vols.reduce((a,b)=>a+b,0)/vols.length : 0;

  // Returns
  const mo1chg  = closes.length >= 2  ? (closes[closes.length-1]/closes[closes.length-2]-1)  : null;
  const mo3chg  = closes.length >= 4  ? (closes[closes.length-1]/closes[closes.length-4]-1)  : null;
  const mo6chg  = closes.length >= 7  ? (closes[closes.length-1]/closes[closes.length-7]-1)  : null;
  const mo12chg = closes.length >= 13 ? (closes[closes.length-1]/closes[closes.length-13]-1) : null;

  // Monthly consistency (of last 12 months)
  const last12 = closes.slice(-13);
  const upMonths = last12.filter((c,i,a) => i > 0 && c > a[i-1]).length;
  const totalMonths = last12.length - 1;

  // Weekly trend (short-term momentum quality)
  const wc12 = (wc || []).slice(-12).map(c => c.c).filter(Boolean);
  const weeklyTrend = wc12.length >= 4
    ? (wc12[wc12.length-1] / wc12[wc12.length-4] - 1)
    : null;

  // Volume trend (accumulation)
  const recentVol  = vols.slice(-3).reduce((a,b)=>a+b,0)/3;
  const earlierVol = vols.slice(-9,-3).reduce((a,b)=>a+b,0)/6;
  const volRatio   = earlierVol > 0 ? recentVol / earlierVol : 1;

  // ── Scoring ──────────────────────────────────────────────────────
  let score = 0;
  const signals = [];
  const warnings = [];

  // 52-week position (value signal)
  if      (w52pos < 0.20) { score += 20; signals.push(`Near 52w low (${(w52pos*100).toFixed(0)}%) — deep value`); }
  else if (w52pos < 0.35) { score += 12; signals.push(`Lower range ${(w52pos*100).toFixed(0)}%`); }
  else if (w52pos < 0.55) { score += 5; }
  else if (w52pos > 0.85) { score -= 8;  warnings.push(`Near 52w high (${(w52pos*100).toFixed(0)}%)`); }

  // 12-month momentum
  if (mo12chg !== null) {
    if      (mo12chg > 0.50)  { score += 12; signals.push(`Strong 12mo +${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg > 0.20)  { score += 8;  signals.push(`12mo +${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg > 0.05)  { score += 4; }
    else if (mo12chg < -0.30) { score -= 10; warnings.push(`12mo decline ${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg < -0.10) { score -= 5;  warnings.push(`Weak 12mo ${(mo12chg*100).toFixed(0)}%`); }
  }

  // 3-month pullback (opportunity)
  if (mo3chg !== null && mo3chg < -0.08 && (mo12chg === null || mo12chg > -0.05)) {
    score += 10; signals.push(`Pullback ${(mo3chg*100).toFixed(0)}% — potential entry`);
  }
  if (mo3chg !== null && mo3chg > 0.15) {
    score += 5; signals.push(`Strong 3mo +${(mo3chg*100).toFixed(0)}%`);
  }

  // Monthly consistency
  if (totalMonths >= 6) {
    const consistPct = upMonths / totalMonths;
    if      (consistPct >= 0.75) { score += 14; signals.push(`Consistent uptrend (${upMonths}/${totalMonths} months up)`); }
    else if (consistPct >= 0.58) { score += 7;  signals.push(`Generally trending (${upMonths}/${totalMonths} months)`); }
    else if (consistPct <= 0.33) { score -= 6;  warnings.push(`Choppy — only ${upMonths}/${totalMonths} months up`); }
  }

  // Weekly trend
  if (weeklyTrend !== null) {
    if      (weeklyTrend > 0.10)  { score += 8; signals.push(`Short-term momentum strong`); }
    else if (weeklyTrend < -0.10) { score -= 5; warnings.push('Short-term weakening'); }
  }

  // Volume accumulation
  if (volRatio > 1.4) { score += 8;  signals.push(`Volume accumulation ${(volRatio).toFixed(1)}× avg`); }
  else if (volRatio < 0.6) { score -= 4; warnings.push('Volume declining'); }

  // Volatility penalty (very high spread = risky)
  const spread = (w52h - w52l) / w52l;
  if (spread > 1.5)  { score -= 8;  warnings.push(`High volatility ${(spread*100).toFixed(0)}% range`); }
  else if (spread < 0.2) { score += 4; signals.push('Low volatility — stable'); }

  const grade = score >= 55 ? 'A+' : score >= 40 ? 'A' : score >= 25 ? 'B' : score >= 10 ? 'C' : 'D';

  return {
    ticker: ticker.includes('.') ? ticker : ticker + '.AX',
    name: monthly.ticker || ticker,
    price, change: mo1chg ? mo1chg * 100 : 0,
    w52High: w52h, w52Low: w52l, w52Pos: w52pos,
    mo1chg, mo3chg, mo6chg, mo12chg,
    upMonths, totalMonths, volRatio,
    score, grade, signals: signals.slice(0,4), warnings: warnings.slice(0,2),
    hasFundamentals: false, // technical only — no PE/PB from chart
    lastUpdated: new Date().toISOString(),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, headers: H, body: JSON.stringify({
      status: 'ready',
      usage: 'POST { tickers: ["BHP.AX", ...] } (max 12 per call)',
      note: 'Technical value scoring via our own candles endpoint — no Yahoo 429 issues',
    })};
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const tickers = (body.tickers || []).slice(0, 12)
    .map(t => t.includes('.') ? t : t + '.AX');

  if (!tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };

  const results = [];
  const errors  = [];

  // Process sequentially with small delay to be gentle on our own candles endpoint
  for (const ticker of tickers) {
    try {
      const [monthly, weekly] = await Promise.all([
        fetchCandles(ticker, '1mo', '3y'),
        fetchCandles(ticker, '1wk', '1y'),
      ]);
      results.push(scoreStock(ticker, monthly, weekly));
    } catch(e) {
      errors.push({ ticker, error: e.message });
    }
    await new Promise(r => setTimeout(r, 150)); // gentle pacing
  }

  results.sort((a, b) => b.score - a.score);

  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({ results, errors, count: results.length })
  };
};
