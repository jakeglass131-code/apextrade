// Simple in-memory cache for TV candle data
// Data persists across warm invocations of THIS function only

var cache = {};

exports.handler = async function(event) {
  var headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headers, body: '' };

  if (event.httpMethod === 'POST') {
    try {
      var payload = JSON.parse(event.body);
      var ticker = (payload.ticker || '').toUpperCase();
      var candles = payload.candles || [];
      if (!ticker || !candles.length) return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'ticker and candles required' }) };

      if (!cache[ticker]) cache[ticker] = { candles: [], updatedAt: 0 };
      var map = {};
      cache[ticker].candles.forEach(function(c) { map[c.t] = c; });
      candles.forEach(function(c) { map[c.t] = c; });
      var merged = [];
      for (var k in map) merged.push(map[k]);
      merged.sort(function(a, b) { return a.t - b.t; });
      cache[ticker] = { candles: merged, updatedAt: payload.timestamp || Date.now(), source: payload.source || 'unknown', exchange: payload.exchange || 'ASX' };

      return { statusCode: 200, headers: headers, body: JSON.stringify({ ok: true, ticker: ticker, cached: merged.length }) };
    } catch (e) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === 'GET') {
    var params = event.queryStringParameters || {};
    if (!params.ticker) {
      var status = {};
      for (var t in cache) {
        status[t] = { candles: cache[t].candles.length, updatedAt: cache[t].updatedAt, age: Math.round((Date.now() - cache[t].updatedAt) / 1000) + 's' };
      }
      return { statusCode: 200, headers: headers, body: JSON.stringify({ cached_tickers: Object.keys(cache).length, tickers: status }) };
    }

    var key = params.ticker.toUpperCase().replace(/\.AX$/i, '');
    var entry = cache[key];
    if (!entry || !entry.candles.length) return { statusCode: 200, headers: headers, body: JSON.stringify({ ticker: key, hit: false, candles: [], count: 0 }) };

    var age = Date.now() - entry.updatedAt;
    return {
      statusCode: 200, headers: headers,
      body: JSON.stringify({ ticker: key, hit: true, stale: age > 86400000, age: Math.round(age / 1000), count: entry.candles.length, candles: entry.candles,
        meta: { source: entry.source, exchange: entry.exchange, updatedAt: entry.updatedAt, regularMarketPrice: entry.candles[entry.candles.length - 1].c } })
    };
  }

  return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'method not allowed' }) };
};
