/* TradingView candle proxy — auto-session management
   Supports any resolution: 1D, 1W, 1M, 3M, 6M, 12M etc.
   Session: auto-obtained from TV homepage or TV_SESSION env var */

'use strict';

var tvSession = { cookie: null, time: 0 };
var TV_SESSION_TTL = 21600000; // 6 hours

function ensureTvSession() {
  if (process.env.TV_SESSION) return Promise.resolve(process.env.TV_SESSION);
  if (tvSession.cookie && Date.now() - tvSession.time < TV_SESSION_TTL) {
    return Promise.resolve(tvSession.cookie);
  }
  return fetch('https://www.tradingview.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(5000)
  })
  .then(function (r) {
    var cookies = [];
    if (typeof r.headers.getSetCookie === 'function') {
      cookies = r.headers.getSetCookie();
    } else {
      var raw = r.headers.get('set-cookie');
      if (raw) cookies = raw.split(/,(?=[^ ;]+?=)/);
    }
    var sid = null, sign = null;
    for (var i = 0; i < cookies.length; i++) {
      var m1 = cookies[i].match(/sessionid=([^;]+)/);
      if (m1 && m1[1].indexOf('""') < 0) sid = m1[1];
      var m2 = cookies[i].match(/sessionid_sign=([^;]+)/);
      if (m2) sign = m2[1];
    }
    if (sid) {
      var cookie = 'sessionid=' + sid;
      if (sign) cookie += '; sessionid_sign=' + sign;
      cookie += '; device_t=web';
      tvSession = { cookie: cookie, time: Date.now() };
      return cookie;
    }
    return null;
  })
  .catch(function () { return null; });
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  const { ticker, resolution } = event.queryStringParameters || {};
  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required' }) };

  const sym = ticker.includes(':') ? ticker : 'ASX:' + ticker.replace('.AX', '');
  const res = resolution || '1M';
  const from = Math.floor(Date.now() / 1000) - (20 * 365.25 * 86400);
  const to = Math.floor(Date.now() / 1000);

  const cookie = await ensureTvSession();

  const endpoints = [
    'https://data.tradingview.com/history',
    'https://history.tradingview.com/history'
  ];

  const errors = [];
  for (const base of endpoints) {
    const url = base + '?symbol=' + encodeURIComponent(sym) + '&resolution=' + res + '&from=' + from + '&to=' + to;
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.tradingview.com/',
        'Origin': 'https://www.tradingview.com'
      };
      if (cookie) headers['Cookie'] = cookie;

      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { errors.push(base + ' -> HTTP ' + r.status); continue; }
      const d = await r.json();
      if (d.s !== 'ok') { errors.push(base + ' -> ' + d.s + ' ' + (d.errmsg || '')); continue; }
      const candles = d.t.map((t, i) => ({
        t: t * 1000, date: new Date(t * 1000).toISOString().slice(0, 10),
        o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v ? d.v[i] : 0
      })).filter(c => c.o != null && c.c != null);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, resolution: res, count: candles.length, source: base, session: !!cookie, candles }) };
    } catch (e) { errors.push(base + ' -> ' + e.message); }
  }
  return { statusCode: 200, headers: H, body: JSON.stringify({ ticker, error: 'all endpoints failed', session: !!cookie, details: errors, candles: [] }) };
};
