// CRT Scanner v11 - Jake's exact rules + TV cache priority
//
// Rules:
// 1. CRT candle = completed calendar period (year/quarter/half/month)
// 2. Sweep candle = next period, wicked beyond the CRT low/high AND closed back inside
// 3. TBOS = TBOS-timeframe candle closes back above the last swing high before the sweep
// 4. Entry forming = current TBOS candle is sweeping now (no TBOS yet confirmed)

const cacheHandler = require('./cache');

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  const ticker = (event.queryStringParameters || {}).ticker;
  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required' }) };
  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  var dataSource = 'yahoo';

  // Try TV cache first, fall back to Yahoo
  async function getCandles(iv, rg) {
    if (iv === '1d' || iv === '1wk' || iv === '1mo') {
      try {
        var cr = await cacheHandler.handler({
          httpMethod: 'GET',
          queryStringParameters: { ticker: ticker, range: rg }
        });
        var cd = JSON.parse(cr.body);
        if (cd.hit && !cd.stale && cd.candles.length >= 20) {
          dataSource = 'tradingview';
          var candles = cd.candles.map(function(c) {
            return { t: c.t, date: new Date(c.t).toISOString().slice(0, 10), o: c.o, h: c.h, l: c.l, c: c.c };
          });
          if (iv === '1wk') return aggWeekly(candles);
          if (iv === '1mo') return aggMonthly(candles);
          return candles;
        }
      } catch(e) {}
    }
    return yf(iv, rg);
  }

  function aggWeekly(daily) {
    var weeks = {}, ord = [];
    daily.forEach(function(c) {
      var d = new Date(c.t);
      var day = d.getUTCDay();
      var mon = new Date(c.t - day * 86400000);
      var k = mon.toISOString().slice(0, 10);
      if (!weeks[k]) { weeks[k] = { t: c.t, date: c.date, o: c.o, h: c.h, l: c.l, c: c.c }; ord.push(k); }
      else { if (c.h > weeks[k].h) weeks[k].h = c.h; if (c.l < weeks[k].l) weeks[k].l = c.l; weeks[k].c = c.c; }
    });
    return ord.map(function(k) { return weeks[k]; });
  }

  function aggMonthly(daily) {
    var months = {}, ord = [];
    daily.forEach(function(c) {
      var k = c.date.substring(0, 7);
      if (!months[k]) { months[k] = { t: c.t, date: c.date, o: c.o, h: c.h, l: c.l, c: c.c }; ord.push(k); }
      else { if (c.h > months[k].h) months[k].h = c.h; if (c.l < months[k].l) months[k].l = c.l; months[k].c = c.c; }
    });
    return ord.map(function(k) { return months[k]; });
  }

  async function yf(iv, rg) {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=' + iv + '&range=' + rg,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) throw new Error('Yahoo ' + r.status);
    const d = await r.json();
    const res = d.chart && d.chart.result && d.chart.result[0];
    if (!res) throw new Error('no data');
    const ts = res.timestamp || [];
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    return ts.map(function(t, i) {
      return {
        t: t * 1000,
        date: new Date(t * 1000).toISOString().slice(0, 10),
        o: q.open && q.open[i],
        h: q.high && q.high[i],
        l: q.low && q.low[i],
        c: q.close && q.close[i]
      };
    }).filter(function(c) { return c.o != null && c.c != null && c.h != null && c.l != null; });
  }

  // Group monthly candles into calendar periods
  function grp(arr, keyFn) {
    var g = {}, ord = [];
    arr.forEach(function(c) {
      var k = keyFn(c);
      if (!g[k]) { g[k] = { t: c.t, date: c.date, o: c.o, h: c.h, l: c.l, c: c.c }; ord.push(k); }
      else { if (c.h > g[k].h) g[k].h = c.h; if (c.l < g[k].l) g[k].l = c.l; g[k].c = c.c; }
    });
    return ord.map(function(k) { return g[k]; });
  }
  function ky(c) { return c.date.substring(0, 4); }
  function kq(c) { var m = parseInt(c.date.substring(5, 7)); return c.date.substring(0, 4) + '-Q' + Math.ceil(m / 3); }
  function kh(c) { var m = parseInt(c.date.substring(5, 7)); return c.date.substring(0, 4) + (m <= 6 ? '-H1' : '-H2'); }
  function k9(c) { var m = parseInt(c.date.substring(5, 7)); return c.date.substring(0, 4) + (m <= 9 ? '-P1' : '-P2'); }

  try {
    var mo1 = await getCandles('1mo', '15y');
    var wk1 = await getCandles('1wk', '5y');
    var day1 = await getCandles('1d', '3y');
    if (mo1.length < 24) throw new Error('insufficient data');

    var day2 = [];
    for (var i = 0; i < day1.length; i += 2) {
      var s = day1.slice(i, i + 2);
      if (s.length) day2.push({
        t: s[0].t, date: s[0].date, o: s[0].o,
        h: Math.max(s[0].h, s[1] ? s[1].h : s[0].h),
        l: Math.min(s[0].l, s[1] ? s[1].l : s[0].l),
        c: s[s.length - 1].c
      });
    }

    var MODELS = [
      { label: '1M CRT',  C: mo1,        T: day2, entryTFs: ['1D', '4H'] },
      { label: '3M CRT',  C: grp(mo1,kq),T: mo1,  entryTFs: ['2D', '3D'] },
      { label: '6M CRT',  C: grp(mo1,kh),T: wk1,  entryTFs: ['2W', '1W'] },
      { label: '9M CRT',  C: grp(mo1,k9),T: wk1,  entryTFs: ['2W', '1W'] },
      { label: '12M CRT', C: grp(mo1,ky),T: mo1,  entryTFs: ['3W', '2W'] },
    ];

    var signals = [];

    for (var mi = 0; mi < MODELS.length; mi++) {
      var m = MODELS[mi], C = m.C, T = m.T;
      if (!C || C.length < 3 || !T || !T.length) continue;

      for (var ii = C.length - 3; ii <= C.length - 2; ii++) {
        if (ii < 0) continue;
        var crt = C[ii], inner = C[ii + 1];
        if (!crt || !inner) continue;
        var crtRange = crt.h - crt.l;
        if (crtRange <= 0) continue;

        if (inner.l < crt.l && inner.c > crt.l && inner.h < crt.h) {
          var tbos = T.filter(function(x) { return x.t > inner.t; });
          if (tbos.length) {
            var tbosLvl = crt.h;
            var preSweep = T.filter(function(x) { return x.t > crt.t && x.t <= inner.t; });
            preSweep.forEach(function(x) { if (x.h > tbosLvl) tbosLvl = x.h; });
            var purges = 1;
            var tbosC = null, tbosAge = null;
            for (var j = 0; j < tbos.length; j++) {
              var c = tbos[j];
              if (c.l < crt.l) purges++;
              if (c.c > tbosLvl && !tbosC) { tbosC = c; tbosAge = tbos.length - 1 - j; }
            }
            var last = tbos[tbos.length - 1];
            var sweepingNow = !tbosC && last.l < crt.l && last.c >= crt.l;
            var tbosForming = !tbosC && !sweepingNow && last.c > tbosLvl;
            var targetHit = tbos.some(function(x){return x.c>crt.h;});
            if (!targetHit && (tbosC || sweepingNow || tbosForming)) {
              if (!tbosC || tbosAge <= 5) {
                var conf = 60; if (purges >= 2) conf += 10;
                if (tbosForming) conf += 15; else if (tbosC && tbosAge === 0) conf += 15; else if (tbosC && tbosAge === 1) conf += 10; else if (tbosC && tbosAge === 2) conf += 5;
                if (sweepingNow) conf += 5; conf = Math.min(conf, 85);
                signals.push({ type: purges >= 2 ? 'Double Purge CRT' : 'Classic CRT', model: m.label, direction: 'LONG', crtHigh: crt.h, crtLow: crt.l, crtDate: crt.date, innerClose: inner.c, innerDate: inner.date, sweepLow: inner.l, tbosLevel: tbosLvl, tbosDate: tbosC ? tbosC.date : (tbosForming ? 'Forming now' : (sweepingNow ? 'Sweep forming' : null)), tbosAge: tbosC ? tbosAge : -1, purgeCount: purges, entryTFs: m.entryTFs, baseConfidence: conf, sweepingNow: sweepingNow, tbosForming: tbosForming });
              }
            }
          }
        }
        if (inner.h > crt.h && inner.c < crt.h && inner.l > crt.l) {
          var tbos = T.filter(function(x) { return x.t > inner.t; });
          if (tbos.length) {
            var tbosLvl = crt.l; var preSweep = T.filter(function(x) { return x.t > crt.t && x.t <= inner.t; });
            preSweep.forEach(function(x) { if (x.l < tbosLvl) tbosLvl = x.l; });
            var purges = 1; var tbosC = null, tbosAge = null;
            for (var j = 0; j < tbos.length; j++) { var c = tbos[j]; if (c.h > crt.h) purges++; if (c.c < tbosLvl && !tbosC) { tbosC = c; tbosAge = tbos.length - 1 - j; } }
            var last = tbos[tbos.length - 1]; var sweepingNow = !tbosC && last.h > crt.h && last.c <= crt.h; var tbosForming = !tbosC && !sweepingNow && last.c < tbosLvl;
            var targetHit = tbos.some(function(x){return x.c<crt.l;});
            if (!targetHit && ((tbosC && tbosAge <= 5) || sweepingNow || tbosForming)) {
              var conf = 60; if (purges >= 2) conf += 10; if (tbosForming) conf += 15; else if (tbosC && tbosAge === 0) conf += 15; else if (tbosC && tbosAge === 1) conf += 10; else if (tbosC && tbosAge === 2) conf += 5; if (sweepingNow) conf += 5; conf = Math.min(conf, 85);
              signals.push({ type: purges >= 2 ? 'Double Purge CRT' : 'Classic CRT', model: m.label, direction: 'SHORT', crtHigh: crt.h, crtLow: crt.l, crtDate: crt.date, innerClose: inner.c, innerDate: inner.date, sweepHigh: inner.h, tbosLevel: tbosLvl, tbosDate: tbosC ? tbosC.date : (tbosForming ? 'Forming now' : (sweepingNow ? 'Sweep forming' : null)), tbosAge: tbosC ? tbosAge : -1, purgeCount: purges, entryTFs: m.entryTFs, baseConfidence: conf, sweepingNow: sweepingNow, tbosForming: tbosForming });
            }
          }
        }
      }
    }
    var price = day1.length ? day1[day1.length - 1].c : null;
    return { statusCode: 200, headers: H, body: JSON.stringify({ ticker: ticker, signals: signals, dataSource: dataSource, meta: { price: price, date: day1.length ? day1[day1.length - 1].date : null } }) };
  } catch (err) { return { statusCode: 200, headers: H, body: JSON.stringify({ ticker: ticker, signals: [], error: err.message }) }; }
};
