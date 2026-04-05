// Netlify function — refreshes cached ticker data from Yahoo Finance
// Call with ?batch=0 for first 100 tickers, ?batch=1 for next 100, etc.
// Or call with ?ticker=BHP to refresh a single ticker
// Designed to be called by an external cron (GitHub Actions / cron-job.org)

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CACHE_URL = (process.env.URL || 'https://apextrade-proxy.netlify.app') + '/.netlify/functions/cache';
  const ASX_URL = (process.env.URL || 'https://apextrade-proxy.netlify.app') + '/.netlify/functions/asx-list';
  const BATCH_SIZE = 50;

  const params = event.queryStringParameters || {};

  // Single ticker refresh
  if (params.ticker) {
    const result = await refreshTicker(params.ticker, CACHE_URL);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  }

  // Batch refresh
  const batchNum = parseInt(params.batch || '0');

  try {
    const listR = await fetch(ASX_URL);
    const listData = await listR.json();
    const allTickers = (listData.stocks || []).map(function(t) { return t.ticker || t; });
    const totalBatches = Math.ceil(allTickers.length / BATCH_SIZE);

    if (batchNum >= totalBatches) {
      return { statusCode: 200, headers, body: JSON.stringify({ done: true, totalBatches, message: 'All batches complete' }) };
    }

    const batch = allTickers.slice(batchNum * BATCH_SIZE, (batchNum + 1) * BATCH_SIZE);
    var ok = 0, fail = 0;

    // Process sequentially with small delay to avoid Yahoo rate limits
    for (var i = 0; i < batch.length; i++) {
      var result = await refreshTicker(batch[i], CACHE_URL);
      if (result.ok) ok++;
      else fail++;
      // Small delay
      if (i < batch.length - 1) await new Promise(function(r) { setTimeout(r, 200); });
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        batch: batchNum,
        totalBatches,
        processed: batch.length,
        ok, fail,
        nextBatch: batchNum + 1 < totalBatches ? batchNum + 1 : null,
        tickers: batch,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function refreshTicker(ticker, cacheUrl) {
  try {
    var symbol = ticker + '.AX';
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=5d';
    var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { ticker, ok: false, reason: 'yahoo ' + r.status };
    var d = await r.json();
    var res = d.chart && d.chart.result && d.chart.result[0];
    if (!res || !res.timestamp) return { ticker, ok: false, reason: 'no data' };
    var ts = res.timestamp;
    var q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    var candles = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.open && q.open[i] != null && q.close && q.close[i] != null) {
        candles.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] : 0 });
      }
    }
    if (!candles.length) return { ticker, ok: false, reason: 'empty candles' };

    var cr = await fetch(cacheUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, exchange: 'ASX', candles, source: 'yahoo-refresh', timestamp: Date.now() }),
    });
    var cResult = await cr.json();
    return { ticker, ok: true, cached: cResult.cached };
  } catch (e) {
    return { ticker, ok: false, reason: e.message };
  }
}
