/*  ═══════════════════════════════════════════════════════════════════════
    CRT ENGINE v1 — Jake's exact 4 CRT entry models × 5 timeframe models
    ═══════════════════════════════════════════════════════════════════════
    Models:  1. Classic CRT          (completed sweep → TBOS after)
             2. Double Purge CRT     (two sweeps, deeper → TBOS after)
             3. Double Purge 1-Candle (FBOS on first purge, TRUE BOS within forming)
             4. Normal 1-Candle      (sweep + TBOS within one forming candle)

    TFs:     12M (TBOS=Monthly)  9M (TBOS=Weekly)  6M (TBOS=Weekly)
             3M  (TBOS=Monthly)  1M (TBOS=2-Day aggregated)

    Data:    TradingView primary (native resolutions), Yahoo Finance fallback
    ═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── warm-instance cache ─────────────────────────────────────────── */
var dataCache = {};
var CACHE_TTL = 3600000; // 1 hour


/* ═══════════════════════  HTTP HANDLER  ═══════════════════════════ */

exports.handler = async function (event) {
  var H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  var p = event.queryStringParameters || {};

  /* ── batch: ?tickers=BHP,CBA,CSL  (max 5) ── */
  if (p.tickers) {
    var list = p.tickers.split(',').map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 5);
    var results = await Promise.all(list.map(function (t) {
      return scanTicker(t).catch(function (e) { return { ticker: t, signals: [], error: e.message }; });
    }));
    return { statusCode: 200, headers: H, body: JSON.stringify({ results: results }) };
  }

  /* ── single: ?ticker=BHP ── */
  if (!p.ticker) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'ticker required' }) };
  try {
    var result = await scanTicker(p.ticker);
    return { statusCode: 200, headers: H, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ticker: p.ticker, signals: [], error: err.message }) };
  }
};

/* ═══════════════════════  MAIN SCAN  ═════════════════════════════ */

async function scanTicker(ticker) {
  var sym = ticker.includes('.') ? ticker : ticker + '.AX';

  /* ── parallel Yahoo Finance fetch: monthly 15yr · weekly 5yr · daily 3yr ──
     TV data endpoints are server-blocked (only serve in-browser requests).
     Yahoo provides identical ASX candle data — same market feed, 15yr depth. */
  var raw = await Promise.all([
    getCachedOrFetch(sym, '1mo', '15y'),
    getCachedOrFetch(sym, '1wk', '5y'),
    getCachedOrFetch(sym, '1d',  '3y')
  ]);
  var mo = raw[0], wk = raw[1], dy = raw[2];
  if (mo.length < 12) throw new Error('insufficient data (' + mo.length + ' months)');

  /* build period candles from monthly data */
  var day2   = buildNDayCandles(dy, 2);   // 2-day aggregated for 1M TBOS
  var yearly = grp(mo, ky);               // 12M CRT candles
  var nineMo = grp(mo, k9);               // 9M  CRT candles
  var halfYr = grp(mo, kh);               // 6M  CRT candles
  var qtrly  = grp(mo, kq);              // 3M  CRT candles

  /* add end-of-period timestamps */
  addEndT(yearly); addEndT(nineMo); addEndT(halfYr); addEndT(qtrly); addEndT(mo);

  /* 5 timeframe models ── CRT candle | TBOS timeframe | entry TFs | scan depth | pivot len */
  var MODELS = [
    { label: '12M CRT', crt: yearly, tbos: mo,   eTF: ['3W','2W'], back: 3, piv: 2 },
    { label: '9M CRT',  crt: nineMo, tbos: wk,   eTF: ['2W','1W'], back: 4, piv: 2 },
    { label: '6M CRT',  crt: halfYr, tbos: wk,   eTF: ['2W','1W'], back: 4, piv: 2 },
    { label: '3M CRT',  crt: qtrly,  tbos: mo,   eTF: ['2D','3D'], back: 6, piv: 2 },
    { label: '1M CRT',  crt: mo,     tbos: day2,  eTF: ['1D','4H'], back: 8, piv: 3 }
  ];

  var signals = [];

  for (var mi = 0; mi < MODELS.length; mi++) {
    var m = MODELS[mi], C = m.crt, T = m.tbos;
    if (!C || C.length < 3 || !T || T.length < 5) continue;

    /* pre-compute TBOS-TF swings */
    var swH = findSwings(T, 'high', m.piv);
    var swL = findSwings(T, 'low',  m.piv);

    /* scan last N completed CRT candles as c1 (last candle = forming) */
    var endIdx   = C.length - 1;
    var startIdx = Math.max(0, endIdx - m.back);

    for (var ci = startIdx; ci < endIdx; ci++) {
      var c1 = C[ci];
      if (!c1 || c1.h - c1.l <= 0) continue;
      var after = C.slice(ci + 1);

      /* bullish + bearish detection */
      var bull = detectDirection(c1, after, T, swH, true,  m.label, m.eTF);
      var bear = detectDirection(c1, after, T, swL, false, m.label, m.eTF);
      for (var b = 0; b < bull.length; b++) signals.push(bull[b]);
      for (var r = 0; r < bear.length; r++) signals.push(bear[r]);
    }
  }

  /* ── trade context ── */
  var price    = dy.length ? dy[dy.length - 1].c : null;
  var lastDate = dy.length ? dy[dy.length - 1].date : null;
  var atr      = calcATR(dy, 14);

  for (var si = 0; si < signals.length; si++) {
    var s = signals[si];
    s.price = price;
    s.atr   = r4(atr);
    if (s.direction === 'LONG') {
      s.entry    = price;
      s.stopLoss = s.sweepExtreme != null ? r4(s.sweepExtreme - atr * 0.3) : null;
      s.target   = s.crtHigh;
    } else {
      s.entry    = price;
      s.stopLoss = s.sweepExtreme != null ? r4(s.sweepExtreme + atr * 0.3) : null;
      s.target   = s.crtLow;
    }
    if (s.entry != null && s.stopLoss != null && s.target != null) {
      var risk   = Math.abs(s.entry - s.stopLoss);
      var reward = Math.abs(s.target - s.entry);
      s.rr = risk > 0 ? r2(reward / risk) : null;
    }
  }

  /* sort: confirmed first → then by confidence desc */
  signals.sort(function (a, b) {
    var sa = a.status === 'CONFIRMED' ? 0 : a.status === 'FORMING' ? 1 : 2;
    var sb = b.status === 'CONFIRMED' ? 0 : b.status === 'FORMING' ? 1 : 2;
    if (sa !== sb) return sa - sb;
    return b.confidence - a.confidence;
  });

  return { ticker: ticker, price: price, date: lastDate, signalCount: signals.length, signals: signals, source: 'yahoo' };
}

/* ═══════════════════════  CORE DETECTION  ════════════════════════ */
/*
   For a given c1 (completed CRT candle) and direction:
   1. Check target not already reached
   2. Walk subsequent candles — skip inside bars, reject both-sides-taken
   3. Collect purge candles (wicked beyond c1's level)
   4. Find TBOS level (last swing on TBOS-TF before the actual sweep moment)
   5. Classify into one of 4 CRT models
   6. Check TBOS confirmation
*/

function detectDirection(c1, afterCandles, tbosCandles, tbosSwings, isLong, modelLabel, entryTFs) {
  var signals = [];

  /* ── target already reached? ── */
  var c1End = c1.endT || c1.t;
  for (var ti = 0; ti < tbosCandles.length; ti++) {
    if (tbosCandles[ti].t <= c1End) continue;
    if (isLong ? tbosCandles[ti].c > c1.h : tbosCandles[ti].c < c1.l) return signals; // done
  }

  /* ── walk subsequent CRT candles, classify purges ── */
  var purges  = [];
  var invalid = false;

  for (var i = 0; i < afterCandles.length; i++) {
    var cn     = afterCandles[i];
    var isLast = (i === afterCandles.length - 1); // last = potentially forming

    /* both sides taken in one candle → entire c1 setup invalid */
    if (cn.l < c1.l && cn.h > c1.h) { invalid = true; break; }

    /* inside bar (range within c1): irrelevant — skip */
    if (cn.h <= c1.h && cn.l >= c1.l) continue;

    /* purge check: did this candle wick beyond c1's swept level? */
    var isPurge = isLong ? (cn.l < c1.l) : (cn.h > c1.h);
    if (!isPurge) continue; // broke opposite side only — not relevant

    purges.push({
      candle:     cn,
      isForming:  isLast,
      closedBack: isLong ? (cn.c > c1.l) : (cn.c < c1.h),
      extreme:    isLong ? cn.l : cn.h
    });
  }

  if (invalid || !purges.length) return signals;

  /* ── find TBOS level ──
     "last swing high/low on TBOS-TF before the sweep of c1's level"
     Use the actual moment the first purge breached c1 (not just the CRT candle start) */
  var firstPurge    = purges[0];
  var sweepMoment   = findSweepMoment(tbosCandles, firstPurge.candle, c1, isLong);
  var tbosLevel     = findLastSwingBefore(tbosSwings, sweepMoment);
  if (tbosLevel === null) return signals; // no structural swing found

  /* ════════  CLASSIFY INTO 4 MODELS  ════════ */

  if (purges.length === 1) {
    /* ── SINGLE PURGE ── */
    var p = purges[0];
    if (!p.closedBack) return signals; // wick didn't close back → no valid sweep

    if (!p.isForming) {
      /* MODEL 1: Classic CRT — completed sweep → look for TBOS after sweep ends */
      var afterTs = p.candle.endT || p.candle.t;
      var tc = findTbosAfter(tbosCandles, afterTs, tbosLevel, isLong);
      if ((tc.confirmed && tc.age <= 12) || tc.forming) {
        signals.push(buildSig('Classic CRT', modelLabel, isLong, c1, p, null, tbosLevel, tc, entryTFs));
      }
    } else {
      /* MODEL 4: Normal 1-Candle CRT — forming sweep, TBOS within */
      var within = tbosRange(tbosCandles, p.candle.t, Date.now());
      var tc4    = findTbosInSet(within, tbosLevel, isLong);
      if (tc4.confirmed) {
        signals.push(buildSig('Normal 1-Candle CRT', modelLabel, isLong, c1, p, null, tbosLevel, tc4, entryTFs));
      }
    }
    return signals;
  }

  /* ── MULTIPLE PURGES ── */
  var lastPurge = purges[purges.length - 1];
  var isDeeper  = isLong
    ? (lastPurge.extreme < firstPurge.extreme)
    : (lastPurge.extreme > firstPurge.extreme);

  if (!isDeeper) {
    /* not deeper → treat as single purge with first valid completed sweep */
    for (var vi = 0; vi < purges.length; vi++) {
      if (purges[vi].closedBack && !purges[vi].isForming) {
        var aTs = purges[vi].candle.endT || purges[vi].candle.t;
        var tcv = findTbosAfter(tbosCandles, aTs, tbosLevel, isLong);
        if ((tcv.confirmed && tcv.age <= 12) || tcv.forming) {
          signals.push(buildSig('Classic CRT', modelLabel, isLong, c1, purges[vi], null, tbosLevel, tcv, entryTFs));
        }
        break;
      }
    }
    /* also check if last (forming) candle gives a 1-candle signal */
    if (lastPurge.isForming && lastPurge.closedBack) {
      var w2   = tbosRange(tbosCandles, lastPurge.candle.t, Date.now());
      var tc1c = findTbosInSet(w2, tbosLevel, isLong);
      if (tc1c.confirmed) {
        signals.push(buildSig('Normal 1-Candle CRT', modelLabel, isLong, c1, lastPurge, null, tbosLevel, tc1c, entryTFs));
      }
    }
    return signals;
  }

  /* ── deeper last purge → double purge candidate ── */
  if (!lastPurge.closedBack) return signals; // last purge must close back

  if (!lastPurge.isForming) {
    /* MODEL 2: Double Purge CRT — both purges completed */
    var afterTs2 = lastPurge.candle.endT || lastPurge.candle.t;
    var tc2 = findTbosAfter(tbosCandles, afterTs2, tbosLevel, isLong);
    if ((tc2.confirmed && tc2.age <= 12) || tc2.forming) {
      signals.push(buildSig('Double Purge CRT', modelLabel, isLong, c1, lastPurge, firstPurge, tbosLevel, tc2, entryTFs));
    }
  } else {
    /* MODEL 3: Double Purge 1-Candle CRT
       - FBOS after first purge (failed break of TBOS level)
       - TRUE BOS within forming second purge */
    var fpEnd = firstPurge.candle.endT || firstPurge.candle.t;
    var lpStart = lastPurge.candle.t;
    var fbos = checkFBOS(tbosCandles, fpEnd, lpStart, tbosLevel, isLong);
    if (fbos.found) {
      var w3      = tbosRange(tbosCandles, lpStart, Date.now());
      var trueBos = findTbosInSet(w3, tbosLevel, isLong);
      if (trueBos.confirmed) {
        signals.push(buildSig('Double Purge 1-Candle CRT', modelLabel, isLong, c1, lastPurge, firstPurge, tbosLevel, trueBos, entryTFs));
      }
    }
  }

  return signals;
}

/* ═══════════════════════  SWEEP MOMENT  ═════════════════════════ */
/* Find when exactly the purge first breached c1's level on the TBOS TF.
   This gives a precise timestamp for locating the correct TBOS swing level. */

function findSweepMoment(tbosCandles, purgeCandle, c1, isLong) {
  var start = purgeCandle.t;
  var end   = purgeCandle.endT || (purgeCandle.t + 366 * 86400000);
  for (var i = 0; i < tbosCandles.length; i++) {
    if (tbosCandles[i].t < start) continue;
    if (tbosCandles[i].t > end) break;
    if (isLong ? tbosCandles[i].l < c1.l : tbosCandles[i].h > c1.h) {
      return tbosCandles[i].t;
    }
  }
  return start; // fallback: purge candle start
}

/* ═══════════════════════  SWING DETECTION  ═══════════════════════ */

function findSwings(candles, type, pivotLen) {
  var swings = [];
  var n = pivotLen || 2;
  for (var i = n; i < candles.length - n; i++) {
    var ok = true;
    for (var j = 1; j <= n; j++) {
      if (type === 'high') {
        if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) { ok = false; break; }
      } else {
        if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) { ok = false; break; }
      }
    }
    if (ok) {
      swings.push({ t: candles[i].t, date: candles[i].date, level: type === 'high' ? candles[i].h : candles[i].l });
    }
  }
  return swings;
}

/* last swing before a timestamp (swings are chronological) */
function findLastSwingBefore(swings, ts) {
  var last = null;
  for (var i = 0; i < swings.length; i++) {
    if (swings[i].t < ts) last = swings[i];
    else break;
  }
  return last ? last.level : null;
}

/* ═══════════════════════  TBOS HELPERS  ══════════════════════════ */

/* After a completed sweep: find first TBOS-TF candle that closes past level */
function findTbosAfter(tbosCandles, afterTs, level, isLong) {
  for (var i = 0; i < tbosCandles.length; i++) {
    if (tbosCandles[i].t <= afterTs) continue;
    if (isLong ? tbosCandles[i].c > level : tbosCandles[i].c < level) {
      return { confirmed: true, forming: false, date: tbosCandles[i].date, age: tbosCandles.length - 1 - i };
    }
  }
  /* check if last candle is approaching level (within 3%) */
  if (tbosCandles.length) {
    var last = tbosCandles[tbosCandles.length - 1];
    if (last.t > afterTs) {
      var dist = isLong ? (level - last.c) / level : (last.c - level) / level;
      if (dist >= 0 && dist < 0.03) {
        return { confirmed: false, forming: true, date: last.date, age: 0 };
      }
    }
  }
  return { confirmed: false, forming: false, date: null, age: -1 };
}

/* Within a forming candle: find TBOS confirmation in a set of candles */
function findTbosInSet(candles, level, isLong) {
  for (var i = 0; i < candles.length; i++) {
    if (isLong ? candles[i].c > level : candles[i].c < level) {
      return { confirmed: true, forming: false, date: candles[i].date, age: candles.length - 1 - i };
    }
  }
  return { confirmed: false, forming: false, date: null, age: -1 };
}

/* TBOS candles within a time range */
function tbosRange(tbosCandles, fromTs, toTs) {
  var out = [];
  for (var i = 0; i < tbosCandles.length; i++) {
    if (tbosCandles[i].t >= fromTs && tbosCandles[i].t <= toTs) out.push(tbosCandles[i]);
  }
  return out;
}

/* FBOS check: between first and second purge, candle wicked past level but closed back
   (False Break of Structure — failed attempt to confirm the structural break) */
function checkFBOS(tbosCandles, afterTs, beforeTs, level, isLong) {
  for (var i = 0; i < tbosCandles.length; i++) {
    var c = tbosCandles[i];
    if (c.t <= afterTs)  continue;
    if (c.t >= beforeTs) break;
    if (isLong) {
      /* wicked above swing high but closed at/below = FBOS */
      if (c.h > level && c.c <= level) return { found: true, date: c.date };
    } else {
      /* wicked below swing low but closed at/above = FBOS */
      if (c.l < level && c.c >= level) return { found: true, date: c.date };
    }
  }
  return { found: false, date: null };
}

/* ═══════════════════════  CONFIDENCE SCORING  ═══════════════════ */

function scoreConfidence(modelType, purgeCount, tbosConf, sweep, c1, isLong) {
  var score = 50;

  /* model-type bonus */
  if (modelType === 'double_purge')    score += 12;  // deeper liquidity grab
  if (modelType === 'double_purge_1c') score += 15;  // FBOS → TRUE BOS = high conviction
  if (modelType === 'normal_1c')       score += 8;   // sweep + BOS in one candle = momentum

  /* multi-purge bonus */
  if (purgeCount >= 3) score += 8;
  else if (purgeCount >= 2) score += 5;

  /* TBOS confirmation */
  if (tbosConf.confirmed) {
    score += 10;
    if      (tbosConf.age <= 1) score += 8;  // very fresh
    else if (tbosConf.age <= 3) score += 5;
    else if (tbosConf.age <= 6) score += 2;
  } else if (tbosConf.forming) {
    score += 4;
  }

  /* sweep quality: depth relative to CRT range */
  var crtRange = c1.h - c1.l;
  if (crtRange > 0) {
    var depth = isLong
      ? (c1.l - sweep.extreme) / crtRange
      : (sweep.extreme - c1.h) / crtRange;
    if (depth > 0.01 && depth < 0.4) score += 5;  // clean wick, not excessively deep
  }

  return Math.min(score, 95);
}

/* ═══════════════════════  SIGNAL BUILDER  ════════════════════════ */

function buildSig(type, modelLabel, isLong, c1, sweep, firstPurge, tbosLevel, tbosConf, entryTFs) {
  var dir    = isLong ? 'LONG' : 'SHORT';
  var status = tbosConf.confirmed ? 'CONFIRMED' : (tbosConf.forming ? 'FORMING' : 'SWEEP_ACTIVE');

  var modelKey = type === 'Classic CRT' ? 'classic'
    : type === 'Double Purge CRT' ? 'double_purge'
    : type === 'Double Purge 1-Candle CRT' ? 'double_purge_1c'
    : 'normal_1c';

  var conf = scoreConfidence(modelKey, firstPurge ? 2 : 1, tbosConf, sweep, c1, isLong);

  return {
    type:              type,
    model:             modelLabel,
    direction:         dir,
    status:            status,
    confidence:        conf,
    crtHigh:           r4(c1.h),
    crtLow:            r4(c1.l),
    crtDate:           c1.date,
    sweepDate:         sweep.candle.date,
    sweepExtreme:      r4(sweep.extreme),
    sweepForming:      sweep.isForming,
    firstPurgeDate:    firstPurge ? firstPurge.candle.date : null,
    firstPurgeExtreme: firstPurge ? r4(firstPurge.extreme) : null,
    tbosLevel:         r4(tbosLevel),
    tbosDate:          tbosConf.date || null,
    tbosAge:           tbosConf.age,
    purgeCount:        firstPurge ? 2 : 1,
    entryTFs:          entryTFs
  };
}

/* ═══════════════════════  CANDLE BUILDERS  ═══════════════════════ */

/* Group monthly candles into calendar periods */
function grp(arr, keyFn) {
  var g = {}, ord = [];
  for (var i = 0; i < arr.length; i++) {
    var k = keyFn(arr[i]);
    if (!g[k]) {
      g[k] = { t: arr[i].t, date: arr[i].date, o: arr[i].o, h: arr[i].h, l: arr[i].l, c: arr[i].c, endT: arr[i].t, endDate: arr[i].date };
      ord.push(k);
    } else {
      if (arr[i].h > g[k].h) g[k].h = arr[i].h;
      if (arr[i].l < g[k].l) g[k].l = arr[i].l;
      g[k].c       = arr[i].c;
      g[k].endT    = arr[i].t;
      g[k].endDate = arr[i].date;
    }
  }
  return ord.map(function (k) { return g[k]; });
}

/* Period key functions */
function ky(c) { return c.date.slice(0, 4); }
function kq(c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + '-Q' + Math.ceil(m / 3); }
function kh(c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + (m <= 6 ? '-H1' : '-H2'); }
function k9(c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + (m <= 9 ? '-P1' : '-P2'); }

/* Overwrite endT using the NEXT candle's start (more accurate than last component) */
function addEndT(arr) {
  for (var i = 0; i < arr.length; i++) {
    if (i < arr.length - 1) arr[i].endT = arr[i + 1].t - 1;
    else                     arr[i].endT = Date.now();
  }
}

/* Build N-day aggregated candles (2-day for 1M TBOS) */
function buildNDayCandles(daily, n) {
  var out = [];
  for (var i = 0; i < daily.length; i += n) {
    var chunk = daily.slice(i, i + n);
    if (!chunk.length) continue;
    var c = { t: chunk[0].t, date: chunk[0].date, o: chunk[0].o, h: chunk[0].h, l: chunk[0].l, c: chunk[chunk.length - 1].c };
    for (var j = 1; j < chunk.length; j++) {
      if (chunk[j].h > c.h) c.h = chunk[j].h;
      if (chunk[j].l < c.l) c.l = chunk[j].l;
    }
    out.push(c);
  }
  return out;
}

/* ═══════════════════════  TECHNICAL HELPERS  ═════════════════════ */

function calcATR(candles, period) {
  if (candles.length < period + 1) return 0;
  var sum = 0;
  for (var i = candles.length - period; i < candles.length; i++) {
    var tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

function r4(v) { return v != null ? +(+v).toFixed(4) : null; }
function r2(v) { return v != null ? +(+v).toFixed(2) : null; }

/* ═══════════════════════  DATA FETCHING  ═════════════════════════ */
/*  Yahoo Finance — identical ASX candle data to TradingView (same market feed).
    TV data endpoints are server-blocked (only serve in-browser requests).       */

function getCachedOrFetch(sym, interval, range) {
  var key = sym + '_' + interval + '_' + range;
  var cached = dataCache[key];
  if (cached && Date.now() - cached.time < CACHE_TTL) return Promise.resolve(cached.data);
  return yf(sym, interval, range).then(function (data) {
    dataCache[key] = { data: data, time: Date.now() };
    return data;
  });
}


function yf(sym, iv, rg) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=' + iv + '&range=' + rg;
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })
    .then(function (r) { if (!r.ok) throw new Error('Yahoo ' + r.status); return r.json(); })
    .then(function (d) {
      var res = d.chart && d.chart.result && d.chart.result[0];
      if (!res) throw new Error('no data for ' + sym);
      var ts = res.timestamp || [];
      var q  = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      return ts.map(function (t, i) {
        return {
          t: t * 1000,
          date: new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }),
          o: q.open  && q.open[i],
          h: q.high  && q.high[i],
          l: q.low   && q.low[i],
          c: q.close && q.close[i]
        };
      }).filter(function (c) { return c.o != null && c.c != null && c.h != null && c.l != null; });
    });
}
