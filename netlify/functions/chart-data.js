// chart-data.js — lightweight Yahoo Finance chart proxy for sparklines
// Returns compact OHLCV data for rendering mini charts
// Usage: GET ?ticker=BHP&range=6mo&interval=1d

const H = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const p = event.queryStringParameters || {};
  let ticker = (p.ticker || '').trim().toUpperCase();
  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing ticker' }) };

  // Auto-append .AX for ASX tickers
  if (!ticker.includes('.')) ticker += '.AX';

  const range = p.range || '6mo';
  const interval = p.interval || '1d';

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) throw new Error(`Yahoo returned ${resp.status}`);

    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No chart data');

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const meta = result.meta || {};

    // Build compact arrays
    const closes = quote.close || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const opens = quote.open || [];
    const volumes = quote.volume || [];

    // Filter out nulls and build clean data
    const candles = [];
    let hi52 = -Infinity, lo52 = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const c = {
        t: timestamps[i],
        o: opens[i] != null ? +opens[i].toFixed(4) : null,
        h: highs[i] != null ? +highs[i].toFixed(4) : null,
        l: lows[i] != null ? +lows[i].toFixed(4) : null,
        c: +closes[i].toFixed(4),
        v: volumes[i] || 0,
      };
      candles.push(c);
      if (c.h != null && c.h > hi52) hi52 = c.h;
      if (c.l != null && c.l < lo52) lo52 = c.l;
    }

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        ticker: ticker,
        currency: meta.currency || 'AUD',
        price: meta.regularMarketPrice || null,
        prevClose: meta.chartPreviousClose || null,
        hi52: hi52 === -Infinity ? null : hi52,
        lo52: lo52 === Infinity ? null : lo52,
        candles: candles,
        range: range,
        interval: interval,
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { ...H, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: e.message, ticker }),
    };
  }
};
