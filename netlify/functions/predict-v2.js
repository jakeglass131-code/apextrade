// ═══════════════════════════════════════════════════════════════════════════
// APEXtrade Prediction Engine v2 — Multi-Factor Quantitative Model
// ═══════════════════════════════════════════════════════════════════════════
// Factors: overnight futures (scaled), 15+ technical indicators, intermarket
// correlations (VIX, gold, oil, DXY, bonds, iron ore, AUD/USD, BTC),
// calendar/seasonal patterns, mean reversion, momentum, historical pattern
// matching, news sentiment, volume analysis, consecutive-day patterns.
//
// Backtested against 2 years of ASX 200 daily data on each request (cached).
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=120',
};

// ── In-memory cache (survives warm Lambda for ~5-15 min) ─────────────────
let _cache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 min for live data
const HIST_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours for historical (doesn't change intraday)

// ── Yahoo Finance fetch helper ───────────────────────────────────────────
async function yahooChart(symbol, range = '2y', interval = '1d') {
  const key = `yf_${symbol}_${range}_${interval}`;
  const ttl = range === '1d' ? CACHE_TTL : HIST_CACHE_TTL;
  if (_cache[key] && Date.now() - _cache[key].ts < ttl) return _cache[key].data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexTrade/2.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const d = await r.json();
  const res = d.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);

  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const candles = ts.map((t, i) => ({
    t: t * 1000,
    o: q.open?.[i],
    h: q.high?.[i],
    l: q.low?.[i],
    c: adj?.[i] ?? q.close?.[i],
    v: q.volume?.[i] || 0,
  })).filter(c => c.o != null && c.c != null);

  _cache[key] = { data: candles, ts: Date.now() };
  return candles;
}

// Safe fetch — returns null on failure instead of crashing
async function safeYahoo(symbol, range, interval) {
  try { return await yahooChart(symbol, range, interval); }
  catch (e) { console.warn(`[predict-v2] ${symbol}: ${e.message}`); return null; }
}

// ── Technical Indicator Calculations ─────────────────────────────────────
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12 == null || ema26 == null) return null;
  const line = ema12 - ema26;

  // Signal line: EMA(9) of MACD values
  const macdVals = [];
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 12; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    if (i >= 26) {
      e26 = closes[i] * k26 + e26 * (1 - k26);
      macdVals.push(e12 - e26);
    }
  }
  if (macdVals.length < 9) return { line, signal: 0, hist: line };
  const kSig = 2 / 10;
  let sig = macdVals.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdVals.length; i++) {
    sig = macdVals[i] * kSig + sig * (1 - kSig);
  }
  return { line, signal: sig, hist: line - sig };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

function calcBollingerBands(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std, width: (4 * std) / mean };
}

function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (candles.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = candles.length - kPeriod - dPeriod + 1; i <= candles.length - 1; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...window.map(c => c.h));
    const low = Math.min(...window.map(c => c.l));
    const k = high === low ? 50 : ((candles[i].c - low) / (high - low)) * 100;
    kValues.push(k);
  }
  const dValue = kValues.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  return { k: kValues[kValues.length - 1], d: dValue };
}

function calcOBV(candles) {
  if (candles.length < 20) return null;
  let obv = 0;
  const obvArr = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > candles[i - 1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i - 1].c) obv -= candles[i].v;
    obvArr.push(obv);
  }
  // Return slope of last 10 OBV values (normalized)
  if (obvArr.length < 10) return 0;
  const recent = obvArr.slice(-10);
  const first = recent[0], last = recent[recent.length - 1];
  const avgVol = candles.slice(-20).reduce((a, c) => a + c.v, 0) / 20;
  return avgVol > 0 ? (last - first) / (avgVol * 10) : 0;
}

function calcVWAP(candles, period = 20) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  let cumPV = 0, cumV = 0;
  for (const c of recent) {
    const tp = (c.h + c.l + c.c) / 3;
    cumPV += tp * c.v;
    cumV += c.v;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

// ── Factor Scoring Functions ─────────────────────────────────────────────
// Each returns a score in a defined range. Positive = bullish, negative = bearish.

function scoreFuturesOvernight(nqPct, esPct, ymPct) {
  // Scaled score: proportional to move size, capped at ±3
  // ASX historically follows US futures ~65% of the time
  const avg = ((nqPct || 0) * 0.4 + (esPct || 0) * 0.4 + (ymPct || 0) * 0.2);
  // Non-linear: big moves matter more
  const scaled = avg * 1.5;
  return { score: Math.max(-3, Math.min(3, scaled)), detail: `NQ ${nqPct?.toFixed(2)}% ES ${esPct?.toFixed(2)}% YM ${ymPct?.toFixed(2)}%` };
}

function scoreRSI(rsi) {
  if (rsi == null) return { score: 0, detail: 'No RSI data' };
  // Curve: extreme readings are stronger signals
  // RSI > 70: overbought → bearish mean reversion likely
  // RSI < 30: oversold → bullish mean reversion likely
  // RSI 45-55: neutral
  let score;
  if (rsi > 80) score = -2;
  else if (rsi > 70) score = -1.5 + (80 - rsi) * 0.05;
  else if (rsi > 60) score = -0.5 + (70 - rsi) * 0.05;
  else if (rsi > 55) score = 0.25;
  else if (rsi > 45) score = 0;
  else if (rsi > 40) score = -0.25;
  else if (rsi > 30) score = 0.5 + (40 - rsi) * 0.05;
  else if (rsi > 20) score = 1.5 + (30 - rsi) * 0.05;
  else score = 2;
  return { score, detail: `RSI ${rsi.toFixed(1)}` };
}

function scoreMACD(macd) {
  if (!macd) return { score: 0, detail: 'No MACD data' };
  // Histogram direction and magnitude
  let score = 0;
  if (macd.hist > 0) score += 0.5;
  else score -= 0.5;
  // Signal line crossover is stronger
  if (macd.line > macd.signal && macd.hist > 0) score += 0.3;
  if (macd.line < macd.signal && macd.hist < 0) score -= 0.3;
  return { score: Math.max(-1, Math.min(1, score)), detail: `MACD hist ${macd.hist.toFixed(2)}` };
}

function scoreEMAAlignment(closes) {
  if (closes.length < 200) return { score: 0, detail: 'Insufficient data' };
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  if (!ema8 || !ema21 || !ema50 || !ema200) return { score: 0, detail: 'EMA calc failed' };

  let score = 0;
  // Perfect bull alignment: 8 > 21 > 50 > 200
  if (ema8 > ema21 && ema21 > ema50 && ema50 > ema200) score = 1;
  // Perfect bear alignment: 8 < 21 < 50 < 200
  else if (ema8 < ema21 && ema21 < ema50 && ema50 < ema200) score = -1;
  // Partial alignment
  else {
    if (ema8 > ema21) score += 0.25; else score -= 0.25;
    if (ema21 > ema50) score += 0.25; else score -= 0.25;
    if (ema50 > ema200) score += 0.25; else score -= 0.25;
  }

  // Price relative to 200 EMA (trend health)
  const price = closes[closes.length - 1];
  const distFrom200 = ((price - ema200) / ema200) * 100;
  if (distFrom200 > 5) score += 0.15;
  if (distFrom200 < -5) score -= 0.15;

  const align = score > 0.5 ? 'BULLISH' : score < -0.5 ? 'BEARISH' : 'MIXED';
  return { score, detail: `EMAs ${align} (8/21/50/200)` };
}

function scoreBollinger(closes) {
  const bb = calcBollingerBands(closes);
  if (!bb) return { score: 0, detail: 'No BB data' };
  const price = closes[closes.length - 1];
  const pctB = (price - bb.lower) / (bb.upper - bb.lower);

  let score = 0;
  // Price near upper band: overbought, likely pullback
  if (pctB > 0.95) score = -1;
  else if (pctB > 0.8) score = -0.5;
  // Price near lower band: oversold, likely bounce
  else if (pctB < 0.05) score = 1;
  else if (pctB < 0.2) score = 0.5;
  // Narrow bands (squeeze): big move coming but direction uncertain
  // Wide bands: trend continuation more likely

  return { score, detail: `BB %B=${(pctB * 100).toFixed(0)}% Width=${(bb.width * 100).toFixed(1)}%` };
}

function scoreStochastic(candles) {
  const stoch = calcStochastic(candles);
  if (!stoch) return { score: 0, detail: 'No Stochastic data' };

  let score = 0;
  // Overbought > 80, oversold < 20
  if (stoch.k > 80 && stoch.d > 80) score = -0.8;
  else if (stoch.k > 80) score = -0.4;
  else if (stoch.k < 20 && stoch.d < 20) score = 0.8;
  else if (stoch.k < 20) score = 0.4;
  // K crossing above D = bullish, below = bearish
  if (stoch.k > stoch.d && stoch.k < 50) score += 0.3;
  if (stoch.k < stoch.d && stoch.k > 50) score -= 0.3;

  return { score: Math.max(-1, Math.min(1, score)), detail: `Stoch K=${stoch.k.toFixed(0)} D=${stoch.d.toFixed(0)}` };
}

function scoreMeanReversion(candles) {
  if (candles.length < 25) return { score: 0, detail: 'Insufficient data' };
  const closes = candles.map(c => c.c);
  const sma20 = calcSMA(closes, 20);
  if (!sma20) return { score: 0, detail: 'No SMA20' };

  const price = closes[closes.length - 1];
  const deviation = ((price - sma20) / sma20) * 100;

  // Markets tend to revert to the mean — stretched markets snap back
  let score = 0;
  if (deviation > 4) score = -1.5; // Very stretched up → expect pullback
  else if (deviation > 2) score = -0.7;
  else if (deviation > 1) score = -0.3;
  else if (deviation < -4) score = 1.5; // Very stretched down → expect bounce
  else if (deviation < -2) score = 0.7;
  else if (deviation < -1) score = 0.3;

  return { score, detail: `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}% from SMA20` };
}

function scoreConsecutiveDays(candles) {
  if (candles.length < 10) return { score: 0, detail: 'Insufficient data' };
  let consecutive = 0;
  for (let i = candles.length - 1; i > candles.length - 10 && i > 0; i--) {
    const dir = candles[i].c > candles[i - 1].c ? 1 : -1;
    if (consecutive === 0) consecutive = dir;
    else if ((consecutive > 0 && dir > 0) || (consecutive < 0 && dir < 0)) {
      consecutive += dir;
    } else break;
  }

  // After 3+ consecutive days in one direction, mean reversion probability increases
  let score = 0;
  if (consecutive >= 5) score = -1.5; // 5+ up days → likely pullback
  else if (consecutive >= 4) score = -1;
  else if (consecutive >= 3) score = -0.5;
  else if (consecutive <= -5) score = 1.5; // 5+ down days → likely bounce
  else if (consecutive <= -4) score = 1;
  else if (consecutive <= -3) score = 0.5;

  return { score, detail: `${Math.abs(consecutive)} consecutive ${consecutive > 0 ? 'up' : 'down'} days` };
}

function scoreVolume(candles) {
  if (candles.length < 25) return { score: 0, detail: 'No volume data' };
  const avgVol20 = candles.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20;
  const lastVol = candles[candles.length - 1].v;
  if (avgVol20 === 0) return { score: 0, detail: 'No volume' };

  const ratio = lastVol / avgVol20;
  const lastDir = candles[candles.length - 1].c >= candles[candles.length - 2]?.c ? 1 : -1;

  // High volume confirms the direction, low volume suggests weakness
  let score = 0;
  if (ratio > 1.5) score = lastDir * 0.5; // High volume confirms
  else if (ratio > 1.2) score = lastDir * 0.25;
  else if (ratio < 0.6) score = -lastDir * 0.3; // Low volume → trend weakening

  return { score, detail: `Vol ratio ${ratio.toFixed(1)}x avg` };
}

function scoreOBVTrend(candles) {
  const obvSlope = calcOBV(candles);
  if (obvSlope === null || obvSlope === 0) return { score: 0, detail: 'No OBV data' };
  const score = Math.max(-0.5, Math.min(0.5, obvSlope * 5));
  return { score, detail: `OBV slope ${obvSlope > 0 ? '+' : ''}${obvSlope.toFixed(3)}` };
}

function scoreVIX(vixCandles) {
  if (!vixCandles || vixCandles.length < 5) return { score: 0, detail: 'No VIX data', regime: 'unknown' };
  const vix = vixCandles[vixCandles.length - 1].c;
  const prevVix = vixCandles[vixCandles.length - 2]?.c || vix;
  const vixChange = ((vix - prevVix) / prevVix) * 100;

  let score = 0;
  let regime = 'normal';

  // VIX levels
  if (vix > 35) { score = 1; regime = 'extreme fear'; }       // Contrarian bullish
  else if (vix > 25) { score = -0.5; regime = 'high fear'; }  // Bearish momentum
  else if (vix > 20) { score = -0.3; regime = 'elevated'; }
  else if (vix < 13) { score = -0.5; regime = 'complacent'; } // Contrarian bearish (complacency)
  else { regime = 'normal'; }

  // VIX spike (sudden fear) — often marks short-term bottoms
  if (vixChange > 15) score += 0.5; // Panic spike → contrarian buy
  if (vixChange < -10) score -= 0.3; // Sharp drop → might be getting complacent

  return { score: Math.max(-1, Math.min(1.5, score)), detail: `VIX ${vix.toFixed(1)} (${vixChange > 0 ? '+' : ''}${vixChange.toFixed(1)}%)`, regime };
}

function scoreIntermarket(goldChg, oilChg, dxyChg, bondYieldChg, audChg) {
  let score = 0;
  const parts = [];

  // Gold up = risk-off (bearish equities usually)
  if (goldChg != null) {
    if (goldChg > 1) score -= 0.5;
    else if (goldChg > 0.3) score -= 0.2;
    else if (goldChg < -1) score += 0.3;
    parts.push(`Gold ${goldChg > 0 ? '+' : ''}${goldChg.toFixed(2)}%`);
  }

  // Oil: moderate impact — big spike is bearish (inflation), crash is bearish (demand fear)
  if (oilChg != null) {
    if (oilChg > 3) score -= 0.4; // Oil spike = inflation/supply shock
    else if (oilChg < -3) score -= 0.3; // Oil crash = demand destruction
    else if (oilChg > 1) score -= 0.1;
    else if (oilChg < -1) score += 0.1; // Mild oil decline = easing inflation
    parts.push(`Oil ${oilChg > 0 ? '+' : ''}${oilChg.toFixed(2)}%`);
  }

  // DXY (US Dollar): inverse relationship with risk assets
  if (dxyChg != null) {
    if (dxyChg > 0.5) score -= 0.4; // Strong USD = bearish for global/ASX
    else if (dxyChg > 0.2) score -= 0.15;
    else if (dxyChg < -0.5) score += 0.4; // Weak USD = bullish
    else if (dxyChg < -0.2) score += 0.15;
    parts.push(`DXY ${dxyChg > 0 ? '+' : ''}${dxyChg.toFixed(2)}%`);
  }

  // US 10Y yield: rising yields pressure growth stocks
  if (bondYieldChg != null) {
    if (bondYieldChg > 3) score -= 0.5; // Yield spiking
    else if (bondYieldChg > 1) score -= 0.2;
    else if (bondYieldChg < -3) score += 0.4; // Yields dropping = dovish
    else if (bondYieldChg < -1) score += 0.15;
    parts.push(`US10Y yield ${bondYieldChg > 0 ? '+' : ''}${bondYieldChg.toFixed(2)}%`);
  }

  // AUD/USD: strong correlation with ASX (commodity currency)
  if (audChg != null) {
    score += audChg * 0.3; // Direct correlation — AUD up = ASX up
    parts.push(`AUD ${audChg > 0 ? '+' : ''}${audChg.toFixed(2)}%`);
  }

  return { score: Math.max(-2, Math.min(2, score)), detail: parts.join(', ') || 'No intermarket data' };
}

function scoreBTC(btcChg) {
  if (btcChg == null) return { score: 0, detail: 'No BTC data' };
  // BTC as risk sentiment proxy — weaker signal than traditional intermarket
  const score = Math.max(-0.5, Math.min(0.5, btcChg * 0.1));
  return { score, detail: `BTC ${btcChg > 0 ? '+' : ''}${btcChg.toFixed(2)}%` };
}

function scoreCalendar() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...5=Fri
  const month = now.getUTCMonth(); // 0=Jan
  const date = now.getUTCDate();

  let score = 0;
  const parts = [];

  // Day-of-week effects (well-documented anomalies)
  // Monday: historically weakest day (weekend risk digestion)
  // Friday: historically stronger (position squaring, optimism into weekend)
  if (day === 1) { score -= 0.2; parts.push('Monday effect (-0.2)'); }
  if (day === 5) { score += 0.15; parts.push('Friday effect (+0.15)'); }

  // Month effects
  // January effect, Santa rally (Dec), Sell in May
  if (month === 0) { score += 0.2; parts.push('January effect'); }
  if (month === 11 && date >= 15) { score += 0.25; parts.push('Santa rally'); }
  if (month >= 4 && month <= 8) { score -= 0.1; parts.push('Sell-in-May period'); }
  // September historically worst month
  if (month === 8) { score -= 0.2; parts.push('September weakness'); }

  // Options expiry week (3rd Friday): higher volatility, mean reversion
  const firstDay = new Date(now.getFullYear(), month, 1).getDay();
  const thirdFriday = 15 + ((5 - firstDay + 7) % 7);
  if (Math.abs(date - thirdFriday) <= 2) {
    parts.push('Options expiry week');
    // Don't score — just adds uncertainty
  }

  // End of month/quarter: institutional rebalancing
  const daysInMonth = new Date(now.getFullYear(), month + 1, 0).getDate();
  if (date >= daysInMonth - 2) {
    score += 0.15; // Window dressing / rebalancing tends to be bullish
    parts.push('Month-end rebalancing');
  }
  if ((month === 2 || month === 5 || month === 8 || month === 11) && date >= daysInMonth - 3) {
    score += 0.1;
    parts.push('Quarter-end rebalancing');
  }

  return { score, detail: parts.join(', ') || `Day ${day}, Month ${month + 1}` };
}

// ── Historical Pattern Matching ──────────────────────────────────────────
function findSimilarDays(candles, currentConditions) {
  if (candles.length < 100) return { score: 0, detail: 'Insufficient history', matches: [] };

  const { rsi, overnightPct, consecutiveDays } = currentConditions;
  const matches = [];

  for (let i = 30; i < candles.length - 1; i++) {
    // Calculate RSI at this point
    const closes = candles.slice(0, i + 1).map(c => c.c);
    if (closes.length < 15) continue;

    const histRSI = calcRSI(closes);
    if (histRSI == null) continue;

    // Calculate consecutive days at this point
    let consec = 0;
    for (let j = i; j > Math.max(0, i - 8); j--) {
      const dir = candles[j].c > candles[j - 1]?.c ? 1 : -1;
      if (consec === 0) consec = dir;
      else if ((consec > 0 && dir > 0) || (consec < 0 && dir < 0)) consec += dir;
      else break;
    }

    // Check similarity
    const rsiSimilar = rsi != null && Math.abs(histRSI - rsi) < 5;
    const consecSimilar = Math.abs(consec - consecutiveDays) <= 1;

    if (rsiSimilar && consecSimilar) {
      // What happened the next day?
      const nextDayReturn = ((candles[i + 1].c - candles[i].c) / candles[i].c) * 100;
      matches.push({
        date: new Date(candles[i].t).toISOString().slice(0, 10),
        rsi: histRSI,
        consecutive: consec,
        nextDayReturn,
      });
    }
  }

  if (matches.length < 5) return { score: 0, detail: `Only ${matches.length} similar days found`, matches };

  const avgReturn = matches.reduce((a, m) => a + m.nextDayReturn, 0) / matches.length;
  const winRate = matches.filter(m => m.nextDayReturn > 0).length / matches.length;

  // Score based on historical outcome
  const score = Math.max(-1.5, Math.min(1.5, avgReturn * 2));

  return {
    score,
    detail: `${matches.length} similar days: avg ${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(2)}%, win rate ${(winRate * 100).toFixed(0)}%`,
    matches: matches.slice(-10),
    avgReturn,
    winRate,
  };
}

// ── Seasonal Analysis ────────────────────────────────────────────────────
function seasonalAnalysis(candles) {
  if (candles.length < 250) return { score: 0, detail: 'Need 1+ year of data' };

  const now = new Date();
  const targetMonth = now.getMonth();
  const targetDay = now.getDate();

  // Find same calendar week across all years in data
  const nearbyReturns = [];
  for (let i = 1; i < candles.length; i++) {
    const d = new Date(candles[i].t);
    if (d.getMonth() === targetMonth && Math.abs(d.getDate() - targetDay) <= 3) {
      const ret = ((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100;
      nearbyReturns.push(ret);
    }
  }

  if (nearbyReturns.length < 3) return { score: 0, detail: 'Not enough seasonal data' };

  const avg = nearbyReturns.reduce((a, b) => a + b, 0) / nearbyReturns.length;
  const bullPct = nearbyReturns.filter(r => r > 0).length / nearbyReturns.length;

  const score = Math.max(-0.5, Math.min(0.5, avg));
  return {
    score,
    detail: `This week historically: avg ${avg > 0 ? '+' : ''}${avg.toFixed(2)}%, positive ${(bullPct * 100).toFixed(0)}% of years (${nearbyReturns.length} samples)`,
  };
}

// ── Quick Backtest (last 60 trading days) ────────────────────────────────
function quickBacktest(asxCandles, futuresCandles) {
  if (!asxCandles || asxCandles.length < 80) return null;

  let correct = 0, total = 0, totalReturn = 0;
  const results = [];

  for (let i = 60; i < asxCandles.length - 1; i++) {
    const closes = asxCandles.slice(0, i + 1).map(c => c.c);
    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const bb = calcBollingerBands(closes);
    const sma20 = calcSMA(closes, 20);

    if (rsi == null || !macd) continue;

    // Simple multi-factor score for backtest
    let score = 0;
    // RSI
    if (rsi > 70) score -= 1; else if (rsi < 30) score += 1;
    else if (rsi > 60) score -= 0.3; else if (rsi < 40) score += 0.3;
    // MACD
    score += macd.hist > 0 ? 0.5 : -0.5;
    // Bollinger
    if (bb) {
      const pctB = (closes[closes.length - 1] - bb.lower) / (bb.upper - bb.lower);
      if (pctB > 0.9) score -= 0.5; else if (pctB < 0.1) score += 0.5;
    }
    // Mean reversion
    if (sma20) {
      const dev = ((closes[closes.length - 1] - sma20) / sma20) * 100;
      if (dev > 3) score -= 0.5; else if (dev < -3) score += 0.5;
    }
    // Consecutive days
    let consec = 0;
    for (let j = i; j > Math.max(0, i - 8); j--) {
      const dir = asxCandles[j].c > asxCandles[j - 1]?.c ? 1 : -1;
      if (consec === 0) consec = dir;
      else if ((consec > 0 && dir > 0) || (consec < 0 && dir < 0)) consec += dir;
      else break;
    }
    if (Math.abs(consec) >= 3) score -= Math.sign(consec) * 0.5;

    const predicted = score > 0.3 ? 'BULL' : score < -0.3 ? 'BEAR' : 'NEUTRAL';
    const actual = asxCandles[i + 1].c > asxCandles[i].c ? 'BULL' : 'BEAR';
    const actualReturn = ((asxCandles[i + 1].c - asxCandles[i].c) / asxCandles[i].c) * 100;

    if (predicted !== 'NEUTRAL') {
      total++;
      if (predicted === actual) correct++;
      totalReturn += predicted === 'BULL' ? actualReturn : -actualReturn;
      results.push({
        date: new Date(asxCandles[i].t).toISOString().slice(0, 10),
        predicted,
        actual,
        return: actualReturn,
      });
    }
  }

  if (total === 0) return null;

  return {
    accuracy: ((correct / total) * 100).toFixed(1),
    total,
    correct,
    avgReturn: (totalReturn / total).toFixed(3),
    cumulativeReturn: totalReturn.toFixed(2),
    recentResults: results.slice(-20),
  };
}

// ── Get latest % change from candle array ────────────────────────────────
function latestChange(candles) {
  if (!candles || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return ((last.c - prev.c) / prev.c) * 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    // ── Fetch all data in parallel ─────────────────────────────────────
    const [
      asxHist,     // ASX 200 2-year daily
      xecHist,     // ASX Small Ords proxy
      nqData,      // Nasdaq futures
      esData,      // S&P futures
      ymData,      // Dow futures
      vixData,     // VIX
      goldData,    // Gold
      oilData,     // Crude Oil
      dxyData,     // US Dollar Index
      bondData,    // US 10Y yield
      audData,     // AUD/USD
      btcData,     // Bitcoin
      ironData,    // Iron ore (SGX)
      copperData,  // Copper
    ] = await Promise.all([
      safeYahoo('^AXJO', '2y', '1d'),
      safeYahoo('^AXSO', '2y', '1d'),
      safeYahoo('NQ=F', '5d', '1d'),
      safeYahoo('ES=F', '5d', '1d'),
      safeYahoo('YM=F', '5d', '1d'),
      safeYahoo('^VIX', '6mo', '1d'),
      safeYahoo('GC=F', '5d', '1d'),
      safeYahoo('CL=F', '5d', '1d'),
      safeYahoo('DX-Y.NYB', '5d', '1d'),
      safeYahoo('^TNX', '5d', '1d'),
      safeYahoo('AUDUSD=X', '5d', '1d'),
      safeYahoo('BTC-USD', '5d', '1d'),
      safeYahoo('GWA.AX', '5d', '1d'), // Iron ore proxy — may fail
      safeYahoo('HG=F', '5d', '1d'),
    ]);

    if (!asxHist || asxHist.length < 50) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Insufficient ASX data', factors: [] }) };
    }

    // ── Extract latest values ──────────────────────────────────────────
    const closes = asxHist.map(c => c.c);
    const lastPrice = closes[closes.length - 1];

    const nqChg = latestChange(nqData);
    const esChg = latestChange(esData);
    const ymChg = latestChange(ymData);
    const goldChg = latestChange(goldData);
    const oilChg = latestChange(oilData);
    const dxyChg = latestChange(dxyData);
    const bondChg = latestChange(bondData);
    const audChg = latestChange(audData);
    const btcChg = latestChange(btcData);
    const copperChg = latestChange(copperData);

    // ── Calculate all technical indicators ──────────────────────────────
    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const atr = calcATR(asxHist);
    const stoch = calcStochastic(asxHist);
    const vwap = calcVWAP(asxHist);

    // Consecutive days
    let consecutiveDays = 0;
    for (let i = asxHist.length - 1; i > Math.max(0, asxHist.length - 10); i--) {
      const dir = asxHist[i].c > asxHist[i - 1]?.c ? 1 : -1;
      if (consecutiveDays === 0) consecutiveDays = dir;
      else if ((consecutiveDays > 0 && dir > 0) || (consecutiveDays < 0 && dir < 0)) consecutiveDays += dir;
      else break;
    }

    // ── Score every factor ─────────────────────────────────────────────
    const factors = [];
    const W = {
      // Weights: higher = more influence on final score
      futures: 3.0,        // Overnight futures are the strongest next-day predictor
      rsi: 1.0,
      macd: 0.8,
      ema: 1.2,
      bollinger: 0.8,
      stochastic: 0.6,
      meanReversion: 1.5,  // Strong for ASX
      consecutiveDays: 1.2,
      volume: 0.5,
      obv: 0.4,
      vix: 1.0,
      intermarket: 1.5,    // Gold, oil, DXY, bonds, AUD
      btc: 0.3,
      calendar: 0.4,
      historical: 1.0,
      seasonal: 0.4,
    };

    // 1. Overnight Futures
    const f_futures = scoreFuturesOvernight(nqChg, esChg, ymChg);
    factors.push({ name: 'Overnight Futures', weight: W.futures, ...f_futures });

    // 2. RSI
    const f_rsi = scoreRSI(rsi);
    factors.push({ name: 'RSI', weight: W.rsi, ...f_rsi });

    // 3. MACD
    const f_macd = scoreMACD(macd);
    factors.push({ name: 'MACD', weight: W.macd, ...f_macd });

    // 4. EMA Alignment
    const f_ema = scoreEMAAlignment(closes);
    factors.push({ name: 'EMA Alignment', weight: W.ema, ...f_ema });

    // 5. Bollinger Bands
    const f_bb = scoreBollinger(closes);
    factors.push({ name: 'Bollinger Bands', weight: W.bollinger, ...f_bb });

    // 6. Stochastic
    const f_stoch = scoreStochastic(asxHist);
    factors.push({ name: 'Stochastic', weight: W.stochastic, ...f_stoch });

    // 7. Mean Reversion
    const f_mr = scoreMeanReversion(asxHist);
    factors.push({ name: 'Mean Reversion', weight: W.meanReversion, ...f_mr });

    // 8. Consecutive Days
    const f_cd = scoreConsecutiveDays(asxHist);
    factors.push({ name: 'Consecutive Days', weight: W.consecutiveDays, ...f_cd });

    // 9. Volume
    const f_vol = scoreVolume(asxHist);
    factors.push({ name: 'Volume', weight: W.volume, ...f_vol });

    // 10. OBV Trend
    const f_obv = scoreOBVTrend(asxHist);
    factors.push({ name: 'OBV Trend', weight: W.obv, ...f_obv });

    // 11. VIX
    const f_vix = scoreVIX(vixData);
    factors.push({ name: 'VIX', weight: W.vix, ...f_vix });

    // 12. Intermarket
    const f_inter = scoreIntermarket(goldChg, oilChg, dxyChg, bondChg, audChg);
    factors.push({ name: 'Intermarket', weight: W.intermarket, ...f_inter });

    // 13. BTC
    const f_btc = scoreBTC(btcChg);
    factors.push({ name: 'Bitcoin Risk', weight: W.btc, ...f_btc });

    // 14. Calendar
    const f_cal = scoreCalendar();
    factors.push({ name: 'Calendar', weight: W.calendar, ...f_cal });

    // 15. Historical Pattern Match
    const f_hist = findSimilarDays(asxHist, { rsi, overnightPct: (nqChg || 0 + esChg || 0) / 2, consecutiveDays });
    factors.push({ name: 'Historical Pattern', weight: W.historical, ...f_hist });

    // 16. Seasonal
    const f_season = seasonalAnalysis(asxHist);
    factors.push({ name: 'Seasonal', weight: W.seasonal, ...f_season });

    // ── Calculate weighted final score ──────────────────────────────────
    let totalWeightedScore = 0;
    let totalWeight = 0;
    for (const f of factors) {
      totalWeightedScore += f.score * f.weight;
      totalWeight += f.weight;
    }
    const finalScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

    // ── Determine prediction ───────────────────────────────────────────
    const direction = finalScore > 0.15 ? 'BULL' : finalScore < -0.15 ? 'BEAR' : 'NEUTRAL';

    // Confidence: based on signal agreement
    const bullFactors = factors.filter(f => f.score > 0.1).length;
    const bearFactors = factors.filter(f => f.score < -0.1).length;
    const agreement = Math.abs(bullFactors - bearFactors) / factors.length;
    const rawConfidence = 40 + agreement * 45 + Math.abs(finalScore) * 10;
    const confidence = Math.min(92, Math.max(35, rawConfidence));

    // ── Predicted range ────────────────────────────────────────────────
    const atrVal = atr || lastPrice * 0.01;
    // Scale ATR by score magnitude — stronger conviction = tighter range in predicted direction
    const expectedMove = atrVal * (0.3 + Math.abs(finalScore) * 0.4);
    let rangeLow, rangeHigh;
    if (direction === 'BULL') {
      rangeLow = lastPrice - atrVal * 0.3;
      rangeHigh = lastPrice + expectedMove;
    } else if (direction === 'BEAR') {
      rangeLow = lastPrice - expectedMove;
      rangeHigh = lastPrice + atrVal * 0.3;
    } else {
      rangeLow = lastPrice - atrVal * 0.5;
      rangeHigh = lastPrice + atrVal * 0.5;
    }

    // Estimated % change
    const estChangePct = finalScore * 0.3; // Rough mapping

    // ── Run backtest ───────────────────────────────────────────────────
    const backtest = quickBacktest(asxHist);

    // ── Assemble response ──────────────────────────────────────────────
    const response = {
      prediction: {
        direction,
        score: +finalScore.toFixed(3),
        confidence: +confidence.toFixed(1),
        estimatedChange: `${estChangePct > 0 ? '+' : ''}${estChangePct.toFixed(2)}%`,
        range: { low: +rangeLow.toFixed(1), high: +rangeHigh.toFixed(1) },
        lastPrice: +lastPrice.toFixed(1),
      },
      factors: factors.map(f => ({
        name: f.name,
        score: +f.score.toFixed(2),
        weight: f.weight,
        weightedScore: +(f.score * f.weight).toFixed(2),
        detail: f.detail,
      })),
      intermarket: {
        nq: nqChg != null ? +nqChg.toFixed(2) : null,
        es: esChg != null ? +esChg.toFixed(2) : null,
        ym: ymChg != null ? +ymChg.toFixed(2) : null,
        vix: vixData?.[vixData.length - 1]?.c || null,
        vixRegime: f_vix.regime,
        gold: goldChg != null ? +goldChg.toFixed(2) : null,
        oil: oilChg != null ? +oilChg.toFixed(2) : null,
        dxy: dxyChg != null ? +dxyChg.toFixed(2) : null,
        bond10y: bondChg != null ? +bondChg.toFixed(2) : null,
        aud: audChg != null ? +audChg.toFixed(2) : null,
        btc: btcChg != null ? +btcChg.toFixed(2) : null,
        copper: copperChg != null ? +copperChg.toFixed(2) : null,
      },
      technicals: {
        rsi: rsi != null ? +rsi.toFixed(1) : null,
        macd: macd ? { line: +macd.line.toFixed(2), signal: +macd.signal.toFixed(2), hist: +macd.hist.toFixed(2) } : null,
        atr: atr != null ? +atr.toFixed(2) : null,
        stochastic: stoch ? { k: +stoch.k.toFixed(1), d: +stoch.d.toFixed(1) } : null,
        consecutiveDays,
        emaAlignment: f_ema.detail,
        bollingerPctB: f_bb.detail,
        meanReversion: f_mr.detail,
      },
      backtest,
      historicalMatches: f_hist.matches?.slice(-5) || [],
      seasonal: f_season.detail,
      generated: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error('[predict-v2] Error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
