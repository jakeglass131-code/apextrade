/*  ═══════════════════════════════════════════════════════════════════════
    SMT ENGINE — Smart Money Technique divergence scanner
    ═══════════════════════════════════════════════════════════════════════
    Logic:  1. Build candle arrays for 2W, 1M, 2M, 3M, 6M, 9M, 12M
            2. Find swing highs/lows on each TF
            3. Apply spacing filter → keep only "relevant" highs/lows
            4. Compare between correlated pairs for divergence
            5. Check recent levels + historical extremes (2–5yr)

    Usage:  ?t1=BHP&t2=RIO          — single pair analysis
            ?t1=BHP&partners=RIO,FMG,S32  — one ticker vs multiple partners
    ═══════════════════════════════════════════════════════════════════════ */

'use strict';

var dataCache = {};
var CACHE_TTL = 3600000;

exports.handler = async function (event) {
  var H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  var p = event.queryStringParameters || {};

  if (!p.t1) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 't1 required' }) };

  /* ── single pair: ?t1=BHP&t2=RIO ── */
  if (p.t2 && !p.partners) {
    try {
      var result = await analyzePair(p.t1, p.t2, parseFloat(p.c) || 0);
      return { statusCode: 200, headers: H, body: JSON.stringify(result) };
    } catch (err) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ t1: p.t1, t2: p.t2, divergences: [], error: err.message }) };
    }
  }

  /* ── multi-partner: ?t1=BHP&partners=RIO:85,FMG:78,S32:72 ── */
  if (p.partners) {
    var pairs = p.partners.split(',').map(function (s) {
      var parts = s.split(':');
      return { t2: parts[0], c: parts[1] ? parseInt(parts[1]) / 100 : 0 };
    }).slice(0, 8); // max 8 partners per call

    var results = [];
    // Fetch t1 data once, reuse for all partners
    var t1Data = await fetchTickerData(p.t1);
    if (!t1Data) return { statusCode: 200, headers: H, body: JSON.stringify({ t1: p.t1, results: [], error: 'no data for ' + p.t1 }) };

    var t1Levels = buildAllLevels(t1Data);

    for (var i = 0; i < pairs.length; i++) {
      try {
        var t2Data = await fetchTickerData(pairs[i].t2);
        if (!t2Data) { results.push({ t1: p.t1, t2: pairs[i].t2, divergences: [], error: 'no data' }); continue; }
        var t2Levels = buildAllLevels(t2Data);
        var divs = detectDivergences(p.t1, pairs[i].t2, t1Levels, t2Levels, t1Data, t2Data);
        results.push({ t1: p.t1, t2: pairs[i].t2, correlation: pairs[i].c, divergences: divs, t1Levels: summarizeLevels(t1Levels), t2Levels: summarizeLevels(t2Levels) });
      } catch (e) {
        results.push({ t1: p.t1, t2: pairs[i].t2, divergences: [], error: e.message });
      }
    }
    return { statusCode: 200, headers: H, body: JSON.stringify({ t1: p.t1, results: results }) };
  }

  return { statusCode: 400, headers: H, body: JSON.stringify({ error: 't2 or partners required' }) };
};


/* ═══════════════════════  MAIN PAIR ANALYSIS  ════════════════════════ */

async function analyzePair(t1, t2, corr) {
  var d1 = await fetchTickerData(t1);
  var d2 = await fetchTickerData(t2);
  if (!d1) throw new Error('no data for ' + t1);
  if (!d2) throw new Error('no data for ' + t2);

  var l1 = buildAllLevels(d1);
  var l2 = buildAllLevels(d2);
  var divs = detectDivergences(t1, t2, l1, l2, d1, d2);

  return {
    t1: t1, t2: t2, correlation: corr,
    divergences: divs,
    t1Levels: summarizeLevels(l1),
    t2Levels: summarizeLevels(l2)
  };
}


/* ═══════════════════════  FETCH & BUILD DATA  ═══════════════════════ */

async function fetchTickerData(ticker) {
  var sym = toYahooSymbol(ticker);
  try {
    var raw = await Promise.all([
      getCachedOrFetch(sym, '1wk', '10y'),
      getCachedOrFetch(sym, '1d', '5y')
    ]);
    var wk = raw[0], dy = raw[1];
    if (dy.length < 60) return null; // need at least ~3 months of daily data
    return { ticker: ticker, weekly: wk, daily: dy };
  } catch (e) {
    return null;
  }
}

function toYahooSymbol(ticker) {
  if (ticker.includes('.')) return ticker; // already has suffix (.AX, .L etc)
  // Check if it looks like an ASX ticker (2-3 uppercase letters)
  // Non-ASX partners from the spreadsheet don't have .AX suffix
  // Try as US ticker first (no suffix needed for Yahoo)
  return ticker;
}

function buildAllLevels(data) {
  var dy = data.daily;
  var wk = data.weekly;

  // Build candle arrays for each timeframe from daily/weekly data
  var candles = {
    '2W':  buildNCandles(wk, 2),
    '1M':  grpCalendar(dy, function (c) { return c.date.slice(0, 7); }),
    '2M':  grpCalendar(dy, function (c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + '-' + (Math.ceil(m / 2)); }),
    '3M':  grpCalendar(dy, function (c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + '-Q' + Math.ceil(m / 3); }),
    '6M':  grpCalendar(dy, function (c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + (m <= 6 ? '-H1' : '-H2'); }),
    '9M':  grpCalendar(dy, function (c) { var m = +c.date.slice(5, 7); return c.date.slice(0, 4) + (m <= 9 ? '-P1' : '-P2'); }),
    '12M': grpCalendar(dy, function (c) { return c.date.slice(0, 4); })
  };

  // For each timeframe, find relevant highs and lows
  var levels = {};
  var TFS = ['2W', '1M', '2M', '3M', '6M', '9M', '12M'];
  // Pivot sizes per TF — bigger TF needs fewer bars
  var PIVOTS  = { '2W': 3, '1M': 2, '2M': 2, '3M': 2, '6M': 1, '9M': 1, '12M': 1 };
  // Spacing filter: % price proximity to cluster swing points
  var SPACING = { '2W': 0.04, '1M': 0.05, '2M': 0.06, '3M': 0.07, '6M': 0.08, '9M': 0.09, '12M': 0.10 };

  for (var ti = 0; ti < TFS.length; ti++) {
    var tf = TFS[ti];
    var arr = candles[tf];
    if (!arr || arr.length < 5) { levels[tf] = { highs: [], lows: [] }; continue; }

    var piv = PIVOTS[tf];
    var rawHighs = findSwings(arr, 'high', piv);
    var rawLows  = findSwings(arr, 'low', piv);

    // Apply spacing filter — cluster nearby swings, keep only the extreme
    var relHighs = spacingFilter(rawHighs, 'high', SPACING[tf]);
    var relLows  = spacingFilter(rawLows,  'low',  SPACING[tf]);

    // Tag recent vs historical
    var now = Date.now();
    var twoYearsAgo = now - (2 * 365.25 * 24 * 60 * 60 * 1000);

    relHighs.forEach(function (h) { h.historical = h.t < twoYearsAgo; });
    relLows.forEach(function (l)  { l.historical = l.t < twoYearsAgo; });

    levels[tf] = { highs: relHighs, lows: relLows, candles: arr };
  }

  // Also store latest price for divergence checks
  levels._lastPrice = dy.length > 0 ? dy[dy.length - 1].c : 0;
  levels._lastDate  = dy.length > 0 ? dy[dy.length - 1].date : '';

  return levels;
}


/* ═══════════════════════  SWING DETECTION  ══════════════════════════ */

function findSwings(candles, type, pivot) {
  var swings = [];
  var isHigh = type === 'high';

  for (var i = pivot; i < candles.length - pivot; i++) {
    var ok = true;
    for (var j = 1; j <= pivot; j++) {
      if (isHigh) {
        if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) { ok = false; break; }
      } else {
        if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) { ok = false; break; }
      }
    }
    if (ok) {
      swings.push({
        t: candles[i].t,
        date: candles[i].date,
        level: isHigh ? candles[i].h : candles[i].l,
        idx: i
      });
    }
  }
  return swings;
}


/* ═══════════════════════  SPACING FILTER  ═══════════════════════════ */
/*  Clusters nearby swing points by price proximity.
    If two swing highs are within X% of each other → keep only the highest.
    If two swing lows  are within X% of each other → keep only the lowest.
    This filters out "failure swings" that are too close to be independently relevant. */

function spacingFilter(swings, type, threshold) {
  if (swings.length <= 1) return swings;

  var isHigh = type === 'high';
  // Sort by level (ascending for lows, descending for highs)
  var sorted = swings.slice().sort(function (a, b) {
    return isHigh ? b.level - a.level : a.level - b.level;
  });

  var kept = [];
  var used = {};

  for (var i = 0; i < sorted.length; i++) {
    if (used[i]) continue;

    var anchor = sorted[i];
    // Mark all swings within threshold% of this anchor as clustered
    for (var j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      var dist = Math.abs(anchor.level - sorted[j].level) / Math.max(anchor.level, 0.001);
      if (dist <= threshold) {
        used[j] = true; // filtered out — too close to the anchor (which is the extreme)
      }
    }

    kept.push(anchor);
  }

  // Sort back by time
  kept.sort(function (a, b) { return a.t - b.t; });
  return kept;
}


/* ═══════════════════════  DIVERGENCE DETECTION  ════════════════════= */
/*  Bullish: t1 sweeps a relevant low, t2 holds above its equivalent low
    Bearish: t1 sweeps a relevant high, t2 fails to break its equivalent high
    Check both directions (t1 sweeps / t2 holds AND t2 sweeps / t1 holds) */

function detectDivergences(t1Name, t2Name, l1, l2, d1, d2) {
  var divergences = [];
  var TFS = ['2W', '1M', '2M', '3M', '6M', '9M', '12M'];

  // Current prices
  var price1 = l1._lastPrice;
  var price2 = l2._lastPrice;
  if (!price1 || !price2) return divergences;

  for (var ti = 0; ti < TFS.length; ti++) {
    var tf = TFS[ti];
    if (!l1[tf] || !l2[tf]) continue;

    // ── Check BULLISH SMT: one sweeps low, other holds ──
    checkSweepDivergence(divergences, t1Name, t2Name, l1[tf], l2[tf], price1, price2, tf, 'BULLISH', d1, d2);
    checkSweepDivergence(divergences, t2Name, t1Name, l2[tf], l1[tf], price2, price1, tf, 'BULLISH', d2, d1);

    // ── Check BEARISH SMT: one sweeps high, other fails ──
    checkSweepDivergence(divergences, t1Name, t2Name, l1[tf], l2[tf], price1, price2, tf, 'BEARISH', d1, d2);
    checkSweepDivergence(divergences, t2Name, t1Name, l2[tf], l1[tf], price2, price1, tf, 'BEARISH', d2, d1);
  }

  // Deduplicate — same TF + same direction, keep the most recent
  var seen = {};
  var unique = [];
  for (var di = 0; di < divergences.length; di++) {
    var key = divergences[di].tf + '_' + divergences[di].direction + '_' + divergences[di].sweeper;
    if (!seen[key]) {
      seen[key] = true;
      unique.push(divergences[di]);
    }
  }

  // Sort by TF importance (12M first) then by recency
  var tfOrder = { '12M': 7, '9M': 6, '6M': 5, '3M': 4, '2M': 3, '1M': 2, '2W': 1 };
  unique.sort(function (a, b) { return (tfOrder[b.tf] || 0) - (tfOrder[a.tf] || 0); });

  return unique;
}

function checkSweepDivergence(results, sweeper, holder, sweeperLevels, holderLevels, sweeperPrice, holderPrice, tf, direction, sweeperData, holderData) {
  var isBullish = direction === 'BULLISH';

  // Get relevant levels to check
  var sweeperTargets = isBullish ? sweeperLevels.lows : sweeperLevels.highs;
  var holderTargets  = isBullish ? holderLevels.lows  : holderLevels.highs;

  if (!sweeperTargets.length || !holderTargets.length) return;

  var candles = sweeperLevels.candles;
  if (!candles || candles.length < 3) return;

  // Check each relevant level on sweeper's chart
  for (var si = 0; si < sweeperTargets.length; si++) {
    var sLevel = sweeperTargets[si];

    // Was this level swept recently? Check last 3 candles on this TF
    var swept = false;
    var sweepDate = null;
    var sweepCandle = null;
    var lookback = Math.min(3, candles.length);

    for (var ci = candles.length - lookback; ci < candles.length; ci++) {
      if (isBullish) {
        // Bullish: price wicked below the relevant low
        if (candles[ci].l < sLevel.level) {
          swept = true;
          sweepDate = candles[ci].date;
          sweepCandle = candles[ci];
          break;
        }
      } else {
        // Bearish: price wicked above the relevant high
        if (candles[ci].h > sLevel.level) {
          swept = true;
          sweepDate = candles[ci].date;
          sweepCandle = candles[ci];
          break;
        }
      }
    }

    if (!swept) continue;

    // Now check if holder's equivalent level was NOT swept (it held)
    // Find the most comparable level on the holder's chart
    var holderHeld = false;
    var holderLevel = null;

    // Find the holder's most recent relevant level of the same type
    // (closest in time to the sweeper's level, or most recent)
    var bestHolder = null;
    for (var hi = holderTargets.length - 1; hi >= 0; hi--) {
      bestHolder = holderTargets[hi];
      break; // take most recent
    }

    if (!bestHolder) continue;

    var holderCandles = holderLevels.candles;
    if (!holderCandles || holderCandles.length < 3) continue;

    // Check if holder held its level in the same period
    var holderSwept = false;
    for (var hci = holderCandles.length - lookback; hci < holderCandles.length; hci++) {
      if (isBullish) {
        if (holderCandles[hci].l < bestHolder.level) { holderSwept = true; break; }
      } else {
        if (holderCandles[hci].h > bestHolder.level) { holderSwept = true; break; }
      }
    }

    // DIVERGENCE: sweeper swept, holder held
    if (!holderSwept) {
      // Calculate how deep the sweep was
      var sweepDepth = isBullish
        ? r4((sLevel.level - sweepCandle.l) / sLevel.level * 100)
        : r4((sweepCandle.h - sLevel.level) / sLevel.level * 100);

      // Calculate holder's distance from its level (margin of safety)
      var lastHolderCandle = holderCandles[holderCandles.length - 1];
      var holderMargin = isBullish
        ? r4((lastHolderCandle.l - bestHolder.level) / bestHolder.level * 100)
        : r4((bestHolder.level - lastHolderCandle.h) / bestHolder.level * 100);

      // Age: how many TF candles ago was the sweep
      var sweepAge = 0;
      for (var ai = candles.length - 1; ai >= 0; ai--) {
        if (candles[ai].date === sweepDate) { sweepAge = candles.length - 1 - ai; break; }
      }

      results.push({
        direction: direction,
        tf: tf,
        sweeper: sweeper,
        holder: holder,
        sweeperLevel: r4(sLevel.level),
        holderLevel: r4(bestHolder.level),
        sweepDate: sweepDate,
        sweepDepth: sweepDepth,
        holderMargin: holderMargin,
        sweepAge: sweepAge,
        historical: sLevel.historical,
        description: sweeper + ' swept ' + tf + ' ' + (isBullish ? 'low' : 'high') + ' at ' + r4(sLevel.level) + ', ' + holder + ' held ' + (isBullish ? 'above' : 'below') + ' ' + r4(bestHolder.level)
      });
    }
  }
}


/* ═══════════════════════  CANDLE BUILDING  ══════════════════════════ */

function buildNCandles(candles, n) {
  var out = [];
  for (var i = 0; i < candles.length; i += n) {
    var chunk = candles.slice(i, i + n);
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

function grpCalendar(arr, keyFn) {
  var g = {}, ord = [];
  for (var i = 0; i < arr.length; i++) {
    var k = keyFn(arr[i]);
    if (!g[k]) {
      g[k] = { t: arr[i].t, date: arr[i].date, o: arr[i].o, h: arr[i].h, l: arr[i].l, c: arr[i].c };
      ord.push(k);
    } else {
      if (arr[i].h > g[k].h) g[k].h = arr[i].h;
      if (arr[i].l < g[k].l) g[k].l = arr[i].l;
      g[k].c = arr[i].c;
    }
  }
  return ord.map(function (k) { return g[k]; });
}

function summarizeLevels(levels) {
  var summary = {};
  var TFS = ['2W', '1M', '2M', '3M', '6M', '9M', '12M'];
  for (var i = 0; i < TFS.length; i++) {
    var tf = TFS[i];
    if (!levels[tf]) continue;
    summary[tf] = {
      relevantHighs: levels[tf].highs.map(function (h) { return { level: r4(h.level), date: h.date, historical: h.historical }; }),
      relevantLows:  levels[tf].lows.map(function (l)  { return { level: r4(l.level), date: l.date, historical: l.historical }; })
    };
  }
  return summary;
}


/* ═══════════════════════  DATA FETCHING  ════════════════════════════ */

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
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
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

function r4(v) { return v != null ? +(+v).toFixed(4) : null; }
