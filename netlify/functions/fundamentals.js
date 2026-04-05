// fundamentals.js v2 — Netlify serverless function
// Scores ASX stocks for value using Yahoo Finance chart API (v8) + quoteSummary
// Client calls ?action=batch with POST body {tickers:[...]} for 20 at a time
// Client aggregates across batches — no timeout issues

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://finance.yahoo.com/',
};

// Fetch chart data (always works — same as scan.js)
async function fetchChart(ticker) {
  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1mo&range=2y`,
    { headers: YF_HEADERS, signal: AbortSignal.timeout(7000) }
  );
  if (!r.ok) throw new Error(`chart ${r.status}`);
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result) throw new Error('no chart data');
  const meta   = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const highs  = result.indicators?.quote?.[0]?.high  || [];
  const lows   = result.indicators?.quote?.[0]?.low   || [];
  const vols   = result.indicators?.quote?.[0]?.volume|| [];
  return { meta, closes, highs, lows, vols };
}

// Try quoteSummary for PE/PB/ROE/dividends (may work from Netlify servers)
async function fetchFundamentals(ticker) {
  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics,financialData,summaryDetail`,
      { headers: YF_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const res = d?.quoteSummary?.result?.[0] || {};
    const ks  = res.defaultKeyStatistics || {};
    const fd  = res.financialData || {};
    const sd  = res.summaryDetail || {};
    return {
      pe:        sd?.trailingPE?.raw || null,
      forwardPE: sd?.forwardPE?.raw  || null,
      pb:        ks?.priceToBook?.raw || null,
      roe:       fd?.returnOnEquity?.raw || null,
      debtEq:    fd?.debtToEquity?.raw || null,
      divYield:  sd?.dividendYield?.raw || null,
      eps:       ks?.trailingEps?.raw || null,
      shortName: sd?.shortName || null,
      sector:    null,
    };
  } catch(e) {
    return null; // quoteSummary not available — use chart data only
  }
}

// Value scoring — technical + fundamental
function scoreStock(ticker, chart, fund) {
  const { meta, closes, highs, lows, vols } = chart;
  const price  = meta.regularMarketPrice || (closes[closes.length-1] || 0);
  const w52h   = Math.max(...highs.filter(Boolean), meta.fiftyTwoWeekHigh || 0);
  const w52l   = Math.min(...lows.filter(Boolean).filter(v => v > 0), meta.fiftyTwoWeekLow || Infinity);
  const mktCap = meta.marketCap || 0;
  const avgVol = vols.length ? vols.filter(Boolean).reduce((a,b)=>a+b,0)/vols.filter(Boolean).length : 0;
  const curVol = meta.regularMarketVolume || 0;

  // 12-month momentum from closes
  const validCloses = closes.filter(Boolean);
  const mo12chg = validCloses.length >= 12 
    ? (validCloses[validCloses.length-1] / validCloses[validCloses.length-12] - 1) 
    : null;
  // 3-month
  const mo3chg = validCloses.length >= 3
    ? (validCloses[validCloses.length-1] / validCloses[validCloses.length-3] - 1)
    : null;
  // Consistency: how many of last 6 months were up
  const consistency = validCloses.length >= 7
    ? validCloses.slice(-6).filter((c,i,a) => i>0 && c > a[i-1]).length
    : null;

  const w52pos = (w52h > w52l && w52l > 0) ? (price - w52l) / (w52h - w52l) : null;

  let score = 0;
  const signals = [];
  const warnings = [];

  // ── Fundamental value (if available) ──
  if (fund) {
    const pe = fund.pe;
    if (pe && pe > 0 && pe < 12)       { score += 22; signals.push(`Low P/E ${pe.toFixed(1)}`); }
    else if (pe && pe > 0 && pe < 20)  { score += 12; signals.push(`Fair P/E ${pe.toFixed(1)}`); }
    else if (pe && pe > 35)            { score -= 10; warnings.push(`High P/E ${pe.toFixed(1)}`); }

    const pb = fund.pb;
    if (pb && pb > 0 && pb < 1.5)     { score += 20; signals.push(`Below book P/B ${pb.toFixed(2)}`); }
    else if (pb && pb > 0 && pb < 3)  { score += 10; signals.push(`Fair P/B ${pb.toFixed(2)}`); }
    else if (pb && pb > 5)            { score -= 5;  warnings.push(`High P/B ${pb.toFixed(2)}`); }

    const div = fund.divYield;
    if (div && div > 0.05)  { score += 18; signals.push(`High div yield ${(div*100).toFixed(1)}%`); }
    else if (div && div > 0.03) { score += 10; signals.push(`Div ${(div*100).toFixed(1)}%`); }

    const roe = fund.roe;
    if (roe && roe > 0.20)  { score += 12; signals.push(`Strong ROE ${(roe*100).toFixed(0)}%`); }
    else if (roe && roe > 0.10) { score += 6;  signals.push(`ROE ${(roe*100).toFixed(0)}%`); }
    else if (roe && roe < 0)    { score -= 8;  warnings.push('Negative ROE'); }

    if (fund.eps && fund.eps < 0) { score -= 12; warnings.push('Loss-making'); }
    else if (fund.eps && fund.eps > 0) { score += 8; signals.push('Profitable'); }
  }

  // ── Technical value (from chart — always available) ──
  if (w52pos !== null) {
    if (w52pos < 0.25)       { score += 12; signals.push(`Near 52w low (${(w52pos*100).toFixed(0)}%)`); }
    else if (w52pos < 0.45)  { score += 6;  signals.push(`Mid-range (${(w52pos*100).toFixed(0)}% of range)`); }
    else if (w52pos > 0.85)  { score -= 6;  warnings.push('Near 52w high'); }
  }

  if (mo12chg !== null) {
    if (mo12chg > 0.30)      { score += 10; signals.push(`Strong 12mo +${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg > 0.10) { score += 5;  signals.push(`Positive 12mo +${(mo12chg*100).toFixed(0)}%`); }
    else if (mo12chg < -0.20){ score -= 8;  warnings.push(`12mo decline ${(mo12chg*100).toFixed(0)}%`); }
  }

  if (mo3chg !== null && mo3chg < -0.10) {
    score += 8; signals.push(`Pullback ${(mo3chg*100).toFixed(0)}% (buy opportunity)`);
  }

  if (consistency !== null) {
    if (consistency >= 5)    { score += 8; signals.push('Consistent monthly gains'); }
    else if (consistency <= 1){ score -= 5; warnings.push('Inconsistent price action'); }
  }

  if (curVol && avgVol && curVol > avgVol * 1.8) {
    score += 5; signals.push('High volume accumulation');
  }

  // Market cap bonus (prefer mid-large caps)
  if (mktCap > 10e9)      score += 6;
  else if (mktCap > 1e9)  score += 3;
  else if (mktCap < 1e8)  { score -= 5; warnings.push('Micro cap — higher risk'); }

  const grade = score >= 65 ? 'A+' : score >= 48 ? 'A' : score >= 32 ? 'B' : score >= 16 ? 'C' : 'D';

  return {
    ticker: ticker.includes('.') ? ticker : ticker + '.AX',
    name: fund?.shortName || meta.shortName || ticker,
    price,
    change: meta.regularMarketChangePercent || null,
    marketCap: mktCap,
    w52High: w52h, w52Low: w52l, w52Pos: w52pos,
    mo12chg, mo3chg,
    pe: fund?.pe || null,
    pb: fund?.pb || null,
    roe: fund?.roe || null,
    divYield: fund?.divYield || null,
    eps: fund?.eps || null,
    score, grade, signals, warnings,
    lastUpdated: new Date().toISOString(),
    hasFundamentals: !!fund,
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  // BATCH: POST with { tickers: [...up to 15...] }
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const tickers = (body.tickers || []).slice(0, 15);
      if (!tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };

      // Fetch chart + fundamentals in parallel per ticker
      const results = await Promise.allSettled(
        tickers.map(async (ticker) => {
          const [chart, fund] = await Promise.all([
            fetchChart(ticker),
            fetchFundamentals(ticker),
          ]);
          return scoreStock(ticker, chart, fund);
        })
      );

      const scored = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .sort((a, b) => b.score - a.score);

      const failed = results
        .filter(r => r.status === 'rejected')
        .length;

      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({ results: scored, failed, count: scored.length })
      };
    } catch(e) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
    }
  }

  // GET: return info about the endpoint
  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({
      status: 'ready',
      usage: 'POST with { tickers: ["BHP.AX", "CBA.AX", ...] } (max 15 per call)',
      scoring: 'P/E, P/B, ROE, dividend yield, 52w position, 12mo momentum, consistency',
    })
  };
};
