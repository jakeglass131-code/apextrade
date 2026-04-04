// Netlify serverless function — TV candle data cache
// Receives candle data from the Tampermonkey relay script
// Serves cached data to candles.js and scan.js

// In-memory cache (persists across warm invocations)
const cache = {};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
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

      // Merge with existing cache
      if (!cache[key]) {
        cache[key] = { candles: [], exchange, source, updatedAt: 0 };
      }

      // Deduplicate by timestamp
      const existing = new Map(cache[key].candles.map(c => [c.t, c]));
      for (const candle of candles) {
        existing.set(candle.t, candle);
      }
      cache[key].candles = Array.from(existing.values()).sort((a, b) => a.t - b.t);
      cache[key].updatedAt = timestamp || Date.now();
      cache[key].exchange = exchange || cache[key].exchange;
      cache[key].source = source || 'tradingview';

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          ticker: key,
          cached: cache[key].candles.length,
          updatedAt: cache[key].updatedAt,
        }),
      };
    } catch (err) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // GET — serve cached candle data
  if (event.httpMethod === 'GET') {
    const { ticker, interval, range } = event.queryStringParameters || {};

    // If no ticker, return cache status
    if (!ticker) {
      const status = {};
      for (const [key, val] of Object.entries(cache)) {
        status[key] = {
          candles: val.candles.length,
          updatedAt: val.updatedAt,
          age: Math.round((Date.now() - val.updatedAt) / 1000) + 's',
          from: val.candles.length ? new Date(val.candles[0].t).toISOString().slice(0, 10) : null,
          to: val.candles.length ? new Date(val.candles[val.candles.length - 1].t).toISOString().slice(0, 10) : null,
        };
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ cached_tickers: Object.keys(status).length, tickers: status }),
      };
    }

    const key = ticker.toUpperCase().replace(/\.AX$/i, '');
    const entry = cache[key];

    if (!entry || !entry.candles.length) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ticker: key, hit: false, candles: [], count: 0 }),
      };
    }

    // Check if cache is stale (older than 24 hours)
    const age = Date.now() - entry.updatedAt;
    const stale = age > 24 * 60 * 60 * 1000;

    // Return raw daily candles — the consumer handles aggregation
    let candles = [...entry.candles];

    // Apply range filter if specified
    if (range) {
      const now = Date.now();
      const rangeMs = parseRange(range);
      if (rangeMs) {
        candles = candles.filter(c => c.t >= now - rangeMs);
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ticker: key,
        hit: true,
        stale,
        age: Math.round(age / 1000),
        count: candles.length,
        candles,
        meta: {
          source: entry.source,
          exchange: entry.exchange,
          updatedAt: entry.updatedAt,
          regularMarketPrice: candles.length ? candles[candles.length - 1].c : null,
        },
      }),
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
};

function parseRange(range) {
  const map = {
    '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180,
    '1y': 365, '2y': 730, '5y': 1825, 'max': 3650,
  };
  const days = map[range?.toLowerCase()];
  return days ? days * 24 * 60 * 60 * 1000 : null;
}
