// fundamentals.js v3 — Netlify serverless function
// Scores ASX stocks for value using Yahoo Finance chart API (v8)
// Client calls POST with { tickers: [...up to 12...] } — returns scored results immediately

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://finance.yahoo.com/',
};

async function fetchChart(sym) {
  // Use same endpoint as scan.js — we know this works
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1mo&range=2y`;
  const r = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`Yahoo chart ${r.status} for ${sym}`);
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${sym}`);
  const meta   = result.meta || {};
  const quote  = result.indicators?.quote?.[0] || {};
  return {
    meta,
    closes: (quote.close  || []).filter(v => v != null),
    highs:  (quote.high   || []).filter(v => v != null),
    lows:   (quote.low    || []).filter(v => v != null),
    vols:   (quote.volume || []).filter(v => v != null),
  };
}

async function fetchFundamentals(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,summaryDetail`;
    const r = await fetch(url, { headers: YF_HEADERS });
    if (!r.ok) return null;
    const d = await r.json();
    const res = d?.quoteSummary?.result?.[0] || {};
    const ks  = res.defaultKeyStatistics || {};
    const fd  = res.financialData || {};
    const sd  = res.summaryDetail || {};
    return {
      pe:       sd?.trailingPE?.raw    ?? null,
      pb:       ks?.priceToBook?.raw   ?? null,
      roe:      fd?.returnOnEquity?.raw?? null,
      debtEq:   fd?.debtToEquity?.raw  ?? null,
      divYield: sd?.dividendYield?.raw ?? null,
      eps:      ks?.trailingEps?.raw   ?? null,
      shortName:ks?.shortName ?? null,
    };
  } catch(e) {
    return null;
  }
}

function scoreStock(ticker, chart, fund) {
  const { meta, closes, highs, lows, vols } = chart;
  const price  = meta.regularMarketPrice || closes[closes.length - 1] || 0;
  const w52h   = highs.length ? Math.max(...highs) : (meta.fiftyTwoWeekHigh || price * 1.3);
  const w52l   = lows.length  ? Math.min(...lows)  : (meta.fiftyTwoWeekLow  || price * 0.7);
  const mktCap = meta.marketCap || 0;
  const avgVol = vols.length ? vols.reduce((a,b) => a+b, 0) / vols.length : 0;
  const curVol = meta.regularMarketVolume || 0;
  const w52pos = (w52h > w52l) ? (price - w52l) / (w52h - w52l) : 0.5;

  // Momentum from monthly closes
  const mo12chg = closes.length >= 12 ? (closes[closes.length-1] / closes[closes.length-12] - 1) : null;
  const mo3chg  = closes.length >= 3  ? (closes[closes.length-1] / closes[closes.length-3]  - 1) : null;
  const consistency = closes.length >= 7
    ? closes.slice(-6).filter((c, i, a) => i > 0 && c > a[i - 1]).length
    : null;

  let score = 0;
  const signals = [];
  const warnings = [];

  // ── Fundamentals (P/E, P/B, ROE, dividends) ──────────────────────
  if (fund) {
    const pe = fund.pe;
    if (pe != null && pe > 0)  {
      if (pe < 10)       { score += 25; signals.push(`Very low P/E ${pe.toFixed(1)}`); }
      else if (pe < 18)  { score += 14; signals.push(`Low P/E ${pe.toFixed(1)}`); }
      else if (pe < 28)  { score += 5;  signals.push(`Fair P/E ${pe.toFixed(1)}`); }
      else if (pe > 40)  { score -= 10; warnings.push(`High P/E ${pe.toFixed(1)}`); }
    }
    const pb = fund.pb;
    if (pb != null && pb > 0) {
      if (pb < 1.0)       { score += 22; signals.push(`Deep value P/B ${pb.toFixed(2)}`); }
      else if (pb < 2.0)  { score += 12; signals.push(`P/B ${pb.toFixed(2)}`); }
      else if (pb < 4.0)  { score += 4; }
      else if (pb > 6.0)  { score -= 6; warnings.push(`Rich P/B ${pb.toFixed(2)}`); }
    }
    const div = fund.divYield;
    if (div != null) {
      if (div > 0.06)     { score += 20; signals.push(`High div ${(div*100).toFixed(1)}%`); }
      else if (div > 0.04){ score += 12; signals.push(`Good div ${(div*100).toFixed(1)}%`); }
      else if (div > 0.02){ score += 6;  signals.push(`Div ${(div*100).toFixed(1)}%`); }
    }
    const roe = fund.roe;
    if (roe != null) {
      if (roe > 0.20)     { score += 14; signals.push(`Strong ROE ${(roe*100).toFixed(0)}%`); }
      else if (roe > 0.10){ score += 7;  signals.push(`ROE ${(roe*100).toFixed(0)}%`); }
      else if (roe < 0)   { score -= 10; warnings.push('Negative ROE'); }
    }
    const eps = fund.eps;
    if (eps != null) {
      if (eps > 0)  { score += 8;  signals.push('Profitable'); }
      else          { score -= 14; warnings.push('Loss-making'); }
    }
  }

  // ── Technical value signals ───────────────────────────────────────
  if (w52pos < 0.2)       { score += 14; signals.push(`Near 52w low (${(w52pos*100).toFixed(0)}%)`); }
  else if (w52pos < 0.4)  { score += 7;  signals.push(`Lower range (${(w52pos*100).toFixed(0)}%)`); }
  else if (w52pos > 0.9)  { score -= 7;  warnings.push('Near 52w high'); }

  if (mo12chg != null) {
    if (mo12chg > 0.40)     { score += 10; signals.push(`Strong 12mo +${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg > 0.15){ score += 5; }
    else if (mo12chg < -0.25){ score -= 8; warnings.push(`12mo down ${(mo12chg*100).toFixed(0)}%`); }
  }

  // Recent pullback = opportunity
  if (mo3chg != null && mo3chg < -0.08 && (mo12chg == null || mo12chg > -0.1)) {
    score += 8; signals.push(`Pullback ${(mo3chg*100).toFixed(0)}% — potential entry`);
  }

  if (consistency != null) {
    if (consistency >= 5)    { score += 8; signals.push('Consistent uptrend'); }
    else if (consistency <= 1){ score -= 4; warnings.push('Choppy price action'); }
  }

  if (curVol > 0 && avgVol > 0 && curVol > avgVol * 1.8) {
    score += 5; signals.push('Elevated volume');
  }

  // Market cap preference
  if (mktCap > 10e9)      score += 6;
  else if (mktCap > 1e9)  score += 3;
  else if (mktCap < 5e7)  { score -= 6; warnings.push('Micro cap'); }

  const grade = score >= 65 ? 'A+' : score >= 48 ? 'A' : score >= 32 ? 'B' : score >= 16 ? 'C' : 'D';

  return {
    ticker: sym,
    name: fund?.shortName || meta.shortName || meta.longName || sym,
    price, change: meta.regularMarketChangePercent || 0,
    marketCap: mktCap,
    w52High: w52h, w52Low: w52l, w52Pos: w52pos,
    mo12chg, mo3chg,
    pe: fund?.pe ?? null, pb: fund?.pb ?? null,
    roe: fund?.roe ?? null, divYield: fund?.divYield ?? null, eps: fund?.eps ?? null,
    score, grade, signals: signals.slice(0, 4), warnings: warnings.slice(0, 2),
    hasFundamentals: !!fund,
    lastUpdated: new Date().toISOString(),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, headers: H, body: JSON.stringify({
      status: 'ready',
      usage: 'POST { tickers: ["BHP.AX", ...] } (max 12 per call)',
      note: 'Scores on P/E, P/B, ROE, dividends, 52w position, momentum',
    })};
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } 
  catch(e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const tickers = (body.tickers || []).slice(0, 12).map(t => t.includes('.') ? t : t + '.AX');
  if (!tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };

  const results = [];
  const errors  = [];

  // Process in parallel — chart + fundamentals per ticker
  const settled = await Promise.allSettled(
    tickers.map(async (sym) => {
      try {
        const [chart, fund] = await Promise.all([
          fetchChart(sym),
          fetchFundamentals(sym).catch(() => null),
        ]);
        return scoreStock(sym, chart, fund);
      } catch(e) {
        errors.push({ ticker: sym, error: e.message });
        return null;
      }
    })
  );

  settled.forEach(r => { if (r.status === 'fulfilled' && r.value) results.push(r.value); });
  results.sort((a, b) => b.score - a.score);

  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({ results, errors, count: results.length })
  };
};
