// CRT Scanner v12 - Jake's exact rules
// Optimized: parallel Yahoo fetches + in-memory cache + batch scanning

// In-memory cache shared across warm invocations
var dataCache = {};
var CACHE_TTL = 3600000; // 1 hour

exports.handler = async function(event) {
  var H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  var params = event.queryStringParameters || {};
  var ticker = params.ticker;

  // Batch mode: ?tickers=BHP,CBA,CSL
  if (params.tickers) {
    var list = params.tickers.split(',').map(function(t) { return t.trim(); }).filter(Boolean).slice(0, 10);
    var results = await Promise.all(list.map(function(t) { return scanTicker(t).catch(function(e) { return { ticker: t, signals: [], error: e.message }; }); }));
    return { statusCode: 200, headers: H, body: JSON.stringify({ results: results }) };
  }

  if (!ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required. Use ?ticker=BHP or ?tickers=BHP,CBA,CSL' }) };

  try {
    var result = await scanTicker(ticker);
    return { statusCode: 200, headers: H, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ticker: ticker, signals: [], error: err.message }) };
  }
};

async function scanTicker(ticker) {
  var sym = ticker.includes('.') ? ticker : ticker + '.AX';

  // Fetch all 3 timeframes in PARALLEL
  var results = await Promise.all([
    getCachedOrFetch(sym, '1mo', '15y'),
    getCachedOrFetch(sym, '1wk', '5y'),
    getCachedOrFetch(sym, '1d', '3y')
  ]);
  var mo1 = results[0], wk1 = results[1], day1 = results[2];

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

      // BULLISH
      if (inner.l < crt.l && inner.c > crt.l && inner.h < crt.h) {
        var tbos = T.filter(function(x) { return x.t > inner.t; });
        if (tbos.length) {
          var tbosLvl = crt.h;
          T.filter(function(x) { return x.t > crt.t && x.t <= inner.t; }).forEach(function(x) { if (x.h > tbosLvl) tbosLvl = x.h; });
          var purges = 1, tbosC = null, tbosAge = null;
          for (var j = 0; j < tbos.length; j++) {
            if (tbos[j].l < crt.l) purges++;
            if (tbos[j].c > tbosLvl && !tbosC) { tbosC = tbos[j]; tbosAge = tbos.length - 1 - j; }
          }
          var last = tbos[tbos.length - 1];
          var sweepingNow = !tbosC && last.l < crt.l && last.c >= crt.l;
          var tbosForming = !tbosC && !sweepingNow && last.c > tbosLvl;
          var targetHit = tbos.some(function(x) { return x.c > crt.h; });
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

      // BEARISH
      if (inner.h > crt.h && inner.c < crt.h && inner.l > crt.l) {
        var tbos2 = T.filter(function(x) { return x.t > inner.t; });
        if (tbos2.length) {
          var tbosLvl2 = crt.l;
          T.filter(function(x) { return x.t > crt.t && x.t <= inner.t; }).forEach(function(x) { if (x.l < tbosLvl2) tbosLvl2 = x.l; });
          var purges2 = 1, tbosC2 = null, tbosAge2 = null;
          for (var j2 = 0; j2 < tbos2.length; j2++) { if (tbos2[j2].h > crt.h) purges2++; if (tbos2[j2].c < tbosLvl2 && !tbosC2) { tbosC2 = tbos2[j2]; tbosAge2 = tbos2.length - 1 - j2; } }
          var last2 = tbos2[tbos2.length - 1]; var sweepingNow2 = !tbosC2 && last2.h > crt.h && last2.c <= crt.h; var tbosForming2 = !tbosC2 && !sweepingNow2 && last2.c < tbosLvl2;
          var targetHit2 = tbos2.some(function(x) { return x.c < crt.l; });
          if (!targetHit2 && ((tbosC2 && tbosAge2 <= 5) || sweepingNow2 || tbosForming2)) {
            var conf2 = 60; if (purges2 >= 2) conf2 += 10; if (tbosForming2) conf2 += 15; else if (tbosC2 && tbosAge2 === 0) conf2 += 15; else if (tbosC2 && tbosAge2 === 1) conf2 += 10; else if (tbosC2 && tbosAge2 === 2) conf2 += 5; if (sweepingNow2) conf2 += 5; conf2 = Math.min(conf2, 85);
            signals.push({ type: purges2 >= 2 ? 'Double Purge CRT' : 'Classic CRT', model: m.label, direction: 'SHORT', crtHigh: crt.h, crtLow: crt.l, crtDate: crt.date, innerClose: inner.c, innerDate: inner.date, sweepHigh: inner.h, tbosLevel: tbosLvl2, tbosDate: tbosC2 ? tbosC2.date : (tbosForming2 ? 'Forming now' : (sweepingNow2 ? 'Sweep forming' : null)), tbosAge: tbosC2 ? tbosAge2 : -1, purgeCount: purges2, entryTFs: m.entryTFs, baseConfidence: conf2, sweepingNow: sweepingNow2, tbosForming: tbosForming2 });
          }
        }
      }
    }
  }

  var price = day1.length ? day1[day1.length - 1].c : null;

  // ── EMA levels for trade context ──
  var emaLevels = {};
  if (day1.length >= 144) {
    var closes = day1.map(function(c) { return c.c; });
    [8, 13, 21, 34, 55, 89, 144].forEach(function(p) {
      emaLevels['ema' + p] = calcEMA(closes, p);
    });
  }

  // ── EMA alignment ──
  var emaKeys = [8, 13, 21, 34, 55, 89, 144];
  var aligned = true, partialBull = true;
  for (var ei = 0; ei < emaKeys.length - 1; ei++) {
    var a = emaLevels['ema' + emaKeys[ei]], b = emaLevels['ema' + emaKeys[ei + 1]];
    if (a == null || b == null || a <= b) aligned = false;
    if (ei < 3 && (a == null || b == null || a <= b)) partialBull = false;
  }
  var emaStatus = aligned ? 'ALIGNED' : partialBull ? 'PARTIAL' : 'MIXED';

  // ── Trend structure: swing highs/lows ──
  var swingHighs = [], swingLows = [];
  var lookback = Math.min(day1.length, 180);
  var recent = day1.slice(-lookback);
  for (var si = 2; si < recent.length - 2; si++) {
    if (recent[si].h > recent[si-1].h && recent[si].h > recent[si-2].h && recent[si].h > recent[si+1].h && recent[si].h > recent[si+2].h) {
      swingHighs.push(recent[si].h);
    }
    if (recent[si].l < recent[si-1].l && recent[si].l < recent[si-2].l && recent[si].l < recent[si+1].l && recent[si].l < recent[si+2].l) {
      swingLows.push(recent[si].l);
    }
  }
  var lastHighs = swingHighs.slice(-3);
  var lastLows = swingLows.slice(-3);
  var hhhl = lastHighs.length >= 2 && lastLows.length >= 2 &&
    lastHighs[lastHighs.length-1] > lastHighs[lastHighs.length-2] &&
    lastLows[lastLows.length-1] > lastLows[lastLows.length-2];
  var lhll = lastHighs.length >= 2 && lastLows.length >= 2 &&
    lastHighs[lastHighs.length-1] < lastHighs[lastHighs.length-2] &&
    lastLows[lastLows.length-1] < lastLows[lastLows.length-2];
  var structure = hhhl ? 'HH/HL' : lhll ? 'LH/LL' : 'MIXED';
  var trend = hhhl ? 'Uptrend' : lhll ? 'Downtrend' : 'Consolidation';

  // ── S/R levels from 180-bar pivots ──
  var srLevels = [];
  swingHighs.forEach(function(h) { srLevels.push({ level: h, type: 'R' }); });
  swingLows.forEach(function(l) { srLevels.push({ level: l, type: 'S' }); });
  srLevels.sort(function(a, b) { return a.level - b.level; });
  // Cluster nearby levels (within 2%)
  var clustered = [];
  srLevels.forEach(function(sr) {
    var found = false;
    for (var ci = 0; ci < clustered.length; ci++) {
      if (Math.abs(sr.level - clustered[ci].level) / clustered[ci].level < 0.02) {
        clustered[ci].level = (clustered[ci].level + sr.level) / 2;
        clustered[ci].touches++;
        found = true;
        break;
      }
    }
    if (!found) clustered.push({ level: sr.level, type: sr.type, touches: 1 });
  });
  var resistance = clustered.filter(function(s) { return price && s.level > price; }).slice(0, 5);
  var support = clustered.filter(function(s) { return price && s.level < price; }).reverse().slice(0, 5);

  // ── ATR for trailing stop ──
  var atr = 0;
  if (day1.length >= 15) {
    var atrSum = 0;
    for (var ai = day1.length - 14; ai < day1.length; ai++) {
      var tr = Math.max(day1[ai].h - day1[ai].l, Math.abs(day1[ai].h - day1[ai-1].c), Math.abs(day1[ai].l - day1[ai-1].c));
      atrSum += tr;
    }
    atr = atrSum / 14;
  }
  var trailingStop = emaLevels.ema8 ? +(emaLevels.ema8 - atr).toFixed(4) : null;
  var trailPct = price && trailingStop ? +((price - trailingStop) / price * 100).toFixed(1) : null;

  // ── Volume context ──
  var vol5 = 0, vol20 = 0;
  if (day1.length >= 20) {
    for (var vi = day1.length - 5; vi < day1.length; vi++) vol5 += (day1[vi].v || 0);
    for (var vj = day1.length - 20; vj < day1.length; vj++) vol20 += (day1[vj].v || 0);
  }
  var rvol = vol20 > 0 ? +((vol5 / 5) / (vol20 / 20)).toFixed(1) : 0;
  var volStatus = rvol >= 1.5 ? 'Expanding' : rvol >= 0.8 ? 'Normal' : 'Contracting';

  // ── Attach trade context to each signal ──
  signals.forEach(function(sig) {
    sig.emaLevels = emaLevels;
    sig.emaStatus = emaStatus;
    sig.structure = structure;
    sig.trend = trend;
    sig.swingHighs = lastHighs;
    sig.swingLows = lastLows;
    sig.resistance = resistance;
    sig.support = support;
    sig.atr = +atr.toFixed(4);
    sig.trailingStop = trailingStop;
    sig.trailPct = trailPct;
    sig.rvol = rvol;
    sig.volStatus = volStatus;
    // Entry/stop/target
    if (sig.direction === 'LONG') {
      sig.entry = price;
      sig.stopLoss = sig.crtLow ? +(sig.crtLow - atr * 0.5).toFixed(4) : null;
      sig.target = resistance.length ? resistance[0].level : null;
    } else {
      sig.entry = price;
      sig.stopLoss = sig.crtHigh ? +(sig.crtHigh + atr * 0.5).toFixed(4) : null;
      sig.target = support.length ? support[0].level : null;
    }
    if (sig.entry && sig.stopLoss && sig.target) {
      var risk = Math.abs(sig.entry - sig.stopLoss);
      var reward = Math.abs(sig.target - sig.entry);
      sig.rr = risk > 0 ? +(reward / risk).toFixed(1) : null;
    }
  });

  return { ticker: ticker, signals: signals, meta: { price: price, date: day1.length ? day1[day1.length - 1].date : null, emaStatus: emaStatus, structure: structure, trend: trend, rvol: rvol } };
}

// ── EMA calculator ──
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  var k = 2 / (period + 1);
  var ema = 0;
  for (var i = 0; i < period; i++) ema += prices[i];
  ema /= period;
  for (var j = period; j < prices.length; j++) {
    ema = prices[j] * k + ema * (1 - k);
  }
  return +ema.toFixed(4);
}

// ── Cached Yahoo fetch ──
function getCachedOrFetch(sym, interval, range) {
  var key = sym + '_' + interval + '_' + range;
  var cached = dataCache[key];
  if (cached && (Date.now() - cached.time) < CACHE_TTL) return Promise.resolve(cached.data);
  return yf(sym, interval, range).then(function(data) {
    dataCache[key] = { data: data, time: Date.now() };
    return data;
  });
}

function yf(sym, iv, rg) {
  return fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=' + iv + '&range=' + rg, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then(function(r) { if (!r.ok) throw new Error('Yahoo ' + r.status); return r.json(); })
    .then(function(d) {
      var res = d.chart && d.chart.result && d.chart.result[0];
      if (!res) throw new Error('no data');
      var ts = res.timestamp || [];
      var q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      return ts.map(function(t, i) {
        return { t: t * 1000, date: new Date(t * 1000).toISOString().slice(0, 10), o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i] };
      }).filter(function(c) { return c.o != null && c.c != null && c.h != null && c.l != null; });
    });
}

// ── Grouping helpers ──
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
