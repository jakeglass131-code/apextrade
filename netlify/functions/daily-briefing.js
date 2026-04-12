// ═══════════════════════════════════════════════════════════════════════════════
// ApexTrade Daily Briefing — Automated Macro Research Report Generator
// ═══════════════════════════════════════════════════════════════════════════════
// Aggregates data from prediction engine, news, scanner, and macro sources,
// then uses Claude AI to synthesize institutional-grade analysis.
// Generates a beautiful HTML email and sends to subscriber list.
//
// Required env vars:
//   ANTHROPIC_API_KEY    — Claude API key for AI analysis
//   RESEND_API_KEY       — Resend.com API key for email delivery
//   BRIEFING_FROM_EMAIL  — Verified sender (e.g. briefing@apextrade.com)
//   BRIEFING_RECIPIENTS  — Comma-separated email list (or 'stripe' to pull from Stripe)
//   STRIPE_SECRET_KEY    — (optional) Pull subscriber emails from Stripe
//   SITE_URL             — e.g. https://apextrade-proxy.netlify.app
// ═══════════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// ── Data fetching from our own endpoints ────────────────────────────────────

async function fetchInternal(path) {
  const base = process.env.SITE_URL || 'https://apextrade-proxy.netlify.app';
  try {
    const r = await fetch(`${base}/.netlify/functions/${path}`, {
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`[briefing] Failed to fetch ${path}: ${e.message}`);
    return null;
  }
}

// Fetch top ASX movers from scanner
async function fetchScannerHighlights() {
  const topTickers = ['BHP', 'CBA', 'CSL', 'WDS', 'FMG', 'RIO', 'NAB', 'WBC', 'ANZ',
    'MQG', 'WES', 'TLS', 'STO', 'WTC', 'XRO', 'ALL', 'MIN', 'PLS', 'LYC', 'NEM',
    'SQ2', 'REA', 'TCL', 'GMG', 'WOW', 'COL', 'JHX', 'ORG', 'AGL', 'S32'];
  // Pick a rotating subset of 10 to scan (keeps it fast)
  const today = new Date();
  const offset = today.getDate() % 3; // rotate every day
  const batch = topTickers.slice(offset * 10, offset * 10 + 10);
  if (batch.length === 0) return null;
  return fetchInternal(`scan?tickers=${batch.join(',')}`);
}

// ── Claude AI analysis generation ───────────────────────────────────────────

async function generateAnalysis(predictionData, newsData, scannerData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[briefing] No ANTHROPIC_API_KEY — using template-only mode');
    return null;
  }

  // Build the context for Claude
  const prediction = predictionData?.prediction || {};
  const regime = predictionData?.regime || {};
  const ensemble = predictionData?.ensemble || {};
  const mc = predictionData?.monteCarlo || {};
  const sectors = predictionData?.sectorAnalysis?.sectors || [];
  const intermarket = predictionData?.intermarket || {};
  const technicals = predictionData?.technicals || {};
  const backtest = predictionData?.backtest || {};
  const corrMatrix = predictionData?.correlationMatrix || {};
  const superTrend = technicals?.superTrend || {};
  const confAnalysis = predictionData?.confidenceAnalysis || {};

  const newsItems = (newsData?.items || []).slice(0, 15);
  const newsText = newsItems.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n');

  const scanResults = scannerData?.results || [];
  const scanText = scanResults
    .filter(r => r.signals && r.signals.length > 0)
    .map(r => `${r.ticker}: ${r.signals.map(s => s.type + ' (' + s.tf + ')').join(', ')}`)
    .join('\n') || 'No active signals today.';

  const prompt = `You are an elite macro strategist writing a daily market briefing for Australian equities traders.
Today is ${new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

AVAILABLE DATA:

ASX 200 PREDICTION ENGINE (v2.6, 55+ factor quant model):
- Direction: ${prediction.direction || 'N/A'} | Score: ${prediction.score || 'N/A'} | Confidence: ${prediction.confidence || 'N/A'}%
- Estimated Move: ${prediction.estimatedChange || 'N/A'}
- Range: ${prediction.range?.low || '?'} — ${prediction.range?.high || '?'}
- Regime: ${regime.type || 'N/A'} (ADX ${regime.adx || '?'}, Hurst ${regime.hurst || '?'})
- Ensemble: Momentum ${ensemble.momentum?.score || '?'}, Mean-Rev ${ensemble.meanReversion?.score || '?'}, Intermarket ${ensemble.intermarket?.score || '?'}
- Monte Carlo: ${mc.bullProb || '?'}% bull / ${mc.bearProb || '?'}% bear (${mc.simulations || 2000} sims)
- SuperTrend Daily: ${superTrend.daily?.direction || 'N/A'} (lvl ${superTrend.daily?.level || '?'}, dist ${superTrend.daily?.distancePct || '?'}%${superTrend.daily?.flipped ? ' FLIPPED!' : ''})
- SuperTrend Weekly: ${superTrend.weekly?.direction || 'N/A'} (lvl ${superTrend.weekly?.level || '?'}, dist ${superTrend.weekly?.distancePct || '?'}%${superTrend.weekly?.flipped ? ' FLIPPED!' : ''})
- Backtest: ${backtest.accuracy || '?'}% accuracy, Sharpe ${backtest.sharpeRatio || '?'}, Profit Factor ${backtest.profitFactor || '?'}
- Confidence Notes: ${(confAnalysis.notes || []).join('; ') || 'None'}
- Correlation Breakdown Alert: ${corrMatrix.breakdownAlert ? 'YES — ' + corrMatrix.breakdownDetail : 'No'}

INTERMARKET:
- US Futures: NQ ${intermarket.nq || '?'}%, ES ${intermarket.es || '?'}%, YM ${intermarket.ym || '?'}%
- VIX: ${intermarket.vix || '?'}
- Gold: ${intermarket.gold || '?'}%, Oil: ${intermarket.oil || '?'}%, Copper: ${intermarket.copper || '?'}%
- DXY: ${intermarket.dxy || '?'}%, US10Y: ${intermarket.bond10y || '?'}%, AUD/USD: ${intermarket.aud || '?'}%
- BTC: ${intermarket.btc || '?'}%

KEY TECHNICALS:
- RSI(14): ${technicals.rsi || '?'}, MACD Hist: ${technicals.macd?.hist || '?'} (${technicals.macd?.accel ? 'accelerating' : 'decelerating'})
- Stochastic: ${technicals.stochastic ? technicals.stochastic.k + '/' + technicals.stochastic.d : '?'}
- Hurst: ${technicals.hurst || '?'}, Z-Score: ${technicals.zScore || '?'}
- Bollinger Width: ${technicals.bollingerWidth || '?'}%
- ADX: ${technicals.adx?.adx || '?'} (+DI ${technicals.adx?.pDI || '?'} / -DI ${technicals.adx?.nDI || '?'})

ASX SECTORS:
${sectors.map(s => `- ${s.name}: 1d ${s.chg1d > 0 ? '+' : ''}${s.chg1d || '?'}%, 5d ${s.chg5d > 0 ? '+' : ''}${s.chg5d || '?'}%, RSI ${s.rsi || '?'}`).join('\n') || 'No sector data'}

LIVE NEWS HEADLINES:
${newsText || 'No news available'}

SCANNER SIGNALS (top ASX stocks):
${scanText}

INSTRUCTIONS:
Write a concise, high-impact daily briefing with these exact sections. Be specific with numbers. Be bold with calls — this is for active traders who need actionable intelligence, not generic commentary.

Return your response as valid JSON with this exact structure:
{
  "headline": "A punchy 5-10 word headline capturing today's dominant theme",
  "subtitle": "One sentence expanding on the headline",
  "marketVerdict": "BULLISH|BEARISH|CAUTIOUS|VOLATILE",
  "verdictExplanation": "2-3 sentences explaining the overall call with specific data points",
  "keyTheme": {
    "title": "Today's dominant macro theme (e.g. 'Iron Ore Surge Lifts Miners' or 'Rate Cut Hopes Fade')",
    "analysis": "3-4 paragraphs of deep analysis on this theme. Include cascading effects, sector impacts, historical precedents. Reference specific data points from above. This is the main value — make it institutional grade.",
    "affectedSectors": ["sector names"],
    "tradeImplications": "2-3 specific, actionable implications for ASX traders"
  },
  "riskFactors": ["3-4 bullet points of key risks to watch today"],
  "sectorCalls": [
    {"sector": "name", "call": "OVERWEIGHT|UNDERWEIGHT|NEUTRAL", "reason": "one sentence"},
    ...at least 3 sectors
  ],
  "watchlist": ["3-5 ASX ticker symbols worth watching today with one-line reason each, format: 'BHP — reason'"],
  "dataPoints": [
    {"label": "short label", "value": "the value", "color": "green|red|amber"},
    ...5-6 key data points for the header bar
  ],
  "closingNote": "One punchy sentence to close — a key insight or contrarian thought"
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Claude API ${r.status}: ${err}`);
    }

    const data = await r.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[briefing] Claude analysis failed:', e.message);
    return null;
  }
}

// ── HTML Email Template ─────────────────────────────────────────────────────

function buildEmailHTML(analysis, predictionData, newsData) {
  const p = predictionData?.prediction || {};
  const regime = predictionData?.regime || {};
  const mc = predictionData?.monteCarlo || {};
  const st = predictionData?.technicals?.superTrend || {};

  // Fallback if AI analysis failed
  const a = analysis || {
    headline: `ASX Market Briefing — ${new Date().toLocaleDateString('en-AU')}`,
    subtitle: 'Your daily quantitative market analysis',
    marketVerdict: p.direction === 'BULL' ? 'BULLISH' : p.direction === 'BEAR' ? 'BEARISH' : 'CAUTIOUS',
    verdictExplanation: `The 55+ factor quant model signals ${p.direction || 'NEUTRAL'} with ${p.confidence || '?'}% confidence. Score: ${p.score || '?'}.`,
    keyTheme: { title: 'Market Update', analysis: 'AI analysis unavailable — showing raw quant data below.', affectedSectors: [], tradeImplications: '' },
    riskFactors: [],
    sectorCalls: [],
    watchlist: [],
    dataPoints: [],
    closingNote: '',
  };

  const verdictColors = {
    BULLISH: { bg: '#064e3b', border: '#10b981', text: '#34d399' },
    BEARISH: { bg: '#450a0a', border: '#ef4444', text: '#f87171' },
    CAUTIOUS: { bg: '#451a03', border: '#f59e0b', text: '#fbbf24' },
    VOLATILE: { bg: '#3b0764', border: '#a855f7', text: '#c084fc' },
  };
  const vc = verdictColors[a.marketVerdict] || verdictColors.CAUTIOUS;

  const dateStr = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Data points bar
  let dataPointsHTML = '';
  const dp = a.dataPoints && a.dataPoints.length ? a.dataPoints : [
    { label: 'Direction', value: p.direction || 'N/A', color: p.direction === 'BULL' ? 'green' : 'red' },
    { label: 'Score', value: (p.score > 0 ? '+' : '') + (p.score || 0).toFixed(3), color: p.score > 0 ? 'green' : 'red' },
    { label: 'Confidence', value: (p.confidence || 0).toFixed(0) + '%', color: p.confidence >= 60 ? 'green' : 'amber' },
    { label: 'MC Bull', value: (mc.bullProb || '?') + '%', color: mc.bullProb > 55 ? 'green' : 'red' },
    { label: 'Regime', value: regime.type || 'N/A', color: 'amber' },
    { label: 'Est Move', value: p.estimatedChange || '?', color: (p.estimatedChange || '')[0] === '+' ? 'green' : 'red' },
  ];
  const dpColors = { green: '#10b981', red: '#ef4444', amber: '#f59e0b' };
  dataPointsHTML = dp.map(d =>
    `<td style="text-align:center;padding:12px 8px;border-right:1px solid #1e293b">
      <div style="font-size:22px;font-weight:900;color:${dpColors[d.color] || '#e2e8f0'};line-height:1.1">${d.value}</div>
      <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">${d.label}</div>
    </td>`
  ).join('');

  // Risk factors
  const risksHTML = (a.riskFactors || []).map(r =>
    `<tr><td style="padding:6px 12px;font-size:13px;color:#e2e8f0;border-bottom:1px solid #1e293b"><span style="color:#ef4444;font-weight:700">⚠</span> ${r}</td></tr>`
  ).join('');

  // Sector calls
  const sectorHTML = (a.sectorCalls || []).map(s => {
    const sc = s.call === 'OVERWEIGHT' ? '#10b981' : s.call === 'UNDERWEIGHT' ? '#ef4444' : '#f59e0b';
    return `<tr>
      <td style="padding:8px 12px;font-size:13px;color:#e2e8f0;border-bottom:1px solid #1e293b;font-weight:700">${s.sector}</td>
      <td style="padding:8px 12px;font-size:12px;font-weight:800;color:${sc};border-bottom:1px solid #1e293b;text-transform:uppercase">${s.call}</td>
      <td style="padding:8px 12px;font-size:12px;color:#94a3b8;border-bottom:1px solid #1e293b">${s.reason}</td>
    </tr>`;
  }).join('');

  // Watchlist
  const watchHTML = (a.watchlist || []).map(w =>
    `<tr><td style="padding:6px 12px;font-size:13px;color:#e2e8f0;border-bottom:1px solid #1e293b">📌 ${w}</td></tr>`
  ).join('');

  // SuperTrend section
  let stHTML = '';
  if (st.daily || st.weekly) {
    const dCol = st.daily?.direction === 'BULL' ? '#10b981' : '#ef4444';
    const wCol = st.weekly?.direction === 'BULL' ? '#10b981' : '#ef4444';
    stHTML = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
      <tr>
        <td colspan="2" style="padding:10px 16px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #1e293b">SuperTrend Multi-Timeframe</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;width:50%;border-right:1px solid #1e293b">
          <div style="font-size:9px;color:#64748b;font-weight:700">DAILY</div>
          <div style="font-size:20px;font-weight:900;color:${dCol}">${st.daily?.direction || 'N/A'}${st.daily?.flipped ? ' ⚡FLIP' : ''}</div>
          <div style="font-size:11px;color:#94a3b8">Level: ${st.daily?.level || '?'} · Dist: ${st.daily?.distancePct || '?'}%</div>
        </td>
        <td style="padding:12px 16px;width:50%">
          <div style="font-size:9px;color:#64748b;font-weight:700">WEEKLY</div>
          <div style="font-size:20px;font-weight:900;color:${wCol}">${st.weekly?.direction || 'N/A'}${st.weekly?.flipped ? ' ⚡FLIP' : ''}</div>
          <div style="font-size:11px;color:#94a3b8">Level: ${st.weekly?.level || '?'} · Dist: ${st.weekly?.distancePct || '?'}%</div>
        </td>
      </tr>
    </table>`;
  }

  // News headlines
  const newsItems = (newsData?.items || []).slice(0, 8);
  const newsHTML = newsItems.map(n =>
    `<tr><td style="padding:4px 12px;font-size:12px;color:#cbd5e1;border-bottom:1px solid #0f172a"><span style="color:#64748b;font-size:10px">${n.source}</span> — ${n.title}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ApexTrade Daily Briefing</title></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#020617;padding:20px 0">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="background:#0b1120;border:1px solid #1e293b;border-radius:12px;overflow:hidden;max-width:680px;width:100%">

<!-- Header -->
<tr><td style="padding:24px 28px;background:linear-gradient(135deg,#0b1120,#1a1040);border-bottom:1px solid #1e293b">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td>
        <div style="display:inline-block;padding:3px 10px;background:#ef4444;color:#fff;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;border-radius:3px;margin-right:6px">Daily Briefing</div>
        <div style="display:inline-block;padding:3px 10px;background:#0ea5e9;color:#fff;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;border-radius:3px">${dateStr}</div>
      </td>
    </tr>
    <tr><td style="padding-top:16px">
      <div style="font-size:28px;font-weight:900;color:#f1f5f9;line-height:1.15">${a.headline}</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px">${a.subtitle}</div>
    </td></tr>
  </table>
</td></tr>

<!-- Data Points Bar -->
<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border-bottom:1px solid #1e293b">
    <tr>${dataPointsHTML}</tr>
  </table>
</td></tr>

<!-- Market Verdict -->
<tr><td style="padding:20px 28px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${vc.bg};border:2px solid ${vc.border};border-radius:10px;overflow:hidden">
    <tr><td style="padding:20px 24px">
      <div style="font-size:10px;color:${vc.text};text-transform:uppercase;letter-spacing:0.1em;font-weight:700">Market Verdict</div>
      <div style="font-size:32px;font-weight:900;color:${vc.text};margin:4px 0">${a.marketVerdict}</div>
      <div style="font-size:13px;color:#cbd5e1;line-height:1.5">${a.verdictExplanation}</div>
    </td></tr>
  </table>
</td></tr>

${stHTML ? `<tr><td style="padding:0 28px">${stHTML}</td></tr>` : ''}

<!-- Key Theme / Deep Analysis -->
<tr><td style="padding:20px 28px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
    <tr><td style="padding:16px 20px;border-bottom:1px solid #1e293b">
      <div style="font-size:10px;font-weight:700;color:#0ea5e9;text-transform:uppercase;letter-spacing:0.08em">Deep Analysis</div>
      <div style="font-size:18px;font-weight:800;color:#f1f5f9;margin-top:4px">${a.keyTheme.title}</div>
    </td></tr>
    <tr><td style="padding:16px 20px">
      <div style="font-size:13px;color:#cbd5e1;line-height:1.65">${(a.keyTheme.analysis || '').replace(/\n\n/g, '</div><div style="font-size:13px;color:#cbd5e1;line-height:1.65;margin-top:12px">')}</div>
      ${a.keyTheme.tradeImplications ? `<div style="margin-top:14px;padding:12px 16px;background:#064e3b;border:1px solid #10b981;border-radius:6px"><div style="font-size:10px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Trade Implications</div><div style="font-size:12px;color:#d1fae5;line-height:1.5">${a.keyTheme.tradeImplications}</div></div>` : ''}
    </td></tr>
  </table>
</td></tr>

<!-- Sector Calls -->
${sectorHTML ? `
<tr><td style="padding:0 28px 20px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
    <tr><td colspan="3" style="padding:12px 16px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #1e293b">Sector Positioning</td></tr>
    ${sectorHTML}
  </table>
</td></tr>` : ''}

<!-- Watchlist -->
${watchHTML ? `
<tr><td style="padding:0 28px 20px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
    <tr><td style="padding:12px 16px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #1e293b">Today's Watchlist</td></tr>
    ${watchHTML}
  </table>
</td></tr>` : ''}

<!-- Risk Factors -->
${risksHTML ? `
<tr><td style="padding:0 28px 20px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a0505;border:1px solid #7f1d1d;border-radius:8px;overflow:hidden">
    <tr><td style="padding:12px 16px;font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #7f1d1d">Key Risks</td></tr>
    ${risksHTML}
  </table>
</td></tr>` : ''}

<!-- News Headlines -->
${newsHTML ? `
<tr><td style="padding:0 28px 20px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
    <tr><td style="padding:12px 16px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #1e293b">Market Headlines</td></tr>
    ${newsHTML}
  </table>
</td></tr>` : ''}

<!-- Closing Note -->
${a.closingNote ? `
<tr><td style="padding:0 28px 24px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0c1222,#1a1040);border:1px solid #334155;border-radius:8px;overflow:hidden">
    <tr><td style="padding:16px 20px;font-size:13px;color:#e2e8f0;font-style:italic;line-height:1.5">
      "${a.closingNote}"
    </td></tr>
  </table>
</td></tr>` : ''}

<!-- CTA -->
<tr><td style="padding:8px 28px 24px;text-align:center">
  <a href="https://apextrade-proxy.netlify.app" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;font-weight:800;font-size:14px;text-decoration:none;border-radius:8px;text-transform:uppercase;letter-spacing:0.05em">Open Dashboard →</a>
</td></tr>

<!-- Footer -->
<tr><td style="padding:16px 28px;background:#070d1a;border-top:1px solid #1e293b;text-align:center">
  <div style="font-size:10px;color:#475569;line-height:1.5">
    ApexTrade Daily Briefing · 55+ factor quant model · AI-powered macro analysis<br>
    Performance estimates from historical data · Not financial advice · DYOR<br>
    <a href="https://apextrade-proxy.netlify.app" style="color:#0ea5e9;text-decoration:none">apextrade.com</a>
  </div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Email delivery via Resend ───────────────────────────────────────────────

async function getRecipients() {
  const recipientConfig = process.env.BRIEFING_RECIPIENTS || '';

  // If set to 'stripe', pull active subscriber emails
  if (recipientConfig.toLowerCase() === 'stripe' && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      const emails = new Set();
      for (const sub of subs.data) {
        if (sub.customer) {
          try {
            const cust = await stripe.customers.retrieve(sub.customer);
            if (cust.email) emails.add(cust.email);
          } catch (e) { /* skip */ }
        }
      }
      // Also get trialing
      const trials = await stripe.subscriptions.list({ status: 'trialing', limit: 100 });
      for (const sub of trials.data) {
        if (sub.customer) {
          try {
            const cust = await stripe.customers.retrieve(sub.customer);
            if (cust.email) emails.add(cust.email);
          } catch (e) { /* skip */ }
        }
      }
      return [...emails];
    } catch (e) {
      console.error('[briefing] Stripe subscriber fetch failed:', e.message);
      return [];
    }
  }

  // Otherwise, use comma-separated list
  return recipientConfig.split(',').map(e => e.trim()).filter(Boolean);
}

async function sendEmail(html, subject, recipients) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[briefing] No RESEND_API_KEY — email not sent');
    return { sent: false, reason: 'No RESEND_API_KEY configured' };
  }

  const from = process.env.BRIEFING_FROM_EMAIL || 'ApexTrade <briefing@apextrade.com>';

  // Resend supports batch sending
  // Send individually for better deliverability
  const results = [];
  for (const to of recipients) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to, subject, html }),
      });
      if (r.ok) {
        results.push({ to, sent: true });
      } else {
        const err = await r.text();
        results.push({ to, sent: false, error: err });
      }
    } catch (e) {
      results.push({ to, sent: false, error: e.message });
    }
  }

  return { sent: true, results, total: recipients.length, success: results.filter(r => r.sent).length };
}

// ── Main handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Auth check — only allow from GitHub Actions or with secret key
  const authKey = process.env.BRIEFING_AUTH_KEY;
  const providedKey = event.headers?.['x-briefing-key'] ||
    event.queryStringParameters?.key;

  // Allow manual trigger without auth for testing, but require it in production
  if (authKey && providedKey !== authKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const startTime = Date.now();
  const mode = event.queryStringParameters?.mode || 'send'; // 'preview' = just return HTML, 'send' = generate + send

  try {
    console.log('[briefing] Starting daily briefing generation...');

    // 1. Fetch all data in parallel
    const [predictionData, newsData, scannerData] = await Promise.all([
      fetchInternal('predict-v2'),
      fetchInternal('news'),
      fetchScannerHighlights(),
    ]);

    console.log(`[briefing] Data fetched in ${Date.now() - startTime}ms`);
    console.log(`[briefing] Prediction: ${predictionData?.prediction?.direction || 'N/A'}, News: ${newsData?.items?.length || 0} items`);

    // 2. Generate AI analysis
    const analysis = await generateAnalysis(predictionData, newsData, scannerData);
    console.log(`[briefing] AI analysis ${analysis ? 'generated' : 'skipped'} in ${Date.now() - startTime}ms`);

    // 3. Build HTML email
    const subject = analysis
      ? `${analysis.marketVerdict}: ${analysis.headline} — ApexTrade Daily`
      : `ASX Market Briefing — ${new Date().toLocaleDateString('en-AU')}`;
    const html = buildEmailHTML(analysis, predictionData, newsData);

    // 4. Preview mode — return HTML without sending
    if (mode === 'preview') {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    }

    // 5. Get recipients and send
    const recipients = await getRecipients();
    if (!recipients.length) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          warning: 'No recipients configured — email not sent. Set BRIEFING_RECIPIENTS env var.',
          preview: true,
          html: html.substring(0, 500) + '...',
          analysis: analysis ? { headline: analysis.headline, verdict: analysis.marketVerdict } : null,
          generationTime: Date.now() - startTime,
        }),
      };
    }

    const emailResult = await sendEmail(html, subject, recipients);
    console.log(`[briefing] Email sent to ${emailResult.success}/${emailResult.total} recipients in ${Date.now() - startTime}ms`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        headline: analysis?.headline || subject,
        verdict: analysis?.marketVerdict || 'N/A',
        recipients: emailResult.total,
        sent: emailResult.success,
        generationTime: Date.now() - startTime,
      }),
    };
  } catch (err) {
    console.error('[briefing] Error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
