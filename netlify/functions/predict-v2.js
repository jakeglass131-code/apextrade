// ═══════════════════════════════════════════════════════════════════════════════
// APEXtrade Prediction Engine v2.5 — Institutional Multi-Factor Quant Model
// ═══════════════════════════════════════════════════════════════════════════════
// 40+ factors across 7 categories:
//   1. PRICE ACTION (12 factors): RSI multi-TF, MACD, Stochastic, Bollinger,
//      Ichimoku, ADX, Williams %R, CCI, MFI, Parabolic SAR, Keltner, ROC
//   2. TREND & STRUCTURE (6): EMA alignment, mean reversion, consecutive days,
//      Fibonacci retracement, pivot points, fractal levels
//   3. VOLUME & FLOW (4): Volume ratio, OBV slope, MFI divergence, VWAP deviation
//   4. INTERMARKET (10): NQ/ES/YM futures, VIX + term structure, gold, oil,
//      DXY, US10Y, AUD/USD, BTC, copper, yield curve (2s10s)
//   5. STATISTICAL (6): Z-score, autocorrelation, skewness, kurtosis,
//      Hurst exponent (trending vs mean-reverting regime), distribution tail risk
//   6. CALENDAR & SEASONAL (4): Day-of-week, month effect, options expiry,
//      same-week-of-year seasonality
//   7. PATTERN MATCHING (3): RSI+momentum similar-day matching, gap analysis,
//      regime-aware historical comparison
//
// Regime detection: ADX + Hurst + correlation clustering to identify
// TRENDING / MEAN-REVERTING / VOLATILE / QUIET regimes. Weights adapt per regime.
//
// Backtest: 2-year walk-forward with Sharpe ratio, max drawdown, Kelly criterion,
// regime-segmented accuracy, monthly PnL heatmap, streak analysis.
//
// Ensemble: 3 sub-models (momentum, mean-reversion, intermarket) combined via
// regime-weighted voting. Each sub-model has its own factor set and weights.
// ═══════════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=120',
};

// ── Cache ────────────────────────────────────────────────────────────────────
let _cache = {};
const CACHE_TTL = 3 * 60 * 1000;
const HIST_CACHE_TTL = 6 * 60 * 60 * 1000;

// ── Yahoo Finance ────────────────────────────────────────────────────────────
async function yahooChart(symbol, range = '2y', interval = '1d') {
  const key = `yf_${symbol}_${range}_${interval}`;
  const ttl = range === '1d' || range === '5d' ? CACHE_TTL : HIST_CACHE_TTL;
  if (_cache[key] && Date.now() - _cache[key].ts < ttl) return _cache[key].data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexTrade/2.5)' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const d = await r.json();
  const res = d.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const candles = ts.map((t, i) => ({
    t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i],
    c: adj?.[i] ?? q.close?.[i], v: q.volume?.[i] || 0,
  })).filter(c => c.o != null && c.c != null && c.h != null && c.l != null);
  _cache[key] = { data: candles, ts: Date.now() };
  return candles;
}
async function safeYahoo(symbol, range, interval) {
  try { return await yahooChart(symbol, range, interval); }
  catch (e) { console.warn(`[v2] ${symbol}: ${e.message}`); return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// INDICATOR LIBRARY — every standard + advanced indicator
// ═════════════════════════════════════════════════════════════════════════════

function sma(arr, p) {
  if (arr.length < p) return null;
  return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// Full EMA series (returns array of EMA values for each point after warmup)
function emaSeries(arr, p) {
  if (arr.length < p) return [];
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = [e];
  for (let i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

// Full RSI series
function rsiSeries(closes, period = 14) {
  if (closes.length < period + 2) return [];
  const out = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const e12s = emaSeries(closes, 12);
  const e26s = emaSeries(closes, 26);
  if (e26s.length < 9) return null;
  // Align: e12s starts at index 12, e26s at index 26
  const macdLine = [];
  const offset = 26 - 12;
  for (let i = 0; i < e26s.length; i++) macdLine.push(e12s[i + offset] - e26s[i]);
  const sigSeries = emaSeries(macdLine, 9);
  const hist = macdLine[macdLine.length - 1] - sigSeries[sigSeries.length - 1];
  const prevHist = macdLine.length >= 2 && sigSeries.length >= 2
    ? macdLine[macdLine.length - 2] - sigSeries[sigSeries.length - 2] : hist;
  return { line: macdLine[macdLine.length - 1], signal: sigSeries[sigSeries.length - 1], hist, prevHist };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  }
  return sum / period;
}

// ATR series
function atrSeries(candles, period = 14) {
  const out = [];
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += Math.max(candles[j].h - candles[j].l, Math.abs(candles[j].h - candles[j - 1].c), Math.abs(candles[j].l - candles[j - 1].c));
    }
    out.push(sum / period);
  }
  return out;
}

function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std, std, width: (mult * 2 * std) / mean };
}

function stochastic(candles, kP = 14, dP = 3) {
  if (candles.length < kP + dP) return null;
  const kVals = [];
  for (let i = candles.length - kP - dP + 1; i < candles.length; i++) {
    const w = candles.slice(Math.max(0, i - kP + 1), i + 1);
    const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
    kVals.push(hi === lo ? 50 : ((candles[i].c - lo) / (hi - lo)) * 100);
  }
  return { k: kVals[kVals.length - 1], d: kVals.slice(-dP).reduce((a, b) => a + b, 0) / dP };
}

// ── Ichimoku Cloud ──────────────────────────────────────────────────────────
function ichimoku(candles) {
  if (candles.length < 52) return null;
  const midHL = (arr) => { const h = Math.max(...arr.map(c => c.h)), l = Math.min(...arr.map(c => c.l)); return (h + l) / 2; };
  const tenkan = midHL(candles.slice(-9));          // Conversion line (9)
  const kijun = midHL(candles.slice(-26));           // Base line (26)
  const senkouA = (tenkan + kijun) / 2;             // Leading Span A
  const senkouB = midHL(candles.slice(-52));          // Leading Span B (52)
  const chikou = candles[candles.length - 1].c;      // Lagging span = current close
  const price = candles[candles.length - 1].c;
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  return { tenkan, kijun, senkouA, senkouB, chikou, cloudTop, cloudBottom, price,
    aboveCloud: price > cloudTop, belowCloud: price < cloudBottom, inCloud: price >= cloudBottom && price <= cloudTop,
    tkCross: tenkan > kijun ? 'bullish' : 'bearish', cloudColor: senkouA > senkouB ? 'green' : 'red' };
}

// ── ADX (Average Directional Index) ─────────────────────────────────────────
function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  let atr14 = 0, pDM14 = 0, nDM14 = 0;
  // First period sums
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    atr14 += tr;
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    pDM14 += (upMove > downMove && upMove > 0) ? upMove : 0;
    nDM14 += (downMove > upMove && downMove > 0) ? downMove : 0;
  }
  // Smooth
  const dxValues = [];
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    atr14 = atr14 - atr14 / period + tr;
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    pDM14 = pDM14 - pDM14 / period + ((upMove > downMove && upMove > 0) ? upMove : 0);
    nDM14 = nDM14 - nDM14 / period + ((downMove > upMove && downMove > 0) ? downMove : 0);
    const pDI = (pDM14 / atr14) * 100;
    const nDI = (nDM14 / atr14) * 100;
    const dx = ((Math.abs(pDI - nDI)) / (pDI + nDI)) * 100;
    dxValues.push({ dx, pDI, nDI });
  }
  if (dxValues.length < period) return null;
  const adxVal = dxValues.slice(-period).reduce((a, b) => a + b.dx, 0) / period;
  const last = dxValues[dxValues.length - 1];
  return { adx: adxVal, pDI: last.pDI, nDI: last.nDI, trending: adxVal > 25, strong: adxVal > 40 };
}

// ── Williams %R ─────────────────────────────────────────────────────────────
function williamsR(candles, period = 14) {
  if (candles.length < period) return null;
  const w = candles.slice(-period);
  const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
  if (hi === lo) return -50;
  return ((hi - candles[candles.length - 1].c) / (hi - lo)) * -100;
}

// ── CCI (Commodity Channel Index) ───────────────────────────────────────────
function cci(candles, period = 20) {
  if (candles.length < period) return null;
  const tps = candles.slice(-period).map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}

// ── MFI (Money Flow Index) ──────────────────────────────────────────────────
function mfi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const rawFlow = tp * candles[i].v;
    if (tp > prevTp) posFlow += rawFlow; else negFlow += rawFlow;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

// ── Parabolic SAR ───────────────────────────────────────────────────────────
function parabolicSAR(candles, afStart = 0.02, afStep = 0.02, afMax = 0.2) {
  if (candles.length < 5) return null;
  let isUp = candles[1].c > candles[0].c;
  let sar = isUp ? candles[0].l : candles[0].h;
  let ep = isUp ? candles[1].h : candles[1].l;
  let af = afStart;
  for (let i = 2; i < candles.length; i++) {
    sar = sar + af * (ep - sar);
    if (isUp) {
      if (candles[i].l < sar) { isUp = false; sar = ep; ep = candles[i].l; af = afStart; }
      else { if (candles[i].h > ep) { ep = candles[i].h; af = Math.min(af + afStep, afMax); } }
    } else {
      if (candles[i].h > sar) { isUp = true; sar = ep; ep = candles[i].h; af = afStart; }
      else { if (candles[i].l < ep) { ep = candles[i].l; af = Math.min(af + afStep, afMax); } }
    }
  }
  return { sar, isUp, price: candles[candles.length - 1].c };
}

// ── Keltner Channels ────────────────────────────────────────────────────────
function keltner(candles, emaPeriod = 20, atrPeriod = 10, mult = 1.5) {
  const closes = candles.map(c => c.c);
  const mid = ema(closes, emaPeriod);
  const atrVal = atr(candles, atrPeriod);
  if (mid == null || atrVal == null) return null;
  return { upper: mid + mult * atrVal, middle: mid, lower: mid - mult * atrVal, price: closes[closes.length - 1] };
}

// ── Rate of Change ──────────────────────────────────────────────────────────
function roc(closes, period = 12) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

// ── OBV slope ───────────────────────────────────────────────────────────────
function obvSlope(candles, lookback = 10) {
  if (candles.length < lookback + 1) return null;
  let obv = 0;
  const obvArr = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > candles[i - 1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i - 1].c) obv -= candles[i].v;
    obvArr.push(obv);
  }
  const recent = obvArr.slice(-lookback);
  const avgVol = candles.slice(-20).reduce((a, c) => a + c.v, 0) / 20;
  return avgVol > 0 ? (recent[recent.length - 1] - recent[0]) / (avgVol * lookback) : 0;
}

// ── VWAP ────────────────────────────────────────────────────────────────────
function vwap(candles, period = 20) {
  if (candles.length < period) return null;
  const rec = candles.slice(-period);
  let cumPV = 0, cumV = 0;
  for (const c of rec) { cumPV += ((c.h + c.l + c.c) / 3) * c.v; cumV += c.v; }
  return cumV > 0 ? cumPV / cumV : null;
}

// ── Fibonacci Retracement ───────────────────────────────────────────────────
function fibonacci(candles, lookback = 60) {
  const window = candles.slice(-lookback);
  const hi = Math.max(...window.map(c => c.h));
  const lo = Math.min(...window.map(c => c.l));
  const range = hi - lo;
  const price = candles[candles.length - 1].c;
  const retracement = range > 0 ? (hi - price) / range : 0.5;
  return {
    levels: { '0%': hi, '23.6%': hi - range * 0.236, '38.2%': hi - range * 0.382, '50%': hi - range * 0.5,
              '61.8%': hi - range * 0.618, '78.6%': hi - range * 0.786, '100%': lo },
    retracement, nearLevel: retracement < 0.05 ? '0%' : retracement < 0.3 ? '23.6%' : retracement < 0.44 ? '38.2%' :
      retracement < 0.56 ? '50%' : retracement < 0.7 ? '61.8%' : retracement < 0.85 ? '78.6%' : '100%',
    price, high: hi, low: lo
  };
}

// ── Pivot Points (Standard) ─────────────────────────────────────────────────
function pivotPoints(candles) {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2]; // Previous day
  const pp = (prev.h + prev.l + prev.c) / 3;
  return {
    pp, r1: 2 * pp - prev.l, r2: pp + (prev.h - prev.l), r3: prev.h + 2 * (pp - prev.l),
    s1: 2 * pp - prev.h, s2: pp - (prev.h - prev.l), s3: prev.l - 2 * (prev.h - pp),
    price: candles[candles.length - 1].c
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// STATISTICAL ANALYSIS
// ═════════════════════════════════════════════════════════════════════════════

function returns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return r;
}

function zScore(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = returns(closes.slice(-period - 1));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  if (std === 0) return 0;
  return (rets[rets.length - 1] - mean) / std;
}

function autocorrelation(closes, lag = 1) {
  const rets = returns(closes);
  if (rets.length < lag + 10) return null;
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = lag; i < n; i++) num += (rets[i] - mean) * (rets[i - lag] - mean);
  for (let i = 0; i < n; i++) den += (rets[i] - mean) ** 2;
  return den === 0 ? 0 : num / den;
}

function skewness(closes, period = 60) {
  const rets = returns(closes.slice(-period - 1));
  const n = rets.length;
  if (n < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (std === 0) return 0;
  return (rets.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / n);
}

function kurtosis(closes, period = 60) {
  const rets = returns(closes.slice(-period - 1));
  const n = rets.length;
  if (n < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (std === 0) return 0;
  return (rets.reduce((a, b) => a + ((b - mean) / std) ** 4, 0) / n) - 3; // Excess kurtosis
}

// Hurst exponent — H > 0.5 = trending, H < 0.5 = mean reverting, H ≈ 0.5 = random walk
function hurstExponent(closes, maxLag = 20) {
  if (closes.length < maxLag * 4) return null;
  const rets = returns(closes);
  const lags = [];
  const rs = [];
  for (let lag = 4; lag <= maxLag; lag++) {
    const chunks = Math.floor(rets.length / lag);
    if (chunks < 2) continue;
    let totalRS = 0;
    for (let c = 0; c < chunks; c++) {
      const chunk = rets.slice(c * lag, (c + 1) * lag);
      const mean = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      const deviations = chunk.map(r => r - mean);
      const cumDev = [];
      let sum = 0;
      for (const d of deviations) { sum += d; cumDev.push(sum); }
      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(chunk.reduce((a, b) => a + (b - mean) ** 2, 0) / chunk.length);
      if (S > 0) totalRS += R / S;
    }
    lags.push(Math.log(lag));
    rs.push(Math.log(totalRS / chunks));
  }
  if (lags.length < 3) return 0.5;
  // Linear regression of log(R/S) on log(lag)
  const n = lags.length;
  const sumX = lags.reduce((a, b) => a + b, 0);
  const sumY = rs.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((a, b, i) => a + b * rs[i], 0);
  const sumX2 = lags.reduce((a, b) => a + b * b, 0);
  const H = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return Math.max(0, Math.min(1, H));
}

// Tail risk — probability of extreme moves (>2 sigma)
function tailRisk(closes, period = 60) {
  const rets = returns(closes.slice(-period - 1));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  if (std === 0) return { left: 0, right: 0 };
  const leftTail = rets.filter(r => r < mean - 2 * std).length / rets.length;
  const rightTail = rets.filter(r => r > mean + 2 * std).length / rets.length;
  return { left: leftTail, right: rightTail };
}

// ═════════════════════════════════════════════════════════════════════════════
// REGIME DETECTION
// ═════════════════════════════════════════════════════════════════════════════
function detectRegime(candles, closes) {
  const adxData = adx(candles);
  const hurst = hurstExponent(closes);
  const atrVal = atr(candles);
  const atrPctile = atrPercentileRank(candles);
  const bbData = bollingerBands(closes);
  const bbWidth = bbData ? bbData.width : 0;

  let regime = 'NORMAL';
  let confidence = 0.5;

  if (adxData && adxData.adx > 30 && hurst > 0.55) {
    regime = 'TRENDING';
    confidence = 0.7 + Math.min(0.2, (adxData.adx - 30) / 50);
  } else if (adxData && adxData.adx < 20 && hurst < 0.45) {
    regime = 'MEAN_REVERTING';
    confidence = 0.65 + Math.min(0.2, (20 - adxData.adx) / 40);
  } else if (atrPctile > 80 || bbWidth > 0.06) {
    regime = 'VOLATILE';
    confidence = 0.6;
  } else if (atrPctile < 20 && bbWidth < 0.02) {
    regime = 'QUIET';
    confidence = 0.6;
  }

  return { regime, confidence, adx: adxData?.adx || 0, hurst: hurst || 0.5, atrPctile, bbWidth };
}

function atrPercentileRank(candles, lookback = 252) {
  const atrs = atrSeries(candles, 14);
  if (atrs.length < 20) return 50;
  const window = atrs.slice(-Math.min(lookback, atrs.length));
  const current = window[window.length - 1];
  const rank = window.filter(a => a <= current).length;
  return (rank / window.length) * 100;
}

// ═════════════════════════════════════════════════════════════════════════════
// SuperTrend — multi-timeframe trend-following indicator
// ═════════════════════════════════════════════════════════════════════════════

// Compute SuperTrend for a given candles array
// Returns { direction: 'BULL'|'BEAR', level, trend[] } for the last N bars
function superTrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return null;

  // Compute ATR using Wilder's smoothing (same as TradingView)
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }

  // Wilder smoothed ATR
  const atrArr = [];
  let atrSum = 0;
  for (let i = 0; i < period && i < trueRanges.length; i++) atrSum += trueRanges[i];
  atrArr.push(atrSum / period);
  for (let i = period; i < trueRanges.length; i++) {
    atrArr.push((atrArr[atrArr.length - 1] * (period - 1) + trueRanges[i]) / period);
  }

  // SuperTrend calculation
  const st = []; // { upper, lower, trend, level }
  // Candles[0] has no TR, so candles index = i+1 corresponds to atrArr index = i
  for (let i = 0; i < atrArr.length; i++) {
    const ci = i + 1; // candle index (offset by 1 because TR starts at index 1)
    const hl2 = (candles[ci].h + candles[ci].l) / 2;
    let upperBand = hl2 + multiplier * atrArr[i];
    let lowerBand = hl2 - multiplier * atrArr[i];

    // Clamp bands to prevent whipsaw
    if (st.length > 0) {
      const prev = st[st.length - 1];
      if (lowerBand > prev.lower && candles[ci - 1].c > prev.lower) {
        lowerBand = Math.max(lowerBand, prev.lower);
      }
      if (upperBand < prev.upper && candles[ci - 1].c < prev.upper) {
        upperBand = Math.min(upperBand, prev.upper);
      }
    }

    let trend;
    if (st.length === 0) {
      trend = candles[ci].c > upperBand ? 1 : -1;
    } else {
      const prev = st[st.length - 1];
      if (prev.trend === 1 && candles[ci].c < prev.lower) trend = -1;
      else if (prev.trend === -1 && candles[ci].c > prev.upper) trend = 1;
      else trend = prev.trend;
    }

    const level = trend === 1 ? lowerBand : upperBand;
    st.push({ upper: upperBand, lower: lowerBand, trend, level });
  }

  if (st.length < 2) return null;
  const last = st[st.length - 1];
  const prev = st[st.length - 2];
  const lastC = candles[candles.length - 1];

  // Distance from SuperTrend level (as % of price)
  const distPct = ((lastC.c - last.level) / lastC.c) * 100;

  // Detect flip (trend reversal on most recent bar)
  const flipped = last.trend !== prev.trend;

  return {
    direction: last.trend === 1 ? 'BULL' : 'BEAR',
    level: +last.level.toFixed(2),
    distancePct: +distPct.toFixed(2),
    flipped,
    trend: st.slice(-20).map(s => s.trend), // last 20 bars for analysis
  };
}

// Build weekly candles from daily candles (Mon-Fri aggregation)
function buildWeeklyCandles(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 10) return [];
  const weeks = [];
  let week = null;
  for (let i = 0; i < dailyCandles.length; i++) {
    const d = new Date(dailyCandles[i].t);
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri
    if (!week || dow <= 1 || (d.getTime() - week.startTime > 5 * 86400000)) {
      if (week) weeks.push(week.candle);
      week = {
        startTime: d.getTime(),
        candle: { t: dailyCandles[i].t, o: dailyCandles[i].o, h: dailyCandles[i].h, l: dailyCandles[i].l, c: dailyCandles[i].c, v: dailyCandles[i].v }
      };
    } else {
      week.candle.h = Math.max(week.candle.h, dailyCandles[i].h);
      week.candle.l = Math.min(week.candle.l, dailyCandles[i].l);
      week.candle.c = dailyCandles[i].c;
      week.candle.v += dailyCandles[i].v || 0;
    }
  }
  if (week) weeks.push(week.candle);
  return weeks;
}

// Score SuperTrend across daily + weekly timeframes
// Key insight: When weekly SuperTrend is bullish and price touches the weekly ST level,
// there's a high-probability daily bounce. Conversely for bearish.
function scoreSuperTrend(candles) {
  if (!candles || candles.length < 30) return { score: 0, detail: 'Insufficient data' };

  const stDaily = superTrend(candles, 10, 3);
  if (!stDaily) return { score: 0, detail: 'N/A' };

  // Build weekly and compute weekly SuperTrend
  const weeklyCandles = buildWeeklyCandles(candles);
  const stWeekly = superTrend(weeklyCandles, 10, 3);

  let score = 0;
  const notes = [];

  // ── Daily SuperTrend signal ──────────────────────────────────
  if (stDaily.direction === 'BULL') {
    score += 0.4;
    notes.push('D:BULL');
  } else {
    score -= 0.4;
    notes.push('D:BEAR');
  }

  // Daily flip = strong signal
  if (stDaily.flipped) {
    score += stDaily.direction === 'BULL' ? 0.6 : -0.6;
    notes.push('D:FLIP');
  }

  // ── Weekly SuperTrend signal ─────────────────────────────────
  if (stWeekly) {
    if (stWeekly.direction === 'BULL') {
      score += 0.3;
      notes.push('W:BULL');
    } else {
      score -= 0.3;
      notes.push('W:BEAR');
    }

    // Weekly flip is a major trend change
    if (stWeekly.flipped) {
      score += stWeekly.direction === 'BULL' ? 0.8 : -0.8;
      notes.push('W:FLIP!');
    }

    // ── Multi-timeframe confluence ────────────────────────────
    // Both timeframes agree = high conviction
    if (stDaily.direction === stWeekly.direction) {
      score += stDaily.direction === 'BULL' ? 0.3 : -0.3;
      notes.push('MTF-AGREE');
    } else {
      // Divergence: weekly trend trumps daily for bias, but reduces conviction
      notes.push('MTF-DIVERGE');
    }

    // ── Key level proximity (bounce detection) ────────────────
    // When price is near the weekly SuperTrend level in a bullish weekly trend,
    // expect a bounce (support). Same logic inverted for bearish.
    if (stWeekly.direction === 'BULL' && stWeekly.distancePct < 1.5 && stWeekly.distancePct > 0) {
      // Price near weekly support in uptrend — bounce zone
      score += 0.5;
      notes.push('W:BOUNCE-ZONE');
    }
    if (stWeekly.direction === 'BEAR' && stWeekly.distancePct > -1.5 && stWeekly.distancePct < 0) {
      // Price near weekly resistance in downtrend — rejection zone
      score -= 0.5;
      notes.push('W:REJECT-ZONE');
    }

    // Weekly breakdown below SuperTrend support = major bearish signal
    if (stWeekly.direction === 'BEAR' && stWeekly.flipped) {
      score -= 0.5; // Additional penalty for weekly breakdown
      notes.push('W:BREAKDOWN');
    }
    // Weekly breakout above SuperTrend resistance = major bullish signal
    if (stWeekly.direction === 'BULL' && stWeekly.flipped) {
      score += 0.5;
      notes.push('W:BREAKOUT');
    }
  }

  // Daily proximity to support/resistance
  if (stDaily.direction === 'BULL' && Math.abs(stDaily.distancePct) < 0.5) {
    score += 0.3; // Tight to support, likely bounce
    notes.push('D:TIGHT-SUPPORT');
  }
  if (stDaily.direction === 'BEAR' && Math.abs(stDaily.distancePct) < 0.5) {
    score -= 0.3;
    notes.push('D:TIGHT-RESIST');
  }

  // Trend consistency (how many of last 20 bars were in same direction)
  if (stDaily.trend && stDaily.trend.length >= 10) {
    const bullBars = stDaily.trend.filter(t => t === 1).length;
    const trendStrength = bullBars / stDaily.trend.length;
    if (trendStrength > 0.8) { score += 0.2; notes.push('D:STRONG-TREND'); }
    else if (trendStrength < 0.2) { score -= 0.2; notes.push('D:STRONG-DOWNTREND'); }
    else if (trendStrength > 0.4 && trendStrength < 0.6) { notes.push('D:CHOPPY'); }
  }

  return {
    score: Math.max(-3, Math.min(3, +score.toFixed(2))),
    detail: notes.join(' · '),
    daily: stDaily,
    weekly: stWeekly || null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS — 40+ factors
// ═════════════════════════════════════════════════════════════════════════════

// 1. Overnight Futures (scaled, non-linear)
function scoreFutures(nq, es, ym) {
  const avg = ((nq || 0) * 0.4 + (es || 0) * 0.4 + (ym || 0) * 0.2);
  // Non-linear: big moves are disproportionately important
  const sign = avg >= 0 ? 1 : -1;
  const mag = Math.abs(avg);
  const scaled = sign * (mag < 0.3 ? mag * 0.5 : mag < 1 ? mag * 1.2 : mag * 1.8);
  return { score: Math.max(-4, Math.min(4, scaled)), detail: `NQ ${(nq||0).toFixed(2)}% ES ${(es||0).toFixed(2)}% YM ${(ym||0).toFixed(2)}%` };
}

// 2. RSI (14) — curved
function scoreRSI(val) {
  if (val == null) return { score: 0, detail: 'N/A' };
  let s;
  if (val > 85) s = -2.5; else if (val > 80) s = -2; else if (val > 75) s = -1.5; else if (val > 70) s = -1;
  else if (val > 65) s = -0.3; else if (val > 55) s = 0.2; else if (val > 45) s = 0;
  else if (val > 40) s = -0.2; else if (val > 35) s = 0.3; else if (val > 30) s = 1;
  else if (val > 25) s = 1.5; else if (val > 20) s = 2; else s = 2.5;
  return { score: s, detail: `RSI ${val.toFixed(1)}` };
}

// 3. RSI Weekly (multi-timeframe confluence)
function scoreRSIWeekly(candles) {
  if (candles.length < 75) return { score: 0, detail: 'Insufficient data' };
  // Simulate weekly candles from daily
  const weekly = [];
  for (let i = 0; i < candles.length; i += 5) {
    const week = candles.slice(i, Math.min(i + 5, candles.length));
    weekly.push({ o: week[0].o, h: Math.max(...week.map(c => c.h)), l: Math.min(...week.map(c => c.l)), c: week[week.length - 1].c });
  }
  const wCloses = weekly.map(w => w.c);
  const wRsi = rsi(wCloses);
  if (wRsi == null) return { score: 0, detail: 'N/A' };
  const s = wRsi > 75 ? -1 : wRsi > 65 ? -0.3 : wRsi > 55 ? 0.15 : wRsi > 45 ? 0 : wRsi > 35 ? -0.15 : wRsi > 25 ? 0.3 : 1;
  return { score: s, detail: `Weekly RSI ${wRsi.toFixed(1)}` };
}

// 4. MACD momentum + histogram acceleration
function scoreMACD(m) {
  if (!m) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (m.hist > 0) s += 0.5; else s -= 0.5;
  if (m.line > m.signal) s += 0.3; else s -= 0.3;
  // Histogram acceleration (increasing vs decreasing momentum)
  if (m.hist > m.prevHist) s += 0.3; else s -= 0.3;
  // Zero-line crossover is a strong signal
  if (m.line > 0 && m.signal > 0) s += 0.2;
  if (m.line < 0 && m.signal < 0) s -= 0.2;
  return { score: Math.max(-1.5, Math.min(1.5, s)), detail: `Hist ${m.hist.toFixed(2)} (${m.hist > m.prevHist ? 'accel' : 'decel'})` };
}

// 5. EMA alignment (8/21/50/100/200)
function scoreEMA(closes) {
  if (closes.length < 200) return { score: 0, detail: 'Need 200 bars' };
  const e8 = ema(closes, 8), e21 = ema(closes, 21), e50 = ema(closes, 50), e100 = ema(closes, 100), e200 = ema(closes, 200);
  let s = 0;
  const price = closes[closes.length - 1];
  // Full alignment scoring
  if (e8 > e21) s += 0.2; else s -= 0.2;
  if (e21 > e50) s += 0.2; else s -= 0.2;
  if (e50 > e100) s += 0.15; else s -= 0.15;
  if (e100 > e200) s += 0.15; else s -= 0.15;
  // Price relative to key EMAs
  if (price > e200) s += 0.15; else s -= 0.15;
  if (price > e50) s += 0.1; else s -= 0.1;
  // Distance from 200 EMA (trend health)
  const dist200 = ((price - e200) / e200) * 100;
  if (dist200 > 8) s -= 0.2; // Extended
  if (dist200 < -8) s += 0.2; // Oversold
  const align = s > 0.5 ? 'BULLISH' : s < -0.5 ? 'BEARISH' : 'MIXED';
  return { score: Math.max(-1.2, Math.min(1.2, s)), detail: `${align} (${dist200 > 0 ? '+' : ''}${dist200.toFixed(1)}% from 200EMA)` };
}

// 6. Bollinger Bands position + squeeze detection
function scoreBollinger(closes) {
  const bb = bollingerBands(closes);
  if (!bb) return { score: 0, detail: 'N/A' };
  const price = closes[closes.length - 1];
  const pctB = (price - bb.lower) / (bb.upper - bb.lower);
  let s = 0;
  if (pctB > 0.95) s = -1.2; else if (pctB > 0.85) s = -0.7; else if (pctB > 0.8) s = -0.3;
  else if (pctB < 0.05) s = 1.2; else if (pctB < 0.15) s = 0.7; else if (pctB < 0.2) s = 0.3;
  const squeeze = bb.width < 0.02;
  return { score: s, detail: `%B=${(pctB * 100).toFixed(0)}% W=${(bb.width * 100).toFixed(1)}%${squeeze ? ' ⚡SQUEEZE' : ''}` };
}

// 7. Stochastic
function scoreStoch(candles) {
  const s = stochastic(candles);
  if (!s) return { score: 0, detail: 'N/A' };
  let score = 0;
  if (s.k > 80 && s.d > 80) score = -1; else if (s.k > 80) score = -0.5;
  else if (s.k < 20 && s.d < 20) score = 1; else if (s.k < 20) score = 0.5;
  if (s.k > s.d && s.k < 40) score += 0.4; // Bullish crossover in oversold
  if (s.k < s.d && s.k > 60) score -= 0.4; // Bearish crossover in overbought
  return { score: Math.max(-1.2, Math.min(1.2, score)), detail: `K=${s.k.toFixed(0)} D=${s.d.toFixed(0)}` };
}

// 8. Ichimoku
function scoreIchimoku(candles) {
  const ich = ichimoku(candles);
  if (!ich) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (ich.aboveCloud) s += 0.5; else if (ich.belowCloud) s -= 0.5;
  if (ich.tkCross === 'bullish') s += 0.3; else s -= 0.3;
  if (ich.cloudColor === 'green') s += 0.2; else s -= 0.2;
  // Price vs Kijun (base line) — key support/resistance
  if (ich.price > ich.kijun) s += 0.15; else s -= 0.15;
  const pos = ich.aboveCloud ? 'Above cloud' : ich.belowCloud ? 'Below cloud' : 'In cloud';
  return { score: Math.max(-1.2, Math.min(1.2, s)), detail: `${pos}, TK ${ich.tkCross}, cloud ${ich.cloudColor}` };
}

// 9. ADX (trend strength)
function scoreADX(candles) {
  const a = adx(candles);
  if (!a) return { score: 0, detail: 'N/A' };
  // ADX tells strength not direction — use +DI/-DI for direction
  let s = 0;
  const direction = a.pDI > a.nDI ? 1 : -1;
  if (a.adx > 40) s = direction * 0.8; // Strong trend, go with it
  else if (a.adx > 25) s = direction * 0.4; // Moderate trend
  else s = -direction * 0.2; // Weak/no trend — contrarian
  return { score: s, detail: `ADX ${a.adx.toFixed(0)} +DI=${a.pDI.toFixed(0)} -DI=${a.nDI.toFixed(0)}${a.strong ? ' STRONG' : ''}` };
}

// 10. Williams %R
function scoreWilliamsR(candles) {
  const w = williamsR(candles);
  if (w == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (w > -20) s = -0.8; else if (w > -30) s = -0.3;
  else if (w < -80) s = 0.8; else if (w < -70) s = 0.3;
  return { score: s, detail: `%R=${w.toFixed(0)}` };
}

// 11. CCI
function scoreCCI(candles) {
  const c = cci(candles);
  if (c == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (c > 200) s = -1.2; else if (c > 100) s = -0.5;
  else if (c < -200) s = 1.2; else if (c < -100) s = 0.5;
  return { score: s, detail: `CCI ${c.toFixed(0)}` };
}

// 12. MFI
function scoreMFI(candles) {
  const m = mfi(candles);
  if (m == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (m > 80) s = -0.8; else if (m > 70) s = -0.3;
  else if (m < 20) s = 0.8; else if (m < 30) s = 0.3;
  return { score: s, detail: `MFI ${m.toFixed(0)}` };
}

// 13. Parabolic SAR
function scoreSAR(candles) {
  const p = parabolicSAR(candles);
  if (!p) return { score: 0, detail: 'N/A' };
  return { score: p.isUp ? 0.4 : -0.4, detail: `SAR ${p.isUp ? 'BULL' : 'BEAR'} @ ${p.sar.toFixed(1)}` };
}

// 14. Keltner Channels
function scoreKeltner(candles) {
  const k = keltner(candles);
  if (!k) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (k.price > k.upper) s = -0.6; // Above upper = overbought
  else if (k.price < k.lower) s = 0.6; // Below lower = oversold
  return { score: s, detail: `${k.price > k.upper ? 'Above' : k.price < k.lower ? 'Below' : 'Within'} Keltner` };
}

// 15. ROC (momentum)
function scoreROC(closes) {
  const r = roc(closes, 12);
  if (r == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (r > 8) s = -0.5; // Extended
  else if (r > 3) s = 0.3;
  else if (r > 0) s = 0.15;
  else if (r > -3) s = -0.15;
  else if (r > -8) s = -0.3;
  else s = 0.5; // Oversold bounce
  return { score: s, detail: `ROC(12) ${r > 0 ? '+' : ''}${r.toFixed(2)}%` };
}

// 16. Mean Reversion
function scoreMeanReversion(closes) {
  const s20 = sma(closes, 20);
  if (!s20) return { score: 0, detail: 'N/A' };
  const price = closes[closes.length - 1];
  const dev = ((price - s20) / s20) * 100;
  let s = 0;
  if (dev > 5) s = -2; else if (dev > 3) s = -1.2; else if (dev > 2) s = -0.6;
  else if (dev < -5) s = 2; else if (dev < -3) s = 1.2; else if (dev < -2) s = 0.6;
  return { score: s, detail: `${dev > 0 ? '+' : ''}${dev.toFixed(1)}% from SMA20` };
}

// 17. Consecutive days
function scoreConsecutive(candles) {
  if (candles.length < 10) return { score: 0, detail: 'N/A', value: 0 };
  let c = 0;
  for (let i = candles.length - 1; i > Math.max(0, candles.length - 12) && i > 0; i--) {
    const d = candles[i].c > candles[i - 1].c ? 1 : -1;
    if (c === 0) c = d;
    else if ((c > 0 && d > 0) || (c < 0 && d < 0)) c += d;
    else break;
  }
  let s = 0;
  const abs = Math.abs(c);
  if (abs >= 6) s = -Math.sign(c) * 2;
  else if (abs >= 5) s = -Math.sign(c) * 1.5;
  else if (abs >= 4) s = -Math.sign(c) * 1;
  else if (abs >= 3) s = -Math.sign(c) * 0.5;
  return { score: s, detail: `${abs} ${c > 0 ? 'up' : 'down'} days`, value: c };
}

// 18. Volume relative
function scoreVolume(candles) {
  if (candles.length < 22) return { score: 0, detail: 'N/A' };
  const avg = candles.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20;
  const last = candles[candles.length - 1].v;
  if (avg === 0) return { score: 0, detail: 'No vol' };
  const ratio = last / avg;
  const dir = candles[candles.length - 1].c >= candles[candles.length - 2]?.c ? 1 : -1;
  let s = 0;
  if (ratio > 2) s = dir * 0.6; else if (ratio > 1.5) s = dir * 0.4; else if (ratio > 1.2) s = dir * 0.2;
  else if (ratio < 0.5) s = -dir * 0.4; else if (ratio < 0.7) s = -dir * 0.2;
  return { score: s, detail: `${ratio.toFixed(1)}x avg vol` };
}

// 19. OBV trend
function scoreOBV(candles) {
  const slope = obvSlope(candles);
  if (slope == null) return { score: 0, detail: 'N/A' };
  const s = Math.max(-0.6, Math.min(0.6, slope * 5));
  return { score: s, detail: `OBV slope ${slope > 0 ? '+' : ''}${slope.toFixed(3)}` };
}

// 20. VWAP deviation
function scoreVWAP(candles) {
  const v = vwap(candles, 20);
  if (v == null) return { score: 0, detail: 'N/A' };
  const price = candles[candles.length - 1].c;
  const dev = ((price - v) / v) * 100;
  let s = 0;
  if (dev > 3) s = -0.5; else if (dev > 1) s = 0.2;
  else if (dev < -3) s = 0.5; else if (dev < -1) s = -0.2;
  return { score: s, detail: `${dev > 0 ? '+' : ''}${dev.toFixed(1)}% from VWAP` };
}

// 21. MFI divergence (price up + MFI down = bearish divergence)
function scoreMFIDivergence(candles) {
  if (candles.length < 30) return { score: 0, detail: 'N/A' };
  const mfi5 = mfi(candles.slice(0, -5));
  const mfiNow = mfi(candles);
  if (mfi5 == null || mfiNow == null) return { score: 0, detail: 'N/A' };
  const priceChg = candles[candles.length - 1].c - candles[candles.length - 6].c;
  const mfiChg = mfiNow - mfi5;
  let s = 0;
  if (priceChg > 0 && mfiChg < -10) s = -0.6; // Bearish divergence
  if (priceChg < 0 && mfiChg > 10) s = 0.6;  // Bullish divergence
  return { score: s, detail: s !== 0 ? (s > 0 ? 'Bullish' : 'Bearish') + ' MFI divergence' : 'No divergence' };
}

// 22. Fibonacci retracement position
function scoreFibonacci(candles) {
  const fib = fibonacci(candles, 60);
  if (!fib) return { score: 0, detail: 'N/A' };
  let s = 0;
  // Deep retracements near 61.8%-78.6% are potential reversal zones
  if (fib.retracement > 0.75) s = 0.8; // Near 78.6% = strong support, likely bounce
  else if (fib.retracement > 0.6) s = 0.5; // Near 61.8% = golden ratio support
  else if (fib.retracement > 0.45) s = 0.1; // Near 50% = minor support
  else if (fib.retracement < 0.1) s = -0.5; // Near highs = potential resistance
  else if (fib.retracement < 0.25) s = -0.2;
  return { score: s, detail: `Near ${fib.nearLevel} fib (${(fib.retracement * 100).toFixed(0)}% retrace)` };
}

// 23. Pivot point position
function scorePivots(candles) {
  const p = pivotPoints(candles);
  if (!p) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (p.price > p.r2) s = -0.5;
  else if (p.price > p.r1) s = -0.2;
  else if (p.price > p.pp) s = 0.15;
  else if (p.price > p.s1) s = -0.15;
  else if (p.price > p.s2) s = 0.2;
  else s = 0.5;
  return { score: s, detail: `Price ${p.price > p.pp ? 'above' : 'below'} pivot ${p.pp.toFixed(0)}` };
}

// ── INTERMARKET SCORING ─────────────────────────────────────────────────────

// 24. VIX regime + contrarian
function scoreVIX(vixCandles) {
  if (!vixCandles || vixCandles.length < 5) return { score: 0, detail: 'N/A', regime: 'unknown', vix: 0 };
  const vix = vixCandles[vixCandles.length - 1].c;
  const prev = vixCandles[vixCandles.length - 2]?.c || vix;
  const chg = ((vix - prev) / prev) * 100;
  const sma10 = sma(vixCandles.slice(-10).map(c => c.c), 10);
  let s = 0, regime = 'normal';
  if (vix > 40) { s = 1.5; regime = 'panic'; }
  else if (vix > 30) { s = 0.5; regime = 'extreme fear'; }
  else if (vix > 25) { s = -0.8; regime = 'high fear'; }
  else if (vix > 20) { s = -0.4; regime = 'elevated'; }
  else if (vix < 12) { s = -0.8; regime = 'complacent'; }
  else { regime = 'normal'; }
  if (chg > 20) s += 0.8; // Panic spike → contrarian buy
  if (chg > 10) s += 0.3;
  if (chg < -10) s -= 0.3;
  // VIX above its 10-day SMA = fear increasing
  if (sma10 && vix > sma10 * 1.1) s -= 0.3;
  if (sma10 && vix < sma10 * 0.9) s += 0.3;
  return { score: Math.max(-2, Math.min(2, s)), detail: `VIX ${vix.toFixed(1)} (${chg > 0 ? '+' : ''}${chg.toFixed(1)}%)`, regime, vix };
}

// 25. VIX term structure (VIX vs VIX3M proxy)
function scoreVIXTermStructure(vixCandles) {
  if (!vixCandles || vixCandles.length < 30) return { score: 0, detail: 'N/A' };
  // Use VIX 5d vs 20d SMA as term structure proxy
  const closes = vixCandles.map(c => c.c);
  const shortVix = sma(closes, 5);
  const longVix = sma(closes, 20);
  if (!shortVix || !longVix) return { score: 0, detail: 'N/A' };
  const ratio = shortVix / longVix;
  let s = 0;
  if (ratio > 1.15) s = 0.6; // Backwardation = panic, contrarian bullish
  else if (ratio > 1.05) s = 0.2;
  else if (ratio < 0.9) s = -0.3; // Deep contango = complacency
  else if (ratio < 0.95) s = -0.15;
  return { score: s, detail: `VIX curve ${ratio > 1 ? 'backwardation' : 'contango'} (${ratio.toFixed(2)})` };
}

// 26. Gold
function scoreGold(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (chg > 2) s = -0.8; else if (chg > 1) s = -0.4; else if (chg > 0.3) s = -0.15;
  else if (chg < -2) s = 0.5; else if (chg < -1) s = 0.3; else if (chg < -0.3) s = 0.1;
  return { score: s, detail: `Gold ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 27. Oil
function scoreOil(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (chg > 4) s = -0.6; else if (chg > 2) s = -0.2;
  else if (chg < -4) s = -0.4; else if (chg < -2) s = -0.1;
  else if (chg > 0.5) s = 0.1; else if (chg < -0.5) s = 0.1;
  return { score: s, detail: `Oil ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 28. DXY (inverse to risk)
function scoreDXY(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (chg > 0.8) s = -0.7; else if (chg > 0.4) s = -0.3; else if (chg > 0.15) s = -0.1;
  else if (chg < -0.8) s = 0.7; else if (chg < -0.4) s = 0.3; else if (chg < -0.15) s = 0.1;
  return { score: s, detail: `DXY ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 29. US 10Y yield
function scoreBond(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (chg > 4) s = -0.7; else if (chg > 2) s = -0.3;
  else if (chg < -4) s = 0.6; else if (chg < -2) s = 0.25;
  return { score: s, detail: `US10Y ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 30. Yield curve (2s10s) — recession indicator
function scoreYieldCurve(us2y, us10y) {
  if (!us2y || !us10y || us2y.length < 2 || us10y.length < 2) return { score: 0, detail: 'N/A' };
  const spread = us10y[us10y.length - 1].c - us2y[us2y.length - 1].c;
  const prevSpread = us10y[us10y.length - 2].c - us2y[us2y.length - 2].c;
  let s = 0;
  if (spread < 0) s = -0.6; // Inverted = recession warning
  else if (spread < 0.2) s = -0.2;
  else if (spread > 1) s = 0.2; // Healthy curve
  // Curve steepening/flattening
  if (spread > prevSpread + 0.05) s += 0.15; // Steepening often bullish
  if (spread < prevSpread - 0.05) s -= 0.15;
  return { score: s, detail: `2s10s spread ${spread.toFixed(2)}% (${spread > prevSpread ? 'steepening' : 'flattening'})` };
}

// 31. AUD/USD (highly correlated with ASX)
function scoreAUD(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  return { score: Math.max(-1, Math.min(1, chg * 0.4)), detail: `AUD ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 32. BTC risk proxy
function scoreBTC(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  return { score: Math.max(-0.5, Math.min(0.5, chg * 0.08)), detail: `BTC ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 33. Copper (economic bellwether)
function scoreCopper(chg) {
  if (chg == null) return { score: 0, detail: 'N/A' };
  return { score: Math.max(-0.5, Math.min(0.5, chg * 0.15)), detail: `Copper ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` };
}

// 34. Sector rotation (XLK vs XLU = risk-on vs risk-off)
function scoreSectorRotation(xlk, xlu) {
  if (!xlk || !xlu) return { score: 0, detail: 'N/A' };
  const techChg = xlk, utilChg = xlu;
  const diff = techChg - utilChg; // Positive = risk-on, negative = risk-off
  let s = Math.max(-0.6, Math.min(0.6, diff * 0.3));
  return { score: s, detail: `Tech vs Util: ${diff > 0 ? '+' : ''}${diff.toFixed(2)}% spread` };
}

// 35. Credit spread proxy (HYG vs LQD)
function scoreCreditSpread(hyg, lqd) {
  if (!hyg || !lqd) return { score: 0, detail: 'N/A' };
  const diff = hyg - lqd; // HY outperforming IG = risk-on
  let s = Math.max(-0.5, Math.min(0.5, diff * 0.4));
  return { score: s, detail: `HY-IG spread: ${diff > 0 ? '+' : ''}${diff.toFixed(2)}%` };
}

// ── STATISTICAL SCORING ─────────────────────────────────────────────────────

// 36. Z-score of returns
function scoreZScore(closes) {
  const z = zScore(closes);
  if (z == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (z > 2.5) s = -1.5; else if (z > 2) s = -1; else if (z > 1.5) s = -0.5;
  else if (z < -2.5) s = 1.5; else if (z < -2) s = 1; else if (z < -1.5) s = 0.5;
  return { score: s, detail: `Z-score ${z > 0 ? '+' : ''}${z.toFixed(2)}` };
}

// 37. Autocorrelation
function scoreAutocorrelation(closes) {
  const ac = autocorrelation(closes);
  if (ac == null) return { score: 0, detail: 'N/A' };
  // Positive AC = momentum (trend continues), Negative AC = mean reversion
  let s = 0;
  const lastRet = (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2];
  if (ac > 0.15) s = lastRet > 0 ? 0.4 : -0.4; // Momentum — continuation
  else if (ac < -0.15) s = lastRet > 0 ? -0.4 : 0.4; // Mean reversion — reversal
  return { score: s, detail: `AC(1)=${ac.toFixed(3)} → ${ac > 0.1 ? 'momentum' : ac < -0.1 ? 'mean-revert' : 'random'}` };
}

// 38. Skewness
function scoreSkewness(closes) {
  const sk = skewness(closes);
  if (sk == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  if (sk < -1) s = 0.5; // Negative skew = tail risk priced in, contrarian bullish
  else if (sk < -0.5) s = 0.2;
  else if (sk > 1) s = -0.5; // Positive skew = complacent
  else if (sk > 0.5) s = -0.2;
  return { score: s, detail: `Skew ${sk.toFixed(2)}` };
}

// 39. Kurtosis (tail thickness)
function scoreKurtosis(closes) {
  const k = kurtosis(closes);
  if (k == null) return { score: 0, detail: 'N/A' };
  let s = 0;
  // High kurtosis = fat tails = regime of extreme moves = lower confidence
  if (k > 4) s = -0.3; // Extreme tail risk
  return { score: s, detail: `Kurtosis ${k.toFixed(2)}${k > 3 ? ' (fat tails)' : ''}` };
}

// 40. Hurst exponent
function scoreHurst(closes) {
  const h = hurstExponent(closes);
  if (h == null) return { score: 0, detail: 'N/A', hurst: 0.5 };
  // H > 0.5 = trending, H < 0.5 = mean reverting
  // This doesn't give direction, but tells us WHICH model to trust
  return { score: 0, detail: `H=${h.toFixed(3)} → ${h > 0.55 ? 'trending' : h < 0.45 ? 'mean-reverting' : 'random walk'}`, hurst: h };
}

// 41. Tail risk assessment
function scoreTailRisk(closes) {
  const tr = tailRisk(closes);
  if (!tr) return { score: 0, detail: 'N/A' };
  let s = 0;
  // Asymmetric tail risk
  if (tr.left > 0.05) s = 0.3; // Many left tail events recently → likely priced in → contrarian
  if (tr.right > 0.05) s = -0.3; // Many right tail → extended
  return { score: s, detail: `Left tail ${(tr.left * 100).toFixed(1)}%, Right tail ${(tr.right * 100).toFixed(1)}%` };
}

// ── CALENDAR & SEASONAL ─────────────────────────────────────────────────────

// 42. Day of week + month + expiry
function scoreCalendar() {
  const now = new Date();
  const day = now.getUTCDay(), month = now.getUTCMonth(), date = now.getUTCDate();
  let s = 0;
  const parts = [];
  if (day === 1) { s -= 0.2; parts.push('Mon effect'); }
  if (day === 5) { s += 0.15; parts.push('Fri effect'); }
  if (month === 0) { s += 0.2; parts.push('Jan effect'); }
  if (month === 11 && date >= 15) { s += 0.25; parts.push('Santa rally'); }
  if (month >= 4 && month <= 8) { s -= 0.1; parts.push('Sell-in-May'); }
  if (month === 8) { s -= 0.2; parts.push('Sep weakness'); }
  const dim = new Date(now.getFullYear(), month + 1, 0).getDate();
  if (date >= dim - 2) { s += 0.15; parts.push('Month-end'); }
  if ((month === 2 || month === 5 || month === 8 || month === 11) && date >= dim - 3) { s += 0.1; parts.push('Qtr-end'); }
  const firstDay = new Date(now.getFullYear(), month, 1).getDay();
  const thirdFriday = 15 + ((5 - firstDay + 7) % 7);
  if (Math.abs(date - thirdFriday) <= 2) parts.push('OpEx week');
  return { score: s, detail: parts.join(', ') || 'Normal calendar' };
}

// 43. Seasonal pattern (same calendar week across years)
function scoreSeasonal(candles) {
  if (candles.length < 250) return { score: 0, detail: 'Need 1yr+' };
  const now = new Date();
  const tMonth = now.getMonth(), tDay = now.getDate();
  const nearbyRets = [];
  for (let i = 1; i < candles.length; i++) {
    const d = new Date(candles[i].t);
    if (d.getMonth() === tMonth && Math.abs(d.getDate() - tDay) <= 3) {
      nearbyRets.push(((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100);
    }
  }
  if (nearbyRets.length < 3) return { score: 0, detail: 'Insufficient seasonal data' };
  const avg = nearbyRets.reduce((a, b) => a + b, 0) / nearbyRets.length;
  const bullPct = nearbyRets.filter(r => r > 0).length / nearbyRets.length;
  return { score: Math.max(-0.5, Math.min(0.5, avg)), detail: `This week: avg ${avg > 0 ? '+' : ''}${avg.toFixed(2)}%, +ive ${(bullPct * 100).toFixed(0)}% (${nearbyRets.length} yrs)` };
}

// ── PATTERN MATCHING ────────────────────────────────────────────────────────

// 44. Historical similar-day matching (RSI + momentum + consecutive)
function scoreHistoricalMatch(candles, currentRSI, currentConsec) {
  if (candles.length < 100 || currentRSI == null) return { score: 0, detail: 'Insufficient data', matches: [], avgReturn: 0, winRate: 0 };
  const matches = [];
  for (let i = 30; i < candles.length - 1; i++) {
    const closes = candles.slice(0, i + 1).map(c => c.c);
    if (closes.length < 15) continue;
    const histRSI = rsi(closes);
    if (histRSI == null || Math.abs(histRSI - currentRSI) > 5) continue;
    let consec = 0;
    for (let j = i; j > Math.max(0, i - 8); j--) {
      const dir = candles[j].c > candles[j - 1]?.c ? 1 : -1;
      if (consec === 0) consec = dir;
      else if ((consec > 0 && dir > 0) || (consec < 0 && dir < 0)) consec += dir;
      else break;
    }
    if (Math.abs(consec - currentConsec) > 1) continue;
    const nextDayRet = ((candles[i + 1].c - candles[i].c) / candles[i].c) * 100;
    matches.push({ date: new Date(candles[i].t).toISOString().slice(0, 10), rsi: histRSI, consecutive: consec, nextDayReturn: nextDayRet });
  }
  if (matches.length < 5) return { score: 0, detail: `Only ${matches.length} matches`, matches: matches.slice(-5), avgReturn: 0, winRate: 0 };
  const avgRet = matches.reduce((a, m) => a + m.nextDayReturn, 0) / matches.length;
  const winRate = matches.filter(m => m.nextDayReturn > 0).length / matches.length;
  return { score: Math.max(-1.5, Math.min(1.5, avgRet * 2)), detail: `${matches.length} matches: avg ${avgRet > 0 ? '+' : ''}${avgRet.toFixed(2)}%, win ${(winRate * 100).toFixed(0)}%`,
    matches: matches.slice(-8), avgReturn: avgRet, winRate };
}

// 45. Gap analysis (overnight gap fill probability)
function scoreGapAnalysis(candles) {
  if (candles.length < 60) return { score: 0, detail: 'N/A' };
  // Analyze recent gaps and fill rates
  let gapUps = 0, gapDowns = 0, fillUp = 0, fillDown = 0;
  for (let i = 1; i < candles.length; i++) {
    const gap = ((candles[i].o - candles[i - 1].c) / candles[i - 1].c) * 100;
    if (gap > 0.3) { gapUps++; if (candles[i].l <= candles[i - 1].c) fillUp++; }
    else if (gap < -0.3) { gapDowns++; if (candles[i].h >= candles[i - 1].c) fillDown++; }
  }
  const totalGaps = gapUps + gapDowns;
  const fillRate = totalGaps > 0 ? ((fillUp + fillDown) / totalGaps * 100) : 50;
  // Recent gap direction
  const lastGap = ((candles[candles.length - 1].o - candles[candles.length - 2].c) / candles[candles.length - 2].c) * 100;
  let s = 0;
  if (fillRate > 65 && Math.abs(lastGap) > 0.3) s = -Math.sign(lastGap) * 0.3; // High fill rate → contrarian
  return { score: s, detail: `Gap fill rate ${fillRate.toFixed(0)}%, last gap ${lastGap > 0 ? '+' : ''}${lastGap.toFixed(2)}%` };
}

// ── ASX vs S&P relative strength ────────────────────────────────────────────
// 46. Relative strength (ASX outperforming/underperforming SPX)
function scoreRelativeStrength(asxCandles, spxCandles) {
  if (!asxCandles || !spxCandles || asxCandles.length < 20 || spxCandles.length < 20) return { score: 0, detail: 'N/A' };
  const asxRet5 = ((asxCandles[asxCandles.length - 1].c - asxCandles[asxCandles.length - 6]?.c) / (asxCandles[asxCandles.length - 6]?.c || 1)) * 100;
  const spxRet5 = ((spxCandles[spxCandles.length - 1].c - spxCandles[spxCandles.length - 6]?.c) / (spxCandles[spxCandles.length - 6]?.c || 1)) * 100;
  const relStr = asxRet5 - spxRet5;
  let s = Math.max(-0.5, Math.min(0.5, relStr * 0.1));
  return { score: s, detail: `ASX vs SPX 5d: ${relStr > 0 ? '+' : ''}${relStr.toFixed(2)}%` };
}

// ═════════════════════════════════════════════════════════════════════════════
// ENSEMBLE MODEL — 3 sub-models combined via regime-weighted voting
// ═════════════════════════════════════════════════════════════════════════════

function buildEnsemble(factors, regime) {
  // Sub-model 1: MOMENTUM (trend-following factors)
  const momentumFactors = ['Overnight Futures', 'MACD', 'EMA Alignment', 'ADX', 'Parabolic SAR', 'ROC', 'OBV Trend', 'Ichimoku'];
  // Sub-model 2: MEAN REVERSION (contrarian factors)
  const meanRevFactors = ['RSI(14)', 'RSI Weekly', 'Bollinger', 'Stochastic', 'Williams %R', 'CCI', 'MFI', 'Mean Reversion', 'Consecutive Days', 'Z-Score', 'Fibonacci'];
  // Sub-model 3: INTERMARKET (cross-asset factors)
  const interFactors = ['VIX', 'VIX Term Structure', 'Gold', 'Oil', 'DXY', 'US 10Y', 'Yield Curve', 'AUD/USD', 'BTC', 'Copper', 'Sector Rotation', 'Credit Spread'];

  function subModelScore(names) {
    const matched = factors.filter(f => names.includes(f.name));
    if (matched.length === 0) return 0;
    let totalWS = 0, totalW = 0;
    for (const f of matched) { totalWS += f.score * f.weight; totalW += f.weight; }
    return totalW > 0 ? totalWS / totalW : 0;
  }

  const momScore = subModelScore(momentumFactors);
  const mrScore = subModelScore(meanRevFactors);
  const imScore = subModelScore(interFactors);

  // Regime-adaptive weighting
  let momW = 1.0, mrW = 1.0, imW = 1.0;
  if (regime.regime === 'TRENDING') { momW = 2.0; mrW = 0.5; imW = 1.0; }
  else if (regime.regime === 'MEAN_REVERTING') { momW = 0.5; mrW = 2.0; imW = 1.0; }
  else if (regime.regime === 'VOLATILE') { momW = 0.8; mrW = 1.2; imW = 1.5; }
  else if (regime.regime === 'QUIET') { momW = 1.0; mrW = 1.5; imW = 0.8; }

  const totalWeight = momW + mrW + imW;
  const ensembleScore = (momScore * momW + mrScore * mrW + imScore * imW) / totalWeight;

  return {
    ensemble: ensembleScore,
    momentum: { score: momScore, weight: momW },
    meanReversion: { score: mrScore, weight: mrW },
    intermarket: { score: imScore, weight: imW },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ADVANCED BACKTEST — walk-forward with Sharpe, drawdown, Kelly, regime split
// ═════════════════════════════════════════════════════════════════════════════
function advancedBacktest(asxCandles) {
  if (!asxCandles || asxCandles.length < 120) return null;

  const results = [];
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  let streakWin = 0, streakLoss = 0, maxStreakWin = 0, maxStreakLoss = 0;
  const monthlyPnl = {};
  const regimeResults = { TRENDING: { w: 0, l: 0 }, MEAN_REVERTING: { w: 0, l: 0 }, VOLATILE: { w: 0, l: 0 }, QUIET: { w: 0, l: 0 }, NORMAL: { w: 0, l: 0 } };

  for (let i = 80; i < asxCandles.length - 1; i++) {
    const slice = asxCandles.slice(0, i + 1);
    const closes = slice.map(c => c.c);
    const r = rsi(closes);
    const m = macd(closes);
    const bb = bollingerBands(closes);
    const s20 = sma(closes, 20);
    const adxData = adx(slice);
    const hurst = hurstExponent(closes);

    if (r == null || !m) continue;

    // Determine regime
    let regime = 'NORMAL';
    if (adxData && adxData.adx > 30 && hurst > 0.55) regime = 'TRENDING';
    else if (adxData && adxData.adx < 20 && hurst < 0.45) regime = 'MEAN_REVERTING';

    // Multi-factor score (simplified version of live model for speed)
    let score = 0;
    // RSI
    if (r > 75) score -= 1.5; else if (r > 70) score -= 0.8; else if (r < 25) score += 1.5; else if (r < 30) score += 0.8;
    else if (r > 60) score -= 0.2; else if (r < 40) score += 0.2;
    // MACD
    score += m.hist > 0 ? 0.4 : -0.4;
    if (m.hist > m.prevHist) score += 0.2; else score -= 0.2;
    // Bollinger
    if (bb) {
      const pctB = (closes[closes.length - 1] - bb.lower) / (bb.upper - bb.lower);
      if (pctB > 0.9) score -= 0.6; else if (pctB < 0.1) score += 0.6;
    }
    // Mean reversion
    if (s20) {
      const dev = ((closes[closes.length - 1] - s20) / s20) * 100;
      if (dev > 3) score -= 0.8; else if (dev < -3) score += 0.8;
    }
    // Consecutive days
    let consec = 0;
    for (let j = i; j > Math.max(0, i - 8); j--) {
      const d = slice[j].c > slice[j - 1]?.c ? 1 : -1;
      if (consec === 0) consec = d; else if ((consec > 0 && d > 0) || (consec < 0 && d < 0)) consec += d; else break;
    }
    if (Math.abs(consec) >= 4) score -= Math.sign(consec) * 0.8;
    else if (Math.abs(consec) >= 3) score -= Math.sign(consec) * 0.4;
    // ADX direction
    if (adxData && adxData.adx > 25) {
      score += (adxData.pDI > adxData.nDI ? 0.3 : -0.3);
    }

    const predicted = score > 0.25 ? 'BULL' : score < -0.25 ? 'BEAR' : 'NEUTRAL';
    if (predicted === 'NEUTRAL') continue;

    const actualRet = ((asxCandles[i + 1].c - asxCandles[i].c) / asxCandles[i].c) * 100;
    const actual = actualRet > 0 ? 'BULL' : 'BEAR';
    const won = predicted === actual;
    const pnl = predicted === 'BULL' ? actualRet : -actualRet;

    equity *= (1 + pnl / 100);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (won) { streakWin++; streakLoss = 0; if (streakWin > maxStreakWin) maxStreakWin = streakWin; }
    else { streakLoss++; streakWin = 0; if (streakLoss > maxStreakLoss) maxStreakLoss = streakLoss; }

    const monthKey = new Date(asxCandles[i].t).toISOString().slice(0, 7);
    if (!monthlyPnl[monthKey]) monthlyPnl[monthKey] = { pnl: 0, trades: 0, wins: 0 };
    monthlyPnl[monthKey].pnl += pnl;
    monthlyPnl[monthKey].trades++;
    if (won) monthlyPnl[monthKey].wins++;

    if (regimeResults[regime]) { if (won) regimeResults[regime].w++; else regimeResults[regime].l++; }

    results.push({ date: new Date(asxCandles[i].t).toISOString().slice(0, 10), predicted, actual, return: +actualRet.toFixed(3), pnl: +pnl.toFixed(3), won });
  }

  if (results.length < 10) return null;

  const wins = results.filter(r => r.won).length;
  const losses = results.length - wins;
  const accuracy = (wins / results.length) * 100;
  const pnlArr = results.map(r => r.pnl);
  const avgPnl = pnlArr.reduce((a, b) => a + b, 0) / pnlArr.length;
  const stdPnl = Math.sqrt(pnlArr.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / pnlArr.length);
  const sharpe = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(252) : 0;
  const avgWin = pnlArr.filter(p => p > 0).reduce((a, b) => a + b, 0) / (wins || 1);
  const avgLoss = Math.abs(pnlArr.filter(p => p < 0).reduce((a, b) => a + b, 0) / (losses || 1));
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : 99;
  const winRate = wins / results.length;
  const kelly = avgLoss > 0 ? (winRate - (1 - winRate) / (avgWin / avgLoss)) * 100 : 0;

  // Regime accuracy
  const regimeAcc = {};
  for (const [regime, data] of Object.entries(regimeResults)) {
    const total = data.w + data.l;
    if (total > 0) regimeAcc[regime] = { accuracy: ((data.w / total) * 100).toFixed(1), total };
  }

  return {
    accuracy: accuracy.toFixed(1),
    total: results.length,
    wins, losses,
    avgReturn: avgPnl.toFixed(3),
    cumulativeReturn: ((equity - 100)).toFixed(2),
    finalEquity: equity.toFixed(2),
    sharpeRatio: sharpe.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    kellyPct: kelly.toFixed(1),
    avgWin: avgWin.toFixed(3),
    avgLoss: avgLoss.toFixed(3),
    maxStreakWin, maxStreakLoss,
    monthlyPnl,
    regimeAccuracy: regimeAcc,
    recentResults: results.slice(-30),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER
// ═════════════════════════════════════════════════════════════════════════════
function latestChange(candles) {
  if (!candles || candles.length < 2) return null;
  return ((candles[candles.length - 1].c - candles[candles.length - 2].c) / candles[candles.length - 2].c) * 100;
}

// ═════════════════════════════════════════════════════════════════════════════
// WALK-FORWARD WEIGHT OPTIMIZATION — auto-tunes factor weights from history
// ═════════════════════════════════════════════════════════════════════════════
// For each factor, measure its correlation with next-day returns over the last
// N days. Factors that have been more predictive recently get higher weights.
// This replaces hand-tuned weights with statistically validated ones.

function optimizeWeights(asxCandles, factorScoreFns, lookback = 120) {
  if (!asxCandles || asxCandles.length < lookback + 30) return null;

  const optimized = {};
  const closes = asxCandles.map(c => c.c);

  // For each factor, compute its score at each historical point and correlate
  // with next-day return
  for (const [name, scoreFn] of Object.entries(factorScoreFns)) {
    const scores = [];
    const nextDayRets = [];

    for (let i = Math.max(30, asxCandles.length - lookback); i < asxCandles.length - 1; i++) {
      try {
        const slice = asxCandles.slice(0, i + 1);
        const sliceCloses = slice.map(c => c.c);
        const result = scoreFn(slice, sliceCloses);
        if (result != null && !isNaN(result)) {
          scores.push(result);
          nextDayRets.push((asxCandles[i + 1].c - asxCandles[i].c) / asxCandles[i].c);
        }
      } catch (e) { /* skip */ }
    }

    if (scores.length < 20) { optimized[name] = 1.0; continue; }

    // Pearson correlation
    const n = scores.length;
    const meanS = scores.reduce((a, b) => a + b, 0) / n;
    const meanR = nextDayRets.reduce((a, b) => a + b, 0) / n;
    let num = 0, denS = 0, denR = 0;
    for (let i = 0; i < n; i++) {
      const ds = scores[i] - meanS, dr = nextDayRets[i] - meanR;
      num += ds * dr; denS += ds * ds; denR += dr * dr;
    }
    const corr = (denS > 0 && denR > 0) ? num / Math.sqrt(denS * denR) : 0;

    // Information Coefficient → weight multiplier
    // IC > 0.05 is useful, > 0.1 is strong, > 0.15 is exceptional
    const absCorr = Math.abs(corr);
    let multiplier = 1.0;
    if (absCorr > 0.15) multiplier = 2.5;
    else if (absCorr > 0.1) multiplier = 2.0;
    else if (absCorr > 0.07) multiplier = 1.5;
    else if (absCorr > 0.04) multiplier = 1.2;
    else if (absCorr < 0.02) multiplier = 0.5; // Noise — downweight
    else if (absCorr < 0.01) multiplier = 0.2;

    // If correlation is negative (factor is inverse predictor), flip it
    if (corr < -0.04) multiplier *= -1;

    optimized[name] = { multiplier, ic: corr, samples: n };
  }

  return optimized;
}

// Quick factor scoring functions for optimization (simplified versions)
function _optRSI(slice, closes) { const r = rsi(closes); return r != null ? (r > 70 ? -1 : r < 30 ? 1 : r > 55 ? 0.2 : r < 45 ? -0.2 : 0) : null; }
function _optMACD(slice, closes) { const m = macd(closes); return m ? (m.hist > 0 ? 0.5 : -0.5) + (m.hist > m.prevHist ? 0.3 : -0.3) : null; }
function _optBB(slice, closes) { const bb = bollingerBands(closes); if (!bb) return null; const p = (closes[closes.length-1]-bb.lower)/(bb.upper-bb.lower); return p > 0.9 ? -1 : p < 0.1 ? 1 : 0; }
function _optMeanRev(slice, closes) { const s = sma(closes, 20); if (!s) return null; const d = ((closes[closes.length-1]-s)/s)*100; return d > 3 ? -1 : d < -3 ? 1 : 0; }
function _optConsec(slice) {
  let c = 0;
  for (let i = slice.length-1; i > Math.max(0,slice.length-8) && i > 0; i--) {
    const d = slice[i].c > slice[i-1].c ? 1 : -1;
    if (c === 0) c = d; else if ((c>0&&d>0)||(c<0&&d<0)) c += d; else break;
  }
  return Math.abs(c) >= 3 ? -Math.sign(c) : 0;
}
function _optADX(slice) { const a = adx(slice); return a ? (a.pDI > a.nDI ? 1 : -1) * (a.adx > 25 ? 0.5 : 0.2) : null; }
function _optStoch(slice) { const s = stochastic(slice); return s ? (s.k > 80 ? -0.8 : s.k < 20 ? 0.8 : 0) : null; }
function _optCCI(slice) { const c = cci(slice); return c != null ? (c > 100 ? -0.5 : c < -100 ? 0.5 : 0) : null; }
function _optMFI(slice) { const m = mfi(slice); return m != null ? (m > 80 ? -0.6 : m < 20 ? 0.6 : 0) : null; }
function _optVolume(slice) {
  if (slice.length < 22) return null;
  const avg = slice.slice(-21,-1).reduce((a,c)=>a+c.v,0)/20;
  const last = slice[slice.length-1].v;
  if (avg === 0) return null;
  const ratio = last / avg;
  const dir = slice[slice.length-1].c >= slice[slice.length-2]?.c ? 1 : -1;
  return ratio > 1.5 ? dir * 0.4 : ratio < 0.5 ? -dir * 0.3 : 0;
}

const OPT_FACTORS = {
  RSI: _optRSI, MACD: _optMACD, Bollinger: _optBB, MeanReversion: _optMeanRev,
  Consecutive: _optConsec, ADX: _optADX, Stochastic: _optStoch, CCI: _optCCI,
  MFI: _optMFI, Volume: _optVolume
};

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE INTERACTIONS — compound signals that capture non-linear relationships
// ═════════════════════════════════════════════════════════════════════════════

function computeFeatureInteractions(tech, regime, im) {
  const interactions = [];

  // 1. RSI × VIX: Oversold RSI during VIX panic = strongest buy signal
  if (tech.rsi != null && im.vix != null) {
    let s = 0;
    if (tech.rsi < 30 && im.vix > 30) s = 2.0;       // Oversold + panic = BUY
    else if (tech.rsi < 35 && im.vix > 25) s = 1.2;
    else if (tech.rsi > 75 && im.vix < 14) s = -1.5;  // Overbought + complacent = SELL
    else if (tech.rsi > 70 && im.vix < 16) s = -0.8;
    if (s !== 0) interactions.push({ name: 'RSI × VIX', score: s, weight: 2.0, detail: `RSI ${tech.rsi.toFixed(0)} + VIX ${im.vix.toFixed(1)}`, cat: 'interaction' });
  }

  // 2. MACD × ADX: MACD crossover in strong trend = high conviction
  if (tech.macd && tech.adx) {
    let s = 0;
    if (tech.macd.hist > 0 && tech.adx.adx > 30 && tech.adx.pDI > tech.adx.nDI) s = 1.0;
    if (tech.macd.hist < 0 && tech.adx.adx > 30 && tech.adx.nDI > tech.adx.pDI) s = -1.0;
    if (tech.adx.adx < 20 && Math.abs(tech.macd.hist) > 0) s *= 0.3; // Weak trend = ignore MACD
    if (s !== 0) interactions.push({ name: 'MACD × ADX', score: s, weight: 1.5, detail: `MACD ${tech.macd.hist > 0 ? '+' : ''}${tech.macd.hist.toFixed(1)} in ADX ${tech.adx.adx.toFixed(0)}`, cat: 'interaction' });
  }

  // 3. Bollinger Squeeze × Volume: Squeeze + rising volume = breakout imminent
  if (tech.bollingerWidth != null && tech.atrPctile != null) {
    let s = 0;
    if (tech.bollingerWidth < 2 && tech.atrPctile < 20) {
      // Squeeze detected — direction from other signals
      s = 0; // Neutral but flag it — breakout direction unknown
      interactions.push({ name: 'BB Squeeze', score: 0, weight: 0.5, detail: `Squeeze! BW=${tech.bollingerWidth}%, ATR P${tech.atrPctile}`, cat: 'interaction' });
    }
  }

  // 4. Mean Reversion × Hurst: Mean reversion signal when Hurst confirms MR regime
  if (tech.zScore != null && tech.hurst != null) {
    let s = 0;
    if (tech.hurst < 0.45 && Math.abs(tech.zScore) > 1.5) {
      // Mean-reverting regime + extreme z-score = strong contrarian
      s = tech.zScore > 0 ? -1.5 : 1.5;
      interactions.push({ name: 'Z × Hurst MR', score: s, weight: 2.0, detail: `Z=${tech.zScore.toFixed(1)} in H=${tech.hurst.toFixed(2)} regime`, cat: 'interaction' });
    }
    if (tech.hurst > 0.55 && tech.macd && tech.macd.accel) {
      // Trending regime + MACD accelerating = ride the trend
      s = tech.macd.hist > 0 ? 1.0 : -1.0;
      interactions.push({ name: 'Trend × MACD Accel', score: s, weight: 1.8, detail: `H=${tech.hurst.toFixed(2)} trending + MACD accel`, cat: 'interaction' });
    }
  }

  // 5. Futures × AUD: When futures and AUD align, signal is stronger for ASX
  if (im.nq != null && im.aud != null) {
    const futDir = ((im.nq || 0) * 0.5 + (im.es || 0) * 0.5) > 0 ? 1 : -1;
    const audDir = im.aud > 0 ? 1 : -1;
    if (futDir === audDir && Math.abs(im.nq || 0) > 0.5) {
      const s = futDir * 0.8;
      interactions.push({ name: 'Futures × AUD', score: s, weight: 1.5, detail: `Futures & AUD aligned ${futDir > 0 ? 'bullish' : 'bearish'}`, cat: 'interaction' });
    }
  }

  // 6. Gold × DXY: Gold up + DXY up = unusual (flight to safety from all risk)
  if (im.gold != null && im.dxy != null) {
    if (im.gold > 0.5 && im.dxy > 0.3) {
      interactions.push({ name: 'Gold × DXY Panic', score: -1.2, weight: 1.5, detail: `Gold AND USD both up — extreme risk-off`, cat: 'interaction' });
    }
  }

  // 7. Ichimoku × EMA: Full trend confluence
  if (tech.ichimoku && tech.emaAlignment) {
    const ichBull = tech.ichimoku.aboveCloud && tech.ichimoku.tkCross === 'bullish';
    const ichBear = !tech.ichimoku.aboveCloud && tech.ichimoku.tkCross === 'bearish';
    const emaBull = (tech.emaAlignment || '').includes('BULL');
    const emaBear = (tech.emaAlignment || '').includes('BEAR');
    if (ichBull && emaBull) interactions.push({ name: 'Ichi × EMA Bull', score: 1.0, weight: 1.3, detail: 'Full trend alignment bullish', cat: 'interaction' });
    if (ichBear && emaBear) interactions.push({ name: 'Ichi × EMA Bear', score: -1.0, weight: 1.3, detail: 'Full trend alignment bearish', cat: 'interaction' });
  }

  // 8. Stochastic × RSI divergence: Both oversold/overbought = stronger signal
  if (tech.rsi != null && tech.stochastic) {
    if (tech.rsi < 30 && tech.stochastic.k < 20) {
      interactions.push({ name: 'RSI × Stoch OS', score: 1.5, weight: 1.5, detail: `Both deeply oversold: RSI ${tech.rsi.toFixed(0)}, Stoch ${tech.stochastic.k.toFixed(0)}`, cat: 'interaction' });
    }
    if (tech.rsi > 70 && tech.stochastic.k > 80) {
      interactions.push({ name: 'RSI × Stoch OB', score: -1.5, weight: 1.5, detail: `Both deeply overbought: RSI ${tech.rsi.toFixed(0)}, Stoch ${tech.stochastic.k.toFixed(0)}`, cat: 'interaction' });
    }
  }

  // 9. Yield curve × VIX: Inverted curve + VIX spike = recession panic
  if (tech.yieldCurveSpread != null && im.vix != null) {
    if (tech.yieldCurveSpread < 0 && im.vix > 25) {
      interactions.push({ name: 'Curve × VIX Crisis', score: -1.5, weight: 2.0, detail: `Inverted curve + VIX ${im.vix.toFixed(0)} = recession risk`, cat: 'interaction' });
    }
  }

  // 10. Consecutive × Volume: Many consecutive days + declining volume = exhaustion
  if (tech.consecutiveDays != null) {
    const abs = Math.abs(tech.consecutiveDays);
    if (abs >= 4) {
      interactions.push({ name: 'Consec Exhaustion', score: -Math.sign(tech.consecutiveDays) * 1.2, weight: 1.5, detail: `${abs} ${tech.consecutiveDays > 0 ? 'up' : 'down'} days — exhaustion likely`, cat: 'interaction' });
    }
  }

  return interactions;
}

// ═════════════════════════════════════════════════════════════════════════════
// MONTE CARLO SIMULATION — probabilistic range estimation
// ═════════════════════════════════════════════════════════════════════════════

function monteCarloRange(closes, atrVal, nSim = 2000) {
  if (closes.length < 30) return null;
  const rets = [];
  for (let i = closes.length - 60; i < closes.length; i++) {
    if (i > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 20) return null;

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sk = rets.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / rets.length;
  const lastPrice = closes[closes.length - 1];

  // Simulate next-day returns with skew-adjusted normal distribution
  const simReturns = [];
  for (let i = 0; i < nSim; i++) {
    // Box-Muller for normal random
    const u1 = Math.random(), u2 = Math.random();
    let z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    // Apply skewness correction (Cornish-Fisher)
    z = z + (z * z - 1) * sk / 6;
    const simRet = mean + std * z;
    simReturns.push(lastPrice * (1 + simRet));
  }

  simReturns.sort((a, b) => a - b);

  return {
    p5: +simReturns[Math.floor(nSim * 0.05)].toFixed(1),
    p10: +simReturns[Math.floor(nSim * 0.10)].toFixed(1),
    p25: +simReturns[Math.floor(nSim * 0.25)].toFixed(1),
    p50: +simReturns[Math.floor(nSim * 0.50)].toFixed(1),
    p75: +simReturns[Math.floor(nSim * 0.75)].toFixed(1),
    p90: +simReturns[Math.floor(nSim * 0.90)].toFixed(1),
    p95: +simReturns[Math.floor(nSim * 0.95)].toFixed(1),
    bullProb: +(simReturns.filter(p => p > lastPrice).length / nSim * 100).toFixed(1),
    bearProb: +(simReturns.filter(p => p < lastPrice).length / nSim * 100).toFixed(1),
    expectedValue: +(simReturns.reduce((a, b) => a + b, 0) / nSim).toFixed(1),
    simulations: nSim,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROLLING CORRELATION MATRIX — detect regime shifts via correlation breakdown
// ═════════════════════════════════════════════════════════════════════════════

function rollingCorrelation(series1, series2, window = 30) {
  if (!series1 || !series2) return null;
  const minLen = Math.min(series1.length, series2.length);
  if (minLen < window + 1) return null;

  const r1 = [], r2 = [];
  for (let i = 1; i < minLen; i++) {
    r1.push((series1[series1.length - minLen + i].c - series1[series1.length - minLen + i - 1].c) / series1[series1.length - minLen + i - 1].c);
    r2.push((series2[series2.length - minLen + i].c - series2[series2.length - minLen + i - 1].c) / series2[series2.length - minLen + i - 1].c);
  }

  // Last 30-day correlation
  const s1 = r1.slice(-window), s2 = r2.slice(-window);
  const m1 = s1.reduce((a, b) => a + b, 0) / window;
  const m2 = s2.reduce((a, b) => a + b, 0) / window;
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < window; i++) {
    num += (s1[i] - m1) * (s2[i] - m2);
    d1 += (s1[i] - m1) ** 2;
    d2 += (s2[i] - m2) ** 2;
  }
  const corr = (d1 > 0 && d2 > 0) ? num / Math.sqrt(d1 * d2) : 0;

  // Previous 30-day correlation (for change detection)
  if (r1.length < window * 2) return { current: +corr.toFixed(3), previous: null, change: null };
  const p1 = r1.slice(-window * 2, -window), p2 = r2.slice(-window * 2, -window);
  const pm1 = p1.reduce((a, b) => a + b, 0) / window;
  const pm2 = p2.reduce((a, b) => a + b, 0) / window;
  let pnum = 0, pd1 = 0, pd2 = 0;
  for (let i = 0; i < window; i++) {
    pnum += (p1[i] - pm1) * (p2[i] - pm2);
    pd1 += (p1[i] - pm1) ** 2;
    pd2 += (p2[i] - pm2) ** 2;
  }
  const prevCorr = (pd1 > 0 && pd2 > 0) ? pnum / Math.sqrt(pd1 * pd2) : 0;

  return { current: +corr.toFixed(3), previous: +prevCorr.toFixed(3), change: +(corr - prevCorr).toFixed(3) };
}

function buildCorrelationMatrix(asxHist, spxData, goldData, vixData, audData) {
  const pairs = {};
  if (spxData) pairs['ASX-SPX'] = rollingCorrelation(asxHist, spxData);
  if (goldData) pairs['ASX-Gold'] = rollingCorrelation(asxHist, goldData);
  if (vixData) pairs['ASX-VIX'] = rollingCorrelation(asxHist, vixData);
  if (audData) pairs['ASX-AUD'] = rollingCorrelation(asxHist, audData);

  // Detect correlation breakdown (regime shift signal)
  let breakdownAlert = false;
  let breakdownDetail = '';
  for (const [pair, data] of Object.entries(pairs)) {
    if (data && data.change != null && Math.abs(data.change) > 0.3) {
      breakdownAlert = true;
      breakdownDetail += `${pair} shifted ${data.change > 0 ? '+' : ''}${data.change} `;
    }
  }

  return { pairs, breakdownAlert, breakdownDetail: breakdownDetail.trim() };
}

// ═════════════════════════════════════════════════════════════════════════════
// ASX SECTOR ANALYSIS — individual sector scoring
// ═════════════════════════════════════════════════════════════════════════════

function scoreSectors(sectorData) {
  const sectors = [];
  for (const [name, candles] of Object.entries(sectorData)) {
    if (!candles || candles.length < 20) continue;
    const closes = candles.map(c => c.c);
    const r = rsi(closes);
    const chg1d = latestChange(candles);
    const chg5d = closes.length >= 6 ? ((closes[closes.length-1] - closes[closes.length-6]) / closes[closes.length-6]) * 100 : null;

    let momentum = 0;
    if (chg1d != null) momentum += chg1d > 0 ? 0.3 : -0.3;
    if (chg5d != null) momentum += chg5d > 1 ? 0.3 : chg5d < -1 ? -0.3 : 0;
    if (r != null) momentum += r > 60 ? 0.2 : r < 40 ? -0.2 : 0;

    sectors.push({
      name,
      chg1d: chg1d != null ? +chg1d.toFixed(2) : null,
      chg5d: chg5d != null ? +chg5d.toFixed(2) : null,
      rsi: r != null ? +r.toFixed(1) : null,
      momentum: +momentum.toFixed(2),
    });
  }

  // Overall sector breadth: how many sectors are positive
  const positive = sectors.filter(s => s.chg1d > 0).length;
  const total = sectors.filter(s => s.chg1d != null).length;
  const breadth = total > 0 ? positive / total : 0.5;

  // Sector rotation signal: defensive sectors outperforming = risk-off
  const miners = sectors.find(s => s.name === 'Miners');
  const banks = sectors.find(s => s.name === 'Banks');
  const energy = sectors.find(s => s.name === 'Energy');

  let rotationScore = 0;
  // ASX is heavily weighted to miners + banks
  if (miners && miners.momentum > 0.3) rotationScore += 0.4;
  if (miners && miners.momentum < -0.3) rotationScore -= 0.4;
  if (banks && banks.momentum > 0.3) rotationScore += 0.3;
  if (banks && banks.momentum < -0.3) rotationScore -= 0.3;

  return {
    sectors,
    breadth: +(breadth * 100).toFixed(0),
    rotationScore: +rotationScore.toFixed(2),
    detail: `Breadth ${(breadth * 100).toFixed(0)}% (${positive}/${total} sectors +ive)`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ADAPTIVE THRESHOLDS — regime-aware decision boundaries
// ═════════════════════════════════════════════════════════════════════════════

function adaptiveThresholds(regime, atrPctile) {
  // In volatile regimes, require stronger signal to call BULL/BEAR
  // In quiet regimes, smaller signals are meaningful
  let bullThreshold = 0.12;
  let bearThreshold = -0.12;

  if (regime === 'VOLATILE') { bullThreshold = 0.20; bearThreshold = -0.20; }
  else if (regime === 'QUIET') { bullThreshold = 0.08; bearThreshold = -0.08; }
  else if (regime === 'TRENDING') { bullThreshold = 0.10; bearThreshold = -0.10; }
  else if (regime === 'MEAN_REVERTING') { bullThreshold = 0.15; bearThreshold = -0.15; }

  // Further adjust by ATR percentile
  if (atrPctile > 90) { bullThreshold += 0.05; bearThreshold -= 0.05; }
  if (atrPctile < 10) { bullThreshold -= 0.03; bearThreshold += 0.03; }

  return { bullThreshold, bearThreshold };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROLLING ACCURACY — how the model performed in recent windows
// ═════════════════════════════════════════════════════════════════════════════

function rollingAccuracyWindows(backtestResults) {
  if (!backtestResults || !backtestResults.length) return null;

  function windowAcc(results, n) {
    const window = results.slice(-n);
    if (window.length < n) return null;
    const wins = window.filter(r => r.won).length;
    return { accuracy: +((wins / window.length) * 100).toFixed(1), total: window.length, wins };
  }

  return {
    last5: windowAcc(backtestResults, 5),
    last10: windowAcc(backtestResults, 10),
    last20: windowAcc(backtestResults, 20),
    last50: windowAcc(backtestResults, 50),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SIGNAL CONFIDENCE — meta-analysis of signal quality
// ═════════════════════════════════════════════════════════════════════════════

function signalConfidenceAnalysis(factors, ensemble, regime, rollingAcc, monteCarlo) {
  let confidence = 40;
  const notes = [];

  // Factor agreement
  const bullF = factors.filter(f => f.score > 0.1).length;
  const bearF = factors.filter(f => f.score < -0.1).length;
  const totalScoredF = bullF + bearF;
  const agreement = totalScoredF > 0 ? Math.abs(bullF - bearF) / totalScoredF : 0;
  confidence += agreement * 25;
  if (agreement > 0.6) notes.push('Strong factor consensus');
  if (agreement < 0.2) notes.push('Factors disagree — low conviction');

  // Ensemble sub-model agreement
  if (ensemble) {
    const momDir = ensemble.momentum?.score > 0 ? 1 : -1;
    const mrDir = ensemble.meanReversion?.score > 0 ? 1 : -1;
    const imDir = ensemble.intermarket?.score > 0 ? 1 : -1;
    const subAgreement = (momDir === mrDir ? 1 : 0) + (momDir === imDir ? 1 : 0) + (mrDir === imDir ? 1 : 0);
    if (subAgreement === 3) { confidence += 10; notes.push('All 3 sub-models agree'); }
    else if (subAgreement === 0) { confidence -= 10; notes.push('Sub-models completely split'); }
  }

  // Regime confidence
  if (regime) {
    confidence += (regime.confidence || 0.5) * 8;
    if (regime.type === 'VOLATILE') { confidence -= 8; notes.push('Volatile regime — lower conviction'); }
  }

  // Rolling accuracy trend
  if (rollingAcc) {
    if (rollingAcc.last10 && rollingAcc.last10.accuracy >= 70) { confidence += 8; notes.push('Model hot — 70%+ recent accuracy'); }
    if (rollingAcc.last10 && rollingAcc.last10.accuracy < 40) { confidence -= 10; notes.push('Model cold — below 40% recent'); }
  }

  // Monte Carlo alignment
  if (monteCarlo) {
    const bullProb = monteCarlo.bullProb;
    if (bullProb > 60 || bullProb < 40) confidence += 5;
    notes.push(`MC: ${bullProb}% bull probability`);
  }

  return { confidence: Math.min(95, Math.max(25, confidence)), notes };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    // ── Fetch everything in parallel (24 assets) ──────────────────────
    const [
      asxHist, xsoHist, xecHist,
      nqData, esData, ymData,
      vixData, goldData, oilData, dxyData, bondData, audData, btcData, copperData,
      us2yData, spxData, xlkData, xluData,
      // ASX sector ETFs
      asxMiners, asxBanks, asxEnergy, asxTech,
      // Credit spread proxies
      hygData, lqdData,
    ] = await Promise.all([
      safeYahoo('^AXJO', '2y', '1d'),
      safeYahoo('^AXSO', '2y', '1d'),
      safeYahoo('^AXEC', '1y', '1d'),
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
      safeYahoo('HG=F', '5d', '1d'),
      safeYahoo('^IRX', '5d', '1d'),
      safeYahoo('^GSPC', '3mo', '1d'),
      safeYahoo('XLK', '5d', '1d'),
      safeYahoo('XLU', '5d', '1d'),
      // ASX sectors
      safeYahoo('^AXMJ', '1mo', '1d'),  // ASX Materials/Miners
      safeYahoo('^AXFJ', '1mo', '1d'),  // ASX Financials/Banks
      safeYahoo('^AXEJ', '1mo', '1d'),  // ASX Energy
      safeYahoo('^AXIJ', '1mo', '1d'),  // ASX Info Tech
      // Credit
      safeYahoo('HYG', '5d', '1d'),     // High Yield Corp
      safeYahoo('LQD', '5d', '1d'),     // Investment Grade Corp
    ]);

    if (!asxHist || asxHist.length < 100) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Insufficient ASX data' }) };
    }

    const closes = asxHist.map(c => c.c);
    const lastPrice = closes[closes.length - 1];

    // Changes
    const nqChg = latestChange(nqData), esChg = latestChange(esData), ymChg = latestChange(ymData);
    const goldChg = latestChange(goldData), oilChg = latestChange(oilData), dxyChg = latestChange(dxyData);
    const bondChg = latestChange(bondData), audChg = latestChange(audData), btcChg = latestChange(btcData);
    const copperChg = latestChange(copperData), xlkChg = latestChange(xlkData), xluChg = latestChange(xluData);
    const hygChg = latestChange(hygData), lqdChg = latestChange(lqdData);

    // Calculate all technicals
    const rsiVal = rsi(closes);
    const macdVal = macd(closes);
    const atrVal = atr(asxHist);
    const stochVal = stochastic(asxHist);
    const adxVal = adx(asxHist);
    const ichVal = ichimoku(asxHist);
    const sarVal = parabolicSAR(asxHist);
    const cciVal = cci(asxHist);
    const mfiVal = mfi(asxHist);
    const wRVal = williamsR(asxHist);
    const rocVal = roc(closes, 12);
    const fibVal = fibonacci(asxHist, 60);
    const pivotVal = pivotPoints(asxHist);
    const bbVal = bollingerBands(closes);
    const hurstVal = hurstExponent(closes);
    const zVal = zScore(closes);
    const acVal = autocorrelation(closes);
    const skewVal = skewness(closes);
    const kurtVal = kurtosis(closes);
    const vwapVal = vwap(asxHist, 20);

    // SuperTrend (daily + weekly multi-timeframe)
    const stResult = scoreSuperTrend(asxHist);

    // Detect regime
    const regime = detectRegime(asxHist, closes);

    // Consecutive days
    const consecData = scoreConsecutive(asxHist);

    // ── Score ALL factors ─────────────────────────────────────────────
    // Category weights vary by regime
    const RW = {
      TRENDING:       { price: 1.0, trend: 1.8, volume: 1.0, inter: 1.0, stat: 0.6, cal: 0.4, pattern: 0.8 },
      MEAN_REVERTING: { price: 1.5, trend: 0.5, volume: 0.8, inter: 1.0, stat: 1.2, cal: 0.5, pattern: 1.2 },
      VOLATILE:       { price: 1.0, trend: 0.8, volume: 1.2, inter: 1.5, stat: 1.0, cal: 0.3, pattern: 0.8 },
      QUIET:          { price: 1.2, trend: 1.0, volume: 0.6, inter: 0.8, stat: 1.0, cal: 0.6, pattern: 1.0 },
      NORMAL:         { price: 1.0, trend: 1.0, volume: 1.0, inter: 1.0, stat: 1.0, cal: 0.5, pattern: 1.0 },
    };
    const rw = RW[regime.regime] || RW.NORMAL;

    const factors = [];

    // PRICE ACTION (12 factors)
    factors.push({ name: 'Overnight Futures', cat: 'inter', weight: 3.5 * rw.inter, ...scoreFutures(nqChg, esChg, ymChg) });
    factors.push({ name: 'RSI(14)', cat: 'price', weight: 1.2 * rw.price, ...scoreRSI(rsiVal) });
    factors.push({ name: 'RSI Weekly', cat: 'price', weight: 0.8 * rw.price, ...scoreRSIWeekly(asxHist) });
    factors.push({ name: 'MACD', cat: 'trend', weight: 1.0 * rw.trend, ...scoreMACD(macdVal) });
    factors.push({ name: 'EMA Alignment', cat: 'trend', weight: 1.4 * rw.trend, ...scoreEMA(closes) });
    factors.push({ name: 'Bollinger', cat: 'price', weight: 0.9 * rw.price, ...scoreBollinger(closes) });
    factors.push({ name: 'Stochastic', cat: 'price', weight: 0.7 * rw.price, ...scoreStoch(asxHist) });
    factors.push({ name: 'Ichimoku', cat: 'trend', weight: 1.0 * rw.trend, ...scoreIchimoku(asxHist) });
    factors.push({ name: 'ADX', cat: 'trend', weight: 0.8 * rw.trend, ...scoreADX(asxHist) });
    factors.push({ name: 'Williams %R', cat: 'price', weight: 0.5 * rw.price, ...scoreWilliamsR(asxHist) });
    factors.push({ name: 'CCI', cat: 'price', weight: 0.6 * rw.price, ...scoreCCI(asxHist) });
    factors.push({ name: 'MFI', cat: 'price', weight: 0.7 * rw.price, ...scoreMFI(asxHist) });
    factors.push({ name: 'Parabolic SAR', cat: 'trend', weight: 0.5 * rw.trend, ...scoreSAR(asxHist) });
    factors.push({ name: 'Keltner', cat: 'price', weight: 0.5 * rw.price, ...scoreKeltner(asxHist) });
    factors.push({ name: 'ROC', cat: 'trend', weight: 0.6 * rw.trend, ...scoreROC(closes) });

    // SUPERTREND (multi-timeframe: daily + weekly)
    factors.push({ name: 'SuperTrend MTF', cat: 'trend', weight: 1.5 * rw.trend, score: stResult.score, detail: stResult.detail });

    // TREND & STRUCTURE
    factors.push({ name: 'Mean Reversion', cat: 'price', weight: 1.6 * rw.price, ...scoreMeanReversion(closes) });
    factors.push({ name: 'Consecutive Days', cat: 'pattern', weight: 1.3 * rw.pattern, ...consecData });
    factors.push({ name: 'Fibonacci', cat: 'trend', weight: 0.7 * rw.trend, ...scoreFibonacci(asxHist) });
    factors.push({ name: 'Pivot Points', cat: 'trend', weight: 0.5 * rw.trend, ...scorePivots(asxHist) });

    // VOLUME & FLOW
    factors.push({ name: 'Volume', cat: 'volume', weight: 0.6 * rw.volume, ...scoreVolume(asxHist) });
    factors.push({ name: 'OBV Trend', cat: 'volume', weight: 0.5 * rw.volume, ...scoreOBV(asxHist) });
    factors.push({ name: 'VWAP Dev', cat: 'volume', weight: 0.5 * rw.volume, ...scoreVWAP(asxHist) });
    factors.push({ name: 'MFI Divergence', cat: 'volume', weight: 0.7 * rw.volume, ...scoreMFIDivergence(asxHist) });

    // INTERMARKET
    factors.push({ name: 'VIX', cat: 'inter', weight: 1.2 * rw.inter, ...scoreVIX(vixData) });
    factors.push({ name: 'VIX Term Structure', cat: 'inter', weight: 0.6 * rw.inter, ...scoreVIXTermStructure(vixData) });
    factors.push({ name: 'Gold', cat: 'inter', weight: 0.7 * rw.inter, ...scoreGold(goldChg) });
    factors.push({ name: 'Oil', cat: 'inter', weight: 0.5 * rw.inter, ...scoreOil(oilChg) });
    factors.push({ name: 'DXY', cat: 'inter', weight: 0.8 * rw.inter, ...scoreDXY(dxyChg) });
    factors.push({ name: 'US 10Y', cat: 'inter', weight: 0.7 * rw.inter, ...scoreBond(bondChg) });
    factors.push({ name: 'Yield Curve', cat: 'inter', weight: 0.6 * rw.inter, ...scoreYieldCurve(us2yData, bondData) });
    factors.push({ name: 'AUD/USD', cat: 'inter', weight: 0.9 * rw.inter, ...scoreAUD(audChg) });
    factors.push({ name: 'BTC', cat: 'inter', weight: 0.3 * rw.inter, ...scoreBTC(btcChg) });
    factors.push({ name: 'Copper', cat: 'inter', weight: 0.5 * rw.inter, ...scoreCopper(copperChg) });
    factors.push({ name: 'Sector Rotation', cat: 'inter', weight: 0.5 * rw.inter, ...scoreSectorRotation(xlkChg, xluChg) });
    factors.push({ name: 'Credit Spread', cat: 'inter', weight: 0.5 * rw.inter, ...scoreCreditSpread(hygChg, lqdChg) });
    factors.push({ name: 'ASX vs SPX', cat: 'inter', weight: 0.4 * rw.inter, ...scoreRelativeStrength(asxHist, spxData) });

    // STATISTICAL
    factors.push({ name: 'Z-Score', cat: 'stat', weight: 1.0 * rw.stat, ...scoreZScore(closes) });
    factors.push({ name: 'Autocorrelation', cat: 'stat', weight: 0.6 * rw.stat, ...scoreAutocorrelation(closes) });
    factors.push({ name: 'Skewness', cat: 'stat', weight: 0.5 * rw.stat, ...scoreSkewness(closes) });
    factors.push({ name: 'Kurtosis', cat: 'stat', weight: 0.4 * rw.stat, ...scoreKurtosis(closes) });
    factors.push({ name: 'Hurst Exponent', cat: 'stat', weight: 0.3 * rw.stat, ...scoreHurst(closes) });
    factors.push({ name: 'Tail Risk', cat: 'stat', weight: 0.5 * rw.stat, ...scoreTailRisk(closes) });

    // CALENDAR & SEASONAL
    factors.push({ name: 'Calendar', cat: 'cal', weight: 0.5 * rw.cal, ...scoreCalendar() });
    factors.push({ name: 'Seasonal', cat: 'cal', weight: 0.5 * rw.cal, ...scoreSeasonal(asxHist) });

    // PATTERN MATCHING
    factors.push({ name: 'Historical Match', cat: 'pattern', weight: 1.2 * rw.pattern, ...scoreHistoricalMatch(asxHist, rsiVal, consecData.value) });
    factors.push({ name: 'Gap Analysis', cat: 'pattern', weight: 0.5 * rw.pattern, ...scoreGapAnalysis(asxHist) });

    // ── ASX Sector Analysis ────────────────────────────────────────────
    const sectorAnalysis = scoreSectors({
      Miners: asxMiners, Banks: asxBanks, Energy: asxEnergy, Tech: asxTech
    });
    if (sectorAnalysis.rotationScore !== 0) {
      factors.push({ name: 'ASX Sector Rotation', cat: 'inter', weight: 0.8 * rw.inter,
        score: sectorAnalysis.rotationScore, detail: sectorAnalysis.detail });
    }
    factors.push({ name: 'Sector Breadth', cat: 'inter', weight: 0.6 * rw.inter,
      score: sectorAnalysis.breadth > 70 ? 0.5 : sectorAnalysis.breadth < 30 ? -0.5 : 0,
      detail: sectorAnalysis.detail });

    // ── Feature Interactions (compound signals) ──────────────────────
    const yieldCurveSpreadVal = (us2yData && bondData && us2yData.length >= 2 && bondData.length >= 2)
      ? bondData[bondData.length-1].c - us2yData[us2yData.length-1].c : null;
    const techForInteractions = { ...tech, yieldCurveSpread: yieldCurveSpreadVal, emaAlignment: factors.find(f=>f.name==='EMA Alignment')?.detail };
    const interactions = computeFeatureInteractions(techForInteractions, regime, { ...im, vix: vixData?.[vixData.length-1]?.c });
    for (const ix of interactions) {
      factors.push(ix);
    }

    // ── Walk-Forward Weight Optimization ─────────────────────────────
    const optimizedWeights = optimizeWeights(asxHist, OPT_FACTORS, 120);
    if (optimizedWeights) {
      // Apply IC-based multipliers to matching factors
      for (const f of factors) {
        const optName = f.name.replace(/[^a-zA-Z]/g, '');
        for (const [oKey, oVal] of Object.entries(optimizedWeights)) {
          if (optName.toLowerCase().includes(oKey.toLowerCase()) && oVal.multiplier != null) {
            f.weight *= Math.abs(oVal.multiplier);
            f.optimized = true;
            f.ic = oVal.ic;
            break;
          }
        }
      }
    }

    // ── Ensemble model ────────────────────────────────────────────────
    const ensemble = buildEnsemble(factors, regime);

    // ── Weighted final score ──────────────────────────────────────────
    let totalWS = 0, totalW = 0;
    for (const f of factors) {
      f.weightedScore = +(f.score * f.weight).toFixed(3);
      totalWS += f.score * f.weight;
      totalW += f.weight;
    }
    const rawScore = totalW > 0 ? totalWS / totalW : 0;

    // Blend raw factor score with ensemble (ensemble gets 40% vote)
    const blendedScore = rawScore * 0.6 + ensemble.ensemble * 0.4;

    // ── Adaptive thresholds ──────────────────────────────────────────
    const thresholds = adaptiveThresholds(regime.regime, regime.atrPctile);
    const direction = blendedScore > thresholds.bullThreshold ? 'BULL'
      : blendedScore < thresholds.bearThreshold ? 'BEAR' : 'NEUTRAL';

    // ── Monte Carlo range ────────────────────────────────────────────
    const mc = monteCarloRange(closes, atrVal, 2000);

    // ── Backtest ─────────────────────────────────────────────────────
    const backtest = advancedBacktest(asxHist);
    const rollingAcc = backtest ? rollingAccuracyWindows(backtest.recentResults) : null;

    // ── Correlation matrix ───────────────────────────────────────────
    const corrMatrix = buildCorrelationMatrix(asxHist, spxData, goldData, vixData, audData);
    // Correlation breakdown adds uncertainty
    if (corrMatrix.breakdownAlert) {
      factors.push({ name: 'Corr Breakdown', cat: 'stat', weight: 1.0,
        score: -0.3 * Math.sign(blendedScore), // Reduces conviction in current direction
        detail: corrMatrix.breakdownDetail });
    }

    // ── Final confidence (meta-analysis) ─────────────────────────────
    const confAnalysis = signalConfidenceAnalysis(factors, ensemble, regime, rollingAcc, mc);
    const confidence = confAnalysis.confidence;
    const finalScore = blendedScore;

    // ── Range (Monte Carlo + ATR hybrid) ─────────────────────────────
    const atrV = atrVal || lastPrice * 0.01;
    let rangeLow, rangeHigh;
    if (mc) {
      rangeLow = mc.p10; rangeHigh = mc.p90;
    } else {
      const expectedMove = atrV * (0.25 + Math.abs(finalScore) * 0.5);
      if (direction === 'BULL') { rangeLow = lastPrice - atrV * 0.25; rangeHigh = lastPrice + expectedMove; }
      else if (direction === 'BEAR') { rangeLow = lastPrice - expectedMove; rangeHigh = lastPrice + atrV * 0.25; }
      else { rangeLow = lastPrice - atrV * 0.4; rangeHigh = lastPrice + atrV * 0.4; }
    }
    const estChange = finalScore * 0.35;

    // ── XSO & XEC predictions (propagated from ASX200 with beta adjustments) ──
    const xsoCloses = xsoHist?.map(c => c.c) || [];
    const xecCloses = xecHist?.map(c => c.c) || [];
    const xsoRSI = rsi(xsoCloses);
    const xecRSI = rsi(xecCloses);
    const xsoATR = xsoHist ? atr(xsoHist) : null;
    const xecATR = xecHist ? atr(xecHist) : null;
    const xsoLast = xsoCloses.length ? xsoCloses[xsoCloses.length - 1] : 0;
    const xecLast = xecCloses.length ? xecCloses[xecCloses.length - 1] : 0;

    // Small/micro caps have higher beta — amplify the signal
    const xsoBeta = 1.15, xecBeta = 1.35;
    const xsoScore = finalScore * xsoBeta;
    const xecScore = finalScore * xecBeta;
    const xsoDir = xsoScore > 0.12 ? 'BULL' : xsoScore < -0.12 ? 'BEAR' : 'NEUTRAL';
    const xecDir = xecScore > 0.12 ? 'BULL' : xecScore < -0.12 ? 'BEAR' : 'NEUTRAL';

    // ── Response ──────────────────────────────────────────────────────
    const response = {
      prediction: {
        direction, score: +finalScore.toFixed(4), confidence: +confidence.toFixed(1),
        estimatedChange: `${estChange > 0 ? '+' : ''}${estChange.toFixed(2)}%`,
        range: { low: +rangeLow.toFixed(1), high: +rangeHigh.toFixed(1) },
        lastPrice: +lastPrice.toFixed(1),
      },
      indices: {
        ASX200: { direction, score: +finalScore.toFixed(4), confidence: +confidence.toFixed(1), lastPrice: +lastPrice.toFixed(1), rsi: rsiVal ? +rsiVal.toFixed(1) : null, atr: atrVal ? +atrVal.toFixed(1) : null,
          range: { low: +rangeLow.toFixed(1), high: +rangeHigh.toFixed(1) } },
        XSO: { direction: xsoDir, score: +xsoScore.toFixed(4), confidence: +(confidence * 0.9).toFixed(1), lastPrice: +xsoLast.toFixed(1), rsi: xsoRSI ? +xsoRSI.toFixed(1) : null, atr: xsoATR ? +xsoATR.toFixed(1) : null,
          range: xsoATR ? { low: +(xsoLast - xsoATR * 0.5).toFixed(1), high: +(xsoLast + xsoATR * 0.5).toFixed(1) } : null },
        XEC: { direction: xecDir, score: +xecScore.toFixed(4), confidence: +(confidence * 0.8).toFixed(1), lastPrice: +xecLast.toFixed(1), rsi: xecRSI ? +xecRSI.toFixed(1) : null, atr: xecATR ? +xecATR.toFixed(1) : null,
          range: xecATR ? { low: +(xecLast - xecATR * 0.5).toFixed(1), high: +(xecLast + xecATR * 0.5).toFixed(1) } : null },
      },
      regime: { type: regime.regime, confidence: +(regime.confidence * 100).toFixed(0), adx: +regime.adx.toFixed(1),
        hurst: +regime.hurst.toFixed(3), atrPercentile: +regime.atrPctile.toFixed(0), bbWidth: +(regime.bbWidth * 100).toFixed(2) },
      ensemble: {
        score: +ensemble.ensemble.toFixed(4),
        momentum: { score: +ensemble.momentum.score.toFixed(3), weight: +ensemble.momentum.weight.toFixed(1) },
        meanReversion: { score: +ensemble.meanReversion.score.toFixed(3), weight: +ensemble.meanReversion.weight.toFixed(1) },
        intermarket: { score: +ensemble.intermarket.score.toFixed(3), weight: +ensemble.intermarket.weight.toFixed(1) },
      },
      factors: factors.map(f => ({
        name: f.name, cat: f.cat, score: +f.score.toFixed(3), weight: +f.weight.toFixed(2),
        weightedScore: +f.weightedScore, detail: f.detail,
        optimized: f.optimized || false, ic: f.ic != null ? +f.ic.toFixed(4) : null,
      })),
      intermarket: {
        nq: nqChg != null ? +nqChg.toFixed(2) : null, es: esChg != null ? +esChg.toFixed(2) : null, ym: ymChg != null ? +ymChg.toFixed(2) : null,
        vix: vixData?.[vixData.length - 1]?.c || null, vixRegime: factors.find(f => f.name === 'VIX')?.regime || 'unknown',
        gold: goldChg != null ? +goldChg.toFixed(2) : null, oil: oilChg != null ? +oilChg.toFixed(2) : null,
        dxy: dxyChg != null ? +dxyChg.toFixed(2) : null, bond10y: bondChg != null ? +bondChg.toFixed(2) : null,
        aud: audChg != null ? +audChg.toFixed(2) : null, btc: btcChg != null ? +btcChg.toFixed(2) : null,
        copper: copperChg != null ? +copperChg.toFixed(2) : null, xlk: xlkChg != null ? +xlkChg.toFixed(2) : null, xlu: xluChg != null ? +xluChg.toFixed(2) : null,
      },
      technicals: {
        rsi: rsiVal ? +rsiVal.toFixed(1) : null,
        macd: macdVal ? { line: +macdVal.line.toFixed(2), signal: +macdVal.signal.toFixed(2), hist: +macdVal.hist.toFixed(2), accel: macdVal.hist > macdVal.prevHist } : null,
        atr: atrVal ? +atrVal.toFixed(2) : null, atrPctile: +regime.atrPctile.toFixed(0),
        stochastic: stochVal ? { k: +stochVal.k.toFixed(1), d: +stochVal.d.toFixed(1) } : null,
        adx: adxVal ? { adx: +adxVal.adx.toFixed(1), pDI: +adxVal.pDI.toFixed(1), nDI: +adxVal.nDI.toFixed(1) } : null,
        ichimoku: ichVal ? { aboveCloud: ichVal.aboveCloud, tkCross: ichVal.tkCross, cloudColor: ichVal.cloudColor } : null,
        cci: cciVal ? +cciVal.toFixed(0) : null, mfi: mfiVal ? +mfiVal.toFixed(0) : null,
        williamsR: wRVal ? +wRVal.toFixed(0) : null, roc: rocVal ? +rocVal.toFixed(2) : null,
        parabolicSAR: sarVal ? { direction: sarVal.isUp ? 'BULL' : 'BEAR', level: +sarVal.sar.toFixed(1) } : null,
        fibonacci: fibVal ? { retracement: +(fibVal.retracement * 100).toFixed(0), nearLevel: fibVal.nearLevel, high: +fibVal.high.toFixed(1), low: +fibVal.low.toFixed(1) } : null,
        pivots: pivotVal ? { pp: +pivotVal.pp.toFixed(1), r1: +pivotVal.r1.toFixed(1), r2: +pivotVal.r2.toFixed(1), s1: +pivotVal.s1.toFixed(1), s2: +pivotVal.s2.toFixed(1) } : null,
        consecutiveDays: consecData.value,
        hurst: hurstVal ? +hurstVal.toFixed(3) : null,
        zScore: zVal ? +zVal.toFixed(2) : null,
        autocorrelation: acVal ? +acVal.toFixed(3) : null,
        skewness: skewVal ? +skewVal.toFixed(2) : null,
        kurtosis: kurtVal ? +kurtVal.toFixed(2) : null,
        bollingerWidth: bbVal ? +(bbVal.width * 100).toFixed(2) : null,
        vwapDev: vwapVal ? +((lastPrice - vwapVal) / vwapVal * 100).toFixed(2) : null,
        superTrend: stResult.daily ? {
          daily: { direction: stResult.daily.direction, level: stResult.daily.level, distancePct: stResult.daily.distancePct, flipped: stResult.daily.flipped },
          weekly: stResult.weekly ? { direction: stResult.weekly.direction, level: stResult.weekly.level, distancePct: stResult.weekly.distancePct, flipped: stResult.weekly.flipped } : null,
        } : null,
      },
      monteCarlo: mc || null,
      correlationMatrix: corrMatrix ? {
        pairs: Object.fromEntries(Object.entries(corrMatrix.pairs).map(([k, v]) => [k, v ? { current: +v.current.toFixed(3), previous: +v.previous.toFixed(3), change: +v.change.toFixed(3) } : null])),
        breakdownAlert: corrMatrix.breakdownAlert,
        breakdownDetail: corrMatrix.breakdownDetail || null,
      } : null,
      sectorAnalysis: sectorAnalysis ? {
        sectors: sectorAnalysis.sectors,
        breadth: sectorAnalysis.breadth,
        rotationScore: sectorAnalysis.rotationScore,
        detail: sectorAnalysis.detail,
      } : null,
      thresholds: { bullThreshold: +thresholds.bullThreshold.toFixed(3), bearThreshold: +thresholds.bearThreshold.toFixed(3) },
      rollingAccuracy: rollingAcc || null,
      confidenceAnalysis: { confidence: +confidence.toFixed(1), notes: confAnalysis.notes || [] },
      weightOptimization: optimizedWeights ? {
        applied: true,
        factorsOptimized: factors.filter(f => f.optimized).length,
        totalFactors: factors.length,
      } : { applied: false },
      backtest,
      historicalMatches: factors.find(f => f.name === 'Historical Match')?.matches?.slice(-8) || [],
      seasonal: factors.find(f => f.name === 'Seasonal')?.detail || '',
      generated: new Date().toISOString(),
      factorCount: factors.length,
      version: '2.6',
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(response) };
  } catch (err) {
    console.error('[predict-v2] Error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
