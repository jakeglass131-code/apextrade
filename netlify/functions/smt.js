// SMT (Smart Money Technique) Divergence Scanner
// Fetches candle data for pairs, computes correlation, detects divergences

var dataCache = {};
var CACHE_TTL = 3600000; // 1 hour

exports.handler = async function(event) {
  var H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  var params = event.queryStringParameters || {};
  var action = params.action || 'correlate';

  try {
    if (action === 'correlate') {
      // ?action=correlate&t1=CBA&t2=WBC
      if (!params.t1 || !params.t2) throw new Error('t1 and t2 required');
      var result = await computeCorrelation(params.t1, params.t2);
      return { statusCode: 200, headers: H, body: JSON.stringify(result) };
    }

    if (action === 'batch') {
      // ?action=batch&ticker=CBA&candidates=WBC,NAB,ANZ,BEN,BOQ
      if (!params.ticker || !params.candidates) throw new Error('ticker and candidates required');
      var candidates = params.candidates.split(',').map(function(t) { return t.trim(); }).filter(Boolean).slice(0, 15);
      var results = [];
      var baseData = await fetchCandles(params.ticker);
      if (!baseData || baseData.length < 60) throw new Error('insufficient data for ' + params.ticker);
      for (var i = 0; i < candidates.length; i++) {
        try {
          var candData = await fetchCandles(candidates[i]);
          if (!candData || candData.length < 60) continue;
          var corr = computeCorrelationFromData(params.ticker, baseData, candidates[i], candData);
          if (corr) results.push(corr);
        } catch (e) { /* skip */ }
      }
      return { statusCode: 200, headers: H, body: JSON.stringify({ ticker: params.ticker, pairs: results }) };
    }

    if (action === 'divergence') {
      // ?action=divergence&t1=CBA&t2=WBC&lookback=20
      if (!params.t1 || !params.t2) throw new Error('t1 and t2 required');
      var lookback = parseInt(params.lookback) || 20;
      var div = await detectDivergence(params.t1, params.t2, lookback);
      return { statusCode: 200, headers: H, body: JSON.stringify(div) };
    }

    if (action === 'full') {
      // ?action=full&t1=CBA&t2=WBC — correlation + divergence in one call
      if (!params.t1 || !params.t2) throw new Error('t1 and t2 required');
      var d1 = await fetchCandles(params.t1);
      var d2 = await fetchCandles(params.t2);
      if (!d1 || !d2 || d1.length < 60 || d2.length < 60) throw new Error('insufficient data');
      var corr = computeCorrelationFromData(params.t1, d1, params.t2, d2);
      var div = detectDivergenceFromData(params.t1, d1, params.t2, d2, 30);
      return { statusCode: 200, headers: H, body: JSON.stringify(Object.assign({}, corr, { divergences: div.divergences, activeDivergence: div.activeDivergence })) };
    }

    throw new Error('Unknown action: ' + action);
  } catch (err) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Fetch candles from Yahoo Finance ──
async function fetchCandles(ticker) {
  var key = ticker + '_1d_2y';
  if (dataCache[key] && Date.now() - dataCache[key].ts < CACHE_TTL) return dataCache[key].data;

  var sym = ticker.includes('.') ? ticker : ticker + '.AX';
  try {
    var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=2y', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error('Yahoo ' + r.status);
    var d = await r.json();
    var res = d.chart && d.chart.result && d.chart.result[0];
    if (!res) throw new Error('no data');
    var ts = res.timestamp || [];
    var q = res.indicators && res.indicators.quote && res.indicators.quote[0] || {};
    var candles = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close && q.close[i] != null && q.open && q.open[i] != null) {
        candles.push({
          t: ts[i] * 1000,
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
          v: q.volume && q.volume[i] || 0
        });
      }
    }
    dataCache[key] = { data: candles, ts: Date.now() };
    return candles;
  } catch (e) {
    return null;
  }
}

// ── Compute correlation between two price series ──
async function computeCorrelation(t1, t2) {
  var d1 = await fetchCandles(t1);
  var d2 = await fetchCandles(t2);
  if (!d1 || !d2 || d1.length < 60 || d2.length < 60) throw new Error('insufficient data');
  return computeCorrelationFromData(t1, d1, t2, d2);
}

function computeCorrelationFromData(t1, d1, t2, d2) {
  // Align by date
  var map1 = {}, map2 = {};
  d1.forEach(function(c) { map1[c.date] = c; });
  d2.forEach(function(c) { map2[c.date] = c; });
  var dates = Object.keys(map1).filter(function(d) { return map2[d]; }).sort();
  if (dates.length < 60) return null;

  // Use last 250 days (1 year of trading)
  var useDates = dates.slice(-250);
  var p1 = useDates.map(function(d) { return map1[d].c; });
  var p2 = useDates.map(function(d) { return map2[d].c; });

  // Pearson correlation on returns
  var r1 = [], r2 = [];
  for (var i = 1; i < p1.length; i++) {
    r1.push((p1[i] - p1[i-1]) / p1[i-1]);
    r2.push((p2[i] - p2[i-1]) / p2[i-1]);
  }
  var pearson = correlationCoeff(r1, r2);

  // Spearman rank correlation
  var spearman = spearmanCorrelation(r1, r2);

  // Rolling 60-bar correlation average
  var rollingAvg = rollingCorrelation(r1, r2, 60);

  // R-squared on normalised price shapes
  var n1 = normalise(p1);
  var n2 = normalise(p2);
  var rSquared = Math.pow(correlationCoeff(n1, n2), 2);

  // ATR ratio
  var atr1 = computeATR(d1.slice(-60));
  var atr2 = computeATR(d2.slice(-60));
  var atrRatio = Math.max(atr1, atr2) / Math.min(atr1, atr2);

  // Trend alignment (slope of last 60 days)
  var slope1 = linearSlope(p1.slice(-60));
  var slope2 = linearSlope(p2.slice(-60));
  var trendAligned = (slope1 > 0 && slope2 > 0) || (slope1 < 0 && slope2 < 0);

  // Overall pass/fail
  var isValid = pearson >= 0.70 && spearman >= 0.65 && rollingAvg >= 0.60 && rSquared >= 0.50 && atrRatio <= 4.0;

  // Quality grade
  var score = 0;
  if (pearson >= 0.90) score += 3; else if (pearson >= 0.80) score += 2; else if (pearson >= 0.70) score += 1;
  if (spearman >= 0.85) score += 2; else if (spearman >= 0.75) score += 1;
  if (rollingAvg >= 0.80) score += 2; else if (rollingAvg >= 0.70) score += 1;
  if (rSquared >= 0.80) score += 2; else if (rSquared >= 0.65) score += 1;
  if (trendAligned) score += 1;
  var grade = score >= 9 ? 'A+' : score >= 7 ? 'A' : score >= 5 ? 'B' : score >= 3 ? 'C' : 'D';

  return {
    t1: t1, t2: t2,
    pearson: +pearson.toFixed(4),
    spearman: +spearman.toFixed(4),
    rollingAvg: +rollingAvg.toFixed(4),
    rSquared: +rSquared.toFixed(4),
    atrRatio: +atrRatio.toFixed(2),
    trendAligned: trendAligned,
    slope1: +slope1.toFixed(6), slope2: +slope2.toFixed(6),
    isValid: isValid,
    grade: grade, score: score,
    dataPoints: useDates.length,
    lastPrice1: p1[p1.length - 1],
    lastPrice2: p2[p2.length - 1]
  };
}

// ── Detect SMT Divergence ──
async function detectDivergence(t1, t2, lookback) {
  var d1 = await fetchCandles(t1);
  var d2 = await fetchCandles(t2);
  if (!d1 || !d2 || d1.length < 60 || d2.length < 60) throw new Error('insufficient data');
  return detectDivergenceFromData(t1, d1, t2, d2, lookback);
}

function detectDivergenceFromData(t1, d1, t2, d2, lookback) {
  // Align by date
  var map1 = {}, map2 = {};
  d1.forEach(function(c) { map1[c.date] = c; });
  d2.forEach(function(c) { map2[c.date] = c; });
  var dates = Object.keys(map1).filter(function(d) { return map2[d]; }).sort();
  if (dates.length < lookback + 10) return { divergences: [], activeDivergence: null };

  var recent = dates.slice(-(lookback + 10));
  var c1 = recent.map(function(d) { return map1[d]; });
  var c2 = recent.map(function(d) { return map2[d]; });

  // Find swing highs and lows (3-bar pivot)
  var sh1 = findSwingHighs(c1, 3);
  var sl1 = findSwingLows(c1, 3);
  var sh2 = findSwingHighs(c2, 3);
  var sl2 = findSwingLows(c2, 3);

  var divergences = [];

  // Bearish SMT: t1 makes higher high but t2 makes lower high
  if (sh1.length >= 2 && sh2.length >= 2) {
    var lastSH1 = sh1[sh1.length - 1], prevSH1 = sh1[sh1.length - 2];
    var lastSH2 = sh2[sh2.length - 1], prevSH2 = sh2[sh2.length - 2];
    if (lastSH1.h > prevSH1.h && lastSH2.h < prevSH2.h) {
      divergences.push({
        type: 'BEARISH',
        description: t1 + ' higher high, ' + t2 + ' lower high',
        t1High: lastSH1.h, t1PrevHigh: prevSH1.h,
        t2High: lastSH2.h, t2PrevHigh: prevSH2.h,
        date: lastSH1.date,
        age: dates.length - dates.indexOf(lastSH1.date) - 1
      });
    }
    // Also check reverse
    if (lastSH2.h > prevSH2.h && lastSH1.h < prevSH1.h) {
      divergences.push({
        type: 'BEARISH',
        description: t2 + ' higher high, ' + t1 + ' lower high',
        t1High: lastSH1.h, t1PrevHigh: prevSH1.h,
        t2High: lastSH2.h, t2PrevHigh: prevSH2.h,
        date: lastSH2.date,
        age: dates.length - dates.indexOf(lastSH2.date) - 1
      });
    }
  }

  // Bullish SMT: t1 makes lower low but t2 makes higher low
  if (sl1.length >= 2 && sl2.length >= 2) {
    var lastSL1 = sl1[sl1.length - 1], prevSL1 = sl1[sl1.length - 2];
    var lastSL2 = sl2[sl2.length - 1], prevSL2 = sl2[sl2.length - 2];
    if (lastSL1.l < prevSL1.l && lastSL2.l > prevSL2.l) {
      divergences.push({
        type: 'BULLISH',
        description: t1 + ' lower low, ' + t2 + ' higher low',
        t1Low: lastSL1.l, t1PrevLow: prevSL1.l,
        t2Low: lastSL2.l, t2PrevLow: prevSL2.l,
        date: lastSL1.date,
        age: dates.length - dates.indexOf(lastSL1.date) - 1
      });
    }
    if (lastSL2.l < prevSL2.l && lastSL1.l > prevSL1.l) {
      divergences.push({
        type: 'BULLISH',
        description: t2 + ' lower low, ' + t1 + ' higher low',
        t1Low: lastSL1.l, t1PrevLow: prevSL1.l,
        t2Low: lastSL2.l, t2PrevLow: prevSL2.l,
        date: lastSL2.date,
        age: dates.length - dates.indexOf(lastSL2.date) - 1
      });
    }
  }

  // Active divergence = most recent one within last 5 bars
  var active = divergences.filter(function(d) { return d.age <= 5; });

  return {
    t1: t1, t2: t2,
    swingHighs1: sh1.length, swingLows1: sl1.length,
    swingHighs2: sh2.length, swingLows2: sl2.length,
    divergences: divergences,
    activeDivergence: active.length > 0 ? active[0] : null
  };
}

// ── Helper functions ──
function findSwingHighs(candles, strength) {
  var highs = [];
  for (var i = strength; i < candles.length - strength; i++) {
    var isHigh = true;
    for (var j = 1; j <= strength; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) {
        isHigh = false; break;
      }
    }
    if (isHigh) highs.push(candles[i]);
  }
  return highs;
}

function findSwingLows(candles, strength) {
  var lows = [];
  for (var i = strength; i < candles.length - strength; i++) {
    var isLow = true;
    for (var j = 1; j <= strength; j++) {
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) {
        isLow = false; break;
      }
    }
    if (isLow) lows.push(candles[i]);
  }
  return lows;
}

function correlationCoeff(x, y) {
  var n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  var sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (var i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxy += x[i] * y[i];
    sx2 += x[i] * x[i];
    sy2 += y[i] * y[i];
  }
  var num = n * sxy - sx * sy;
  var den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

function spearmanCorrelation(x, y) {
  var n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  function rank(arr) {
    var sorted = arr.slice().map(function(v, i) { return { v: v, i: i }; }).sort(function(a, b) { return a.v - b.v; });
    var ranks = new Array(arr.length);
    for (var i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  }
  var rx = rank(x.slice(0, n));
  var ry = rank(y.slice(0, n));
  return correlationCoeff(rx, ry);
}

function rollingCorrelation(x, y, window) {
  var n = Math.min(x.length, y.length);
  if (n < window) return correlationCoeff(x, y);
  var sum = 0, count = 0;
  for (var i = 0; i <= n - window; i += Math.max(1, Math.floor(window / 4))) {
    var c = correlationCoeff(x.slice(i, i + window), y.slice(i, i + window));
    sum += c; count++;
  }
  return count > 0 ? sum / count : 0;
}

function normalise(arr) {
  var min = Infinity, max = -Infinity;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  var range = max - min || 1;
  return arr.map(function(v) { return (v - min) / range; });
}

function computeATR(candles) {
  if (candles.length < 2) return 0;
  var sum = 0;
  for (var i = 1; i < candles.length; i++) {
    var tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    sum += tr;
  }
  return sum / (candles.length - 1);
}

function linearSlope(arr) {
  var n = arr.length;
  if (n < 2) return 0;
  var sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (var i = 0; i < n; i++) {
    sx += i; sy += arr[i];
    sxy += i * arr[i]; sx2 += i * i;
  }
  return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
}
