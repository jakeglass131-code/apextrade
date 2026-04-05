// Refreshes cached ticker data from Yahoo Finance
// Call with ?ticker=BHP for single, ?batch=0 for batch of 50

exports.handler = async function(event) {
  var headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headers, body: '' };

  var CACHE_URL = (process.env.URL || 'https://apextrade-proxy.netlify.app') + '/.netlify/functions/cache';
  var ASX_URL = (process.env.URL || 'https://apextrade-proxy.netlify.app') + '/.netlify/functions/asx-list';
  var BATCH_SIZE = 50;
  var params = event.queryStringParameters || {};

  if (params.ticker) {
    var result = await refreshTicker(params.ticker, CACHE_URL);
    return { statusCode: 200, headers: headers, body: JSON.stringify(result) };
  }

  var batchNum = parseInt(params.batch || '0');
  try {
    var listR = await fetch(ASX_URL);
    var listData = await listR.json();
    var allTickers = (listData.stocks || []).map(function(t) { return t.ticker || t; });
    var totalBatches = Math.ceil(allTickers.length / BATCH_SIZE);

    if (batchNum >= totalBatches) return { statusCode: 200, headers: headers, body: JSON.stringify({ done: true, totalBatches: totalBatches }) };

    var batch = allTickers.slice(batchNum * BATCH_SIZE, (batchNum + 1) * BATCH_SIZE);
    var ok = 0, fail = 0;
    for (var i = 0; i < batch.length; i++) {
      var r = await refreshTicker(batch[i], CACHE_URL);
      if (r.ok) ok++; else fail++;
      if (i < batch.length - 1) await sleep(200);
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ batch: batchNum, totalBatches: totalBatches, ok: ok, fail: fail, nextBatch: batchNum + 1 < totalBatches ? batchNum + 1 : null }) };
  } catch (e) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: e.message }) };
  }
};

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function refreshTicker(ticker, cacheUrl) {
  try {
    var symbol = ticker + '.AX';
    var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { ticker: ticker, ok: false, reason: 'yahoo ' + r.status };
    var d = await r.json();
    var res = d.chart && d.chart.result && d.chart.result[0];
    if (!res || !res.timestamp) return { ticker: ticker, ok: false, reason: 'no data' };
    var ts = res.timestamp;
    var q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    var candles = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.open && q.open[i] != null && q.close && q.close[i] != null)
        candles.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] : 0 });
    }
    if (!candles.length) return { ticker: ticker, ok: false, reason: 'empty' };
    var cr = await fetch(cacheUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: ticker, exchange: 'ASX', candles: candles, source: 'yahoo-refresh', timestamp: Date.now() }) });
    var cResult = await cr.json();
    return { ticker: ticker, ok: true, cached: cResult.cached };
  } catch (e) {
    return { ticker: ticker, ok: false, reason: e.message };
  }
}
