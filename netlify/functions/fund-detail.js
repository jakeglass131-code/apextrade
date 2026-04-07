// fund-detail.js — Yahoo Finance quoteSummary proxy for fundamental data
// Returns P/E, P/B, ROE, dividend yield, EPS, balance sheet, sector info
// Usage: GET ?ticker=BHP.AX or POST { tickers: ["BHP.AX","CBA.AX"] } (max 5)

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=3600',
};

const MODULES = [
  'financialData',
  'defaultKeyStatistics',
  'summaryDetail',
  'earningsTrend',
  'balanceSheetHistory',
  'incomeStatementHistory',
  'assetProfile',
  'price',
].join(',');

// Simple in-memory cache (survives within a single Lambda instance)
const cache = {};
const CACHE_TTL = 3600000; // 1 hour

async function fetchFundamentals(ticker) {
  const now = Date.now();
  if (cache[ticker] && now - cache[ticker].ts < CACHE_TTL) return cache[ticker].data;

  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${MODULES}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${sym}`);
  const d = await r.json();
  const result = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
  if (!result) throw new Error(`No data for ${sym}`);

  const fd = result.financialData || {};
  const ks = result.defaultKeyStatistics || {};
  const sd = result.summaryDetail || {};
  const et = result.earningsTrend || {};
  const bs = (result.balanceSheetHistory && result.balanceSheetHistory.balanceSheetStatements) || [];
  const is = (result.incomeStatementHistory && result.incomeStatementHistory.incomeStatementHistory) || [];
  const ap = result.assetProfile || {};
  const pr = result.price || {};

  // Extract raw values (Yahoo wraps numbers in {raw, fmt} objects)
  const raw = (obj) => obj && obj.raw !== undefined ? obj.raw : null;

  // Balance sheet metrics (most recent)
  const latestBS = bs[0] || {};
  const totalAssets = raw(latestBS.totalAssets);
  const totalDebt = raw(latestBS.longTermDebt) || 0;
  const totalCash = raw(latestBS.cash) || 0;
  const totalEquity = raw(latestBS.totalStockholderEquity);

  // Income statement
  const latestIS = is[0] || {};
  const revenue = raw(latestIS.totalRevenue);
  const netIncome = raw(latestIS.netIncome);
  const grossProfit = raw(latestIS.grossProfit);

  // EPS growth from earningsTrend
  let epsGrowth = null;
  if (et.trend && et.trend.length) {
    const current = et.trend.find(t => t.period === '0q' || t.period === '+1q');
    if (current && current.growth) epsGrowth = raw(current.growth);
  }

  // Compute debt-to-equity
  const debtToEquity = totalEquity && totalEquity > 0 ? totalDebt / totalEquity : null;

  // Compute profit margin
  const profitMargin = revenue && revenue > 0 && netIncome ? netIncome / revenue : null;

  // Value score computation
  let valueScore = 0;
  let qualityScore = 0;
  let signals = [];

  // P/E scoring
  const pe = raw(sd.trailingPE);
  if (pe !== null && pe > 0) {
    if (pe < 8) { valueScore += 25; signals.push('Deep value P/E ' + pe.toFixed(1)); }
    else if (pe < 12) { valueScore += 18; signals.push('Low P/E ' + pe.toFixed(1)); }
    else if (pe < 18) { valueScore += 10; }
    else if (pe < 25) { valueScore += 3; }
    else if (pe > 40) { valueScore -= 10; signals.push('High P/E ' + pe.toFixed(1)); }
  }

  // P/B scoring
  const pb = raw(ks.priceToBook);
  if (pb !== null && pb > 0) {
    if (pb < 1.0) { valueScore += 20; signals.push('Below book value P/B ' + pb.toFixed(2)); }
    else if (pb < 1.5) { valueScore += 12; }
    else if (pb < 3.0) { valueScore += 5; }
    else if (pb > 5.0) { valueScore -= 5; }
  }

  // Dividend yield scoring
  const divYield = raw(sd.dividendYield);
  if (divYield !== null && divYield > 0) {
    if (divYield > 0.06) { valueScore += 15; signals.push('High yield ' + (divYield * 100).toFixed(1) + '%'); }
    else if (divYield > 0.04) { valueScore += 10; signals.push('Good yield ' + (divYield * 100).toFixed(1) + '%'); }
    else if (divYield > 0.02) { valueScore += 5; }
  }

  // ROE scoring
  const roe = raw(fd.returnOnEquity);
  if (roe !== null) {
    if (roe > 0.25) { qualityScore += 20; signals.push('Excellent ROE ' + (roe * 100).toFixed(0) + '%'); }
    else if (roe > 0.15) { qualityScore += 14; signals.push('Strong ROE ' + (roe * 100).toFixed(0) + '%'); }
    else if (roe > 0.08) { qualityScore += 7; }
    else if (roe < 0) { qualityScore -= 10; signals.push('Negative ROE'); }
  }

  // EPS growth
  if (epsGrowth !== null) {
    if (epsGrowth > 0.20) { qualityScore += 15; signals.push('Strong EPS growth ' + (epsGrowth * 100).toFixed(0) + '%'); }
    else if (epsGrowth > 0.05) { qualityScore += 8; }
    else if (epsGrowth < -0.10) { qualityScore -= 8; signals.push('EPS declining'); }
  }

  // Debt-to-equity
  if (debtToEquity !== null) {
    if (debtToEquity < 0.3) { qualityScore += 10; signals.push('Low debt D/E ' + debtToEquity.toFixed(2)); }
    else if (debtToEquity < 0.7) { qualityScore += 5; }
    else if (debtToEquity > 1.5) { qualityScore -= 8; signals.push('High debt D/E ' + debtToEquity.toFixed(2)); }
  }

  // Profit margin
  if (profitMargin !== null) {
    if (profitMargin > 0.20) { qualityScore += 10; signals.push('High margin ' + (profitMargin * 100).toFixed(0) + '%'); }
    else if (profitMargin > 0.10) { qualityScore += 5; }
    else if (profitMargin < 0) { qualityScore -= 8; signals.push('Loss-making'); }
  }

  const totalScore = valueScore + qualityScore;
  const grade = totalScore >= 60 ? 'A+' : totalScore >= 45 ? 'A' : totalScore >= 30 ? 'B' : totalScore >= 15 ? 'C' : 'D';

  const data = {
    ticker: sym,
    name: pr.shortName || pr.longName || sym,
    sector: ap.sector || 'Unknown',
    industry: ap.industry || 'Unknown',
    price: raw(pr.regularMarketPrice),
    marketCap: raw(sd.marketCap),
    // Valuation
    pe: pe,
    forwardPE: raw(ks.forwardPE),
    pb: pb,
    ps: raw(sd.priceToSalesTrailing12Months),
    evToEbitda: raw(ks.enterpriseToEbitda),
    // Returns
    roe: roe,
    roa: raw(fd.returnOnAssets),
    profitMargin: profitMargin,
    // Growth
    epsTrailing: raw(ks.trailingEps),
    epsForward: raw(ks.forwardEps),
    epsGrowth: epsGrowth,
    revenueGrowth: raw(fd.revenueGrowth),
    earningsGrowth: raw(fd.earningsGrowth),
    // Dividends
    dividendYield: divYield,
    dividendRate: raw(sd.dividendRate),
    payoutRatio: raw(sd.payoutRatio),
    // Balance sheet
    totalAssets: totalAssets,
    totalDebt: totalDebt,
    totalCash: totalCash,
    totalEquity: totalEquity,
    debtToEquity: debtToEquity,
    revenue: revenue,
    netIncome: netIncome,
    // Analyst
    targetMeanPrice: raw(fd.targetMeanPrice),
    recommendation: fd.recommendationKey || null,
    numberOfAnalysts: raw(fd.numberOfAnalystOpinions),
    // Scores
    valueScore: valueScore,
    qualityScore: qualityScore,
    totalScore: totalScore,
    grade: grade,
    signals: signals.slice(0, 6),
    lastUpdated: new Date().toISOString(),
  };

  cache[ticker] = { data, ts: now };
  return data;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const params = event.queryStringParameters || {};

  // GET mode: single ticker
  if (params.ticker) {
    try {
      const data = await fetchFundamentals(params.ticker);
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    } catch (e) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ error: e.message, ticker: params.ticker }) };
    }
  }

  // POST mode: batch (max 5)
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const tickers = (body.tickers || []).slice(0, 5);
    if (!tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };

    const results = [];
    const errors = [];

    for (const ticker of tickers) {
      try {
        results.push(await fetchFundamentals(ticker));
      } catch (e) {
        errors.push({ ticker, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200)); // rate limit pacing
    }

    results.sort((a, b) => b.totalScore - a.totalScore);
    return { statusCode: 200, headers: H, body: JSON.stringify({ results, errors, count: results.length }) };
  }

  return { statusCode: 200, headers: H, body: JSON.stringify({
    status: 'ready',
    usage: 'GET ?ticker=BHP.AX or POST { tickers: ["BHP.AX","CBA.AX"] } (max 5)',
    note: 'Fundamental analysis via Yahoo quoteSummary — P/E, P/B, ROE, dividends, balance sheet',
  })};
};
