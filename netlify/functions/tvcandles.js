exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  const { ticker, resolution } = event.queryStringParameters || {};
  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required' }) };
  const sym = ticker.includes(':') ? ticker : 'ASX:' + ticker.replace('.AX','');
  const res = resolution || '12M';
  const from = Math.floor(Date.now()/1000) - (20 * 365 * 24 * 3600);
  const to = Math.floor(Date.now()/1000);
  
  // Try multiple TV endpoints
  const endpoints = [
    'https://data.tradingview.com/history?symbol=' + encodeURIComponent(sym) + '&resolution=' + res + '&from=' + from + '&to=' + to,
    'https://history.tradingview.com/history?symbol=' + encodeURIComponent(sym) + '&resolution=' + res + '&from=' + from + '&to=' + to,
  ];
  
  const errors = [];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.tradingview.com/',
          'Origin': 'https://www.tradingview.com',
          'Cookie': 'sessionid=y2f7decnyu4zne1mi58s50vonuqnbrw4; sessionid_sign=v3:y2f7decnyu4zne1mi58s50vonuqnbrw4; device_t=web'
        }
      });
      if (!r.ok) { errors.push(url + ' -> HTTP ' + r.status); continue; }
      const d = await r.json();
      if (d.s !== 'ok') { errors.push(url + ' -> status: ' + d.s + ' ' + (d.errmsg||'')); continue; }
      const candles = d.t.map((t, i) => ({
        t: t * 1000, date: new Date(t * 1000).toISOString().slice(0, 10),
        o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v ? d.v[i] : 0
      })).filter(c => c.o != null && c.c != null);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, resolution: res, count: candles.length, source: url, candles }) };
    } catch(e) { errors.push(url + ' -> ' + e.message); }
  }
  return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, error: 'all endpoints failed', details: errors, candles: [] }) };
};