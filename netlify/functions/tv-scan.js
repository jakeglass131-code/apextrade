// TradingView Scanner API proxy
// POST body: { symbols: { tickers: [...] }, columns: [...] }
// Query: ?market=cfd|forex|australia|america|crypto
// Returns TradingView's exact indicator values for any symbols and timeframes
exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };

  const params = event.queryStringParameters || {};
  const market = (params.market || 'cfd').replace(/[^a-z]/gi, '');

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!body.symbols || !body.columns) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'symbols and columns required' }) };
  }

  try {
    const url = 'https://scanner.tradingview.com/' + market + '/scan';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { statusCode: r.status, headers: H, body: JSON.stringify({ error: 'TV ' + r.status, details: txt }) };
    }

    const data = await r.json();
    return { statusCode: 200, headers: H, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
