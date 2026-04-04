exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  const { ticker, resolution } = event.queryStringParameters || {};
  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required' }) };
  
  // TradingView symbol format: ASX:BHP
  const sym = ticker.includes(':') ? ticker : 'ASX:' + ticker.replace('.AX','');
  const res = resolution || '12M';
  const from = Math.floor(Date.now()/1000) - (15 * 365 * 24 * 3600); // 15 years back
  const to = Math.floor(Date.now()/1000);
  
  try {
    const url = 'https://data.tradingview.com/history?symbol=' + encodeURIComponent(sym) + '&resolution=' + res + '&from=' + from + '&to=' + to;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.tradingview.com/',
        'Origin': 'https://www.tradingview.com'
      }
    });
    if (!r.ok) throw new Error('TV ' + r.status);
    const d = await r.json();
    if (d.s !== 'ok') throw new Error('TV status: ' + d.s);
    
    const candles = d.t.map((t, i) => ({
      t: t * 1000,
      date: new Date(t * 1000).toISOString().slice(0, 10),
      o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v ? d.v[i] : 0
    })).filter(c => c.o != null && c.c != null);
    
    return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, resolution: res, count: candles.length, candles }) };
  } catch(e) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, error: e.message, candles: [] }) };
  }
};