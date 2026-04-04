// Netlify serverless function — TV candle data cache
// Uses Netlify Blobs for persistent storage across invocations

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let store;
  try {
    const blobs = require("@netlify/blobs");
    store = blobs.getStore("tv-cache");
  } catch (e) {
    // Blobs not available — fall back to in-memory
    return fallbackHandler(event);
  }

  // POST — receive candle data from Tampermonkey relay
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body);
      const { ticker, candles, exchange, source, timestamp } = payload;

      if (!ticker || !candles || !candles.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'ticker and candles required' }) };
      }

      const key = ticker.toUpperCase();

      // Get existing data
      let existing = { candles: [], exchange: '', source: 'tradingview', updatedAt: 0 };
      try {
        const prev = await store.get(key, { type: 'json' });
        if (prev) existing = prev;
      } catch (e) {}

      // Merge candles by timestamp
      const candleMap = new Map(existing.candles.map(c => [c.t, c]));
      for (const candle of candles) {
        candleMap.set(candle.t, candle);
      }
      const merged = Array.from(candleMap.values()).sort((a, b) => a.t - b.t);

      const data = {
        candles: merged,
        exchange: exchange || existing.exchange,
        source: source || 'tradingview',
        updatedAt: timestamp || Date.now(),
      };

      await store.setJSON(key, data);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, ticker: key, cached: merged.length, updatedAt: data.updatedAt }),
      };
    } catch (err) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // GET — serve cached candle data
  if (event.httpMethod === 'GET') {
    const { ticker } = event.queryStringParameters || {};

    if (!ticker) {
      try {
        const { blobs } = await store.list();
        const status = {};
        for (const blob of (blobs || []).slice(0, 50)) {
          try {
            const d = await store.get(blob.key, { type: 'json' });
            if (d) {
              status[blob.key] = {
                candles: d.candles.length,
                updatedAt: d.updatedAt,
                age: Math.round((Date.now() - d.updatedAt) / 1000) + 's',
              };
            }
          } catch (e) {}
        }
        return { statusCode: 200, headers, body: JSON.stringify({ cached_tickers: Object.keys(status).length, tickers: status }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ cached_tickers: 0, tickers: {}, note: e.message }) };
      }
    }

    const key = ticker.toUpperCase().replace(/\.AX$/i, '');

    try {
      const entry = await store.get(key, { type: 'json' });

      if (!entry || !entry.candles || !entry.candles.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ ticker: key, hit: false, candles: [], count: 0 }) };
      }

      const age = Date.now() - entry.updatedAt;
      const stale = age > 24 * 60 * 60 * 1000;

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ticker: key, hit: true, stale, age: Math.round(age / 1000),
          count: entry.candles.length, candles: entry.candles,
          meta: { source: entry.source, exchange: entry.exchange, updatedAt: entry.updatedAt,
            regularMarketPrice: entry.candles.length ? entry.candles[entry.candles.length - 1].c : null },
        }),
      };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ ticker: key, hit: false, candles: [], count: 0, error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
};

// Fallback in-memory handler if Blobs unavailable
const memCache = {};
function fallbackHandler(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'POST') {
    try {
      const { ticker, candles, exchange, source, timestamp } = JSON.parse(event.body);
      const key = ticker.toUpperCase();
      if (!memCache[key]) memCache[key] = { candles: [], exchange: '', source: 'tradingview', updatedAt: 0 };
      const m = new Map(memCache[key].candles.map(c => [c.t, c]));
      for (const c of candles) m.set(c.t, c);
      memCache[key].candles = Array.from(m.values()).sort((a, b) => a.t - b.t);
      memCache[key].updatedAt = timestamp || Date.now();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ticker: key, cached: memCache[key].candles.length }) };
    } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: e.message }) }; }
  }
  const { ticker } = event.queryStringParameters || {};
  if (!ticker) return { statusCode: 200, headers, body: JSON.stringify({ cached_tickers: Object.keys(memCache).length, tickers: Object.fromEntries(Object.entries(memCache).map(([k,v])=>[k,{candles:v.candles.length}])) }) };
  const key = ticker.toUpperCase().replace(/\.AX$/i, '');
  const e = memCache[key];
  if (!e) return { statusCode: 200, headers, body: JSON.stringify({ ticker: key, hit: false, candles: [], count: 0 }) };
  return { statusCode: 200, headers, body: JSON.stringify({ ticker: key, hit: true, stale: false, count: e.candles.length, candles: e.candles, meta: { source: 'tradingview' } }) };
}
