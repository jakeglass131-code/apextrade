// ═══════════════════════════════════════════════════════════════════════════════
// ApexTrade Auto-Execution — IG Markets ASX 200 CFD
// ═══════════════════════════════════════════════════════════════════════════════
// Scheduled to run daily before ASX market open (9:00am AEST / 23:00 UTC prev day)
// 1. Fetches latest market data (ASX, VIX, Gold, Oil, AUD, Bonds, SPX)
// 2. Generates signal using walk-forwarded prediction engine
// 3. Places/adjusts position via IG Markets REST API
// 4. Logs trade and sends notification
//
// Safety controls:
//   - Max daily loss: 5% of equity → auto-disable for the day
//   - Kill switch: set TRADE_ENABLED=false env var to disable
//   - Position size capped at account balance
//   - All trades logged with full audit trail
// ═══════════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── IG Markets API Configuration ──────────────────────────────────────────────
const IG_API_URL = 'https://api-live.ig.com/gateway/deal'; // Live AU
const IG_DEMO_URL = 'https://demo-api.ig.com/gateway/deal';
const ASX_EPIC = 'IX.D.ASX.IFM.IP'; // ASX 200 Cash CFD on IG

// ── Yahoo Finance data fetcher ────────────────────────────────────────────────
async function yahooChart(symbol, range = '2y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexTrade-AutoTrade/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const d = await r.json();
  const res = d.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  return ts.map((t, i) => ({
    t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i],
    c: adj?.[i] ?? q.close?.[i], v: q.volume?.[i] || 0,
  })).filter(c => c.o != null && c.c != null && c.h != null && c.l != null);
}

async function safeFetch(symbol, range = '2y') {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await yahooChart(symbol, range);
      if (data && data.length > 100) return data;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      if (attempt === 2) { console.warn(`⚠ ${symbol}: ${e.message}`); return null; }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR LIBRARY (same as backtest-10yr.js / predict-v2.js)
// ═══════════════════════════════════════════════════════════════════════════════

function sma(arr, p) { if (arr.length < p) return null; return arr.slice(-p).reduce((a, b) => a + b, 0) / p; }
function ema(arr, p) { if (arr.length < p) return null; const k = 2/(p+1); let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
function emaSeries(arr, p) { if(arr.length<p)return[]; const k=2/(p+1); let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p; const out=[e]; for(let i=p;i<arr.length;i++){e=arr[i]*k+e*(1-k);out.push(e);} return out; }

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

function macd(closes) {
  if (closes.length < 35) return null;
  const e12s = emaSeries(closes, 12), e26s = emaSeries(closes, 26);
  if (e26s.length < 9) return null;
  const macdLine = []; const offset = 26 - 12;
  for (let i = 0; i < e26s.length; i++) macdLine.push(e12s[i + offset] - e26s[i]);
  const sigSeries = emaSeries(macdLine, 9);
  const hist = macdLine[macdLine.length - 1] - sigSeries[sigSeries.length - 1];
  const prevHist = macdLine.length >= 2 && sigSeries.length >= 2 ? macdLine[macdLine.length - 2] - sigSeries[sigSeries.length - 2] : hist;
  return { line: macdLine[macdLine.length - 1], signal: sigSeries[sigSeries.length - 1], hist, prevHist };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++)
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  return sum / period;
}

function atrSeries(candles, period = 14) {
  const out = [];
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++)
      sum += Math.max(candles[j].h - candles[j].l, Math.abs(candles[j].h - candles[j - 1].c), Math.abs(candles[j].l - candles[j - 1].c));
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

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  let atr14 = 0, pDM14 = 0, nDM14 = 0;
  for (let i = 1; i <= period; i++) {
    atr14 += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    const up = candles[i].h - candles[i - 1].h, dn = candles[i - 1].l - candles[i].l;
    pDM14 += (up > dn && up > 0) ? up : 0;
    nDM14 += (dn > up && dn > 0) ? dn : 0;
  }
  const dxValues = [];
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    atr14 = atr14 - atr14 / period + tr;
    const up = candles[i].h - candles[i - 1].h, dn = candles[i - 1].l - candles[i].l;
    pDM14 = pDM14 - pDM14 / period + ((up > dn && up > 0) ? up : 0);
    nDM14 = nDM14 - nDM14 / period + ((dn > up && dn > 0) ? dn : 0);
    const pDI = (pDM14 / atr14) * 100, nDI = (nDM14 / atr14) * 100;
    dxValues.push({ dx: (Math.abs(pDI - nDI) / (pDI + nDI)) * 100, pDI, nDI });
  }
  if (dxValues.length < period) return null;
  const adxVal = dxValues.slice(-period).reduce((a, b) => a + b.dx, 0) / period;
  return { adx: adxVal, pDI: dxValues[dxValues.length - 1].pDI, nDI: dxValues[dxValues.length - 1].nDI };
}

function ichimoku(candles) {
  if (candles.length < 52) return null;
  const midHL = (arr) => { const h = Math.max(...arr.map(c => c.h)), l = Math.min(...arr.map(c => c.l)); return (h + l) / 2; };
  const tenkan = midHL(candles.slice(-9)), kijun = midHL(candles.slice(-26));
  const senkouA = (tenkan + kijun) / 2, senkouB = midHL(candles.slice(-52));
  const cloudTop = Math.max(senkouA, senkouB), cloudBottom = Math.min(senkouA, senkouB);
  const price = candles[candles.length - 1].c;
  return { aboveCloud: price > cloudTop, belowCloud: price < cloudBottom, tkCross: tenkan > kijun ? 'bullish' : 'bearish' };
}

function williamsR(candles, period = 14) {
  if (candles.length < period) return null;
  const w = candles.slice(-period);
  const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
  return hi === lo ? -50 : ((hi - candles[candles.length - 1].c) / (hi - lo)) * -100;
}

function zScore(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = []; for (let i = closes.length - period; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return std === 0 ? 0 : (rets[rets.length - 1] - mean) / std;
}

function hurstExponent(closes, maxLag = 20) {
  if (closes.length < maxLag * 4) return null;
  const rets = []; for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const lags = [], rs = [];
  for (let lag = 4; lag <= maxLag; lag++) {
    const chunks = Math.floor(rets.length / lag);
    if (chunks < 2) continue;
    let totalRS = 0;
    for (let c = 0; c < chunks; c++) {
      const chunk = rets.slice(c * lag, (c + 1) * lag);
      const mean = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      let sum = 0; const cumDev = [];
      for (const d of chunk.map(r => r - mean)) { sum += d; cumDev.push(sum); }
      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(chunk.reduce((a, b) => a + (b - mean) ** 2, 0) / chunk.length);
      if (S > 0) totalRS += R / S;
    }
    lags.push(Math.log(lag));
    rs.push(Math.log(totalRS / chunks));
  }
  if (lags.length < 3) return 0.5;
  const n = lags.length, sumX = lags.reduce((a, b) => a + b, 0), sumY = rs.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((a, b, i) => a + b * rs[i], 0), sumX2 = lags.reduce((a, b) => a + b * b, 0);
  return Math.max(0, Math.min(1, (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)));
}

function atrPercentileRank(candles, lookback = 252) {
  const atrs = atrSeries(candles, 14);
  if (atrs.length < 20) return 50;
  const window = atrs.slice(-Math.min(lookback, atrs.length));
  const current = window[window.length - 1];
  return (window.filter(a => a <= current).length / window.length) * 100;
}

function superTrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++)
    trueRanges.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)));
  const atrArr = [];
  let atrSum = 0;
  for (let i = 0; i < period && i < trueRanges.length; i++) atrSum += trueRanges[i];
  atrArr.push(atrSum / period);
  for (let i = period; i < trueRanges.length; i++) atrArr.push((atrArr[atrArr.length - 1] * (period - 1) + trueRanges[i]) / period);
  const st = [];
  for (let i = 0; i < atrArr.length; i++) {
    const ci = i + 1;
    const hl2 = (candles[ci].h + candles[ci].l) / 2;
    let upperBand = hl2 + multiplier * atrArr[i], lowerBand = hl2 - multiplier * atrArr[i];
    if (st.length > 0) {
      const prev = st[st.length - 1];
      if (lowerBand > prev.lower && candles[ci - 1].c > prev.lower) lowerBand = Math.max(lowerBand, prev.lower);
      if (upperBand < prev.upper && candles[ci - 1].c < prev.upper) upperBand = Math.min(upperBand, prev.upper);
    }
    let trend;
    if (st.length === 0) trend = candles[ci].c > upperBand ? 1 : -1;
    else {
      const prev = st[st.length - 1];
      if (prev.trend === 1 && candles[ci].c < prev.lower) trend = -1;
      else if (prev.trend === -1 && candles[ci].c > prev.upper) trend = 1;
      else trend = prev.trend;
    }
    st.push({ upper: upperBand, lower: lowerBand, trend, level: trend === 1 ? lowerBand : upperBand });
  }
  if (st.length < 2) return null;
  const last = st[st.length - 1], prev = st[st.length - 2];
  return { direction: last.trend === 1 ? 'BULL' : 'BEAR', flipped: last.trend !== prev.trend, trend: last.trend };
}

function obvSlope(candles, lookback = 10) {
  if (candles.length < lookback + 1) return null;
  let obv = 0; const obvArr = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > candles[i - 1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i - 1].c) obv -= candles[i].v;
    obvArr.push(obv);
  }
  const recent = obvArr.slice(-lookback);
  const avgVol = candles.slice(-20).reduce((a, c) => a + c.v, 0) / 20;
  return avgVol > 0 ? (recent[recent.length - 1] - recent[0]) / (avgVol * lookback) : 0;
}

function autocorrelation(closes, lag = 1) {
  const rets = []; for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  if (rets.length < lag + 10) return null;
  const n = rets.length, mean = rets.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = lag; i < n; i++) num += (rets[i] - mean) * (rets[i - lag] - mean);
  for (let i = 0; i < n; i++) den += (rets[i] - mean) ** 2;
  return den === 0 ? 0 : num / den;
}

function parabolicSAR(candles) {
  if (candles.length < 5) return null;
  let isUp = candles[1].c > candles[0].c, sar = isUp ? candles[0].l : candles[0].h;
  let ep = isUp ? candles[1].h : candles[1].l, af = 0.02;
  for (let i = 2; i < candles.length; i++) {
    sar += af * (ep - sar);
    if (isUp) {
      if (candles[i].l < sar) { isUp = false; sar = ep; ep = candles[i].l; af = 0.02; }
      else if (candles[i].h > ep) { ep = candles[i].h; af = Math.min(af + 0.02, 0.2); }
    } else {
      if (candles[i].h > sar) { isUp = true; sar = ep; ep = candles[i].h; af = 0.02; }
      else if (candles[i].l < ep) { ep = candles[i].l; af = Math.min(af + 0.02, 0.2); }
    }
  }
  return { sar, isUp };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS — identical to backtest-10yr.js
// ═══════════════════════════════════════════════════════════════════════════════

function scoreRSI(val) {
  if (val == null) return 0;
  if (val > 80) return -2; if (val > 70) return -1; if (val > 65) return -0.3;
  if (val > 55) return 0.2; if (val > 45) return 0; if (val > 35) return 0.3;
  if (val > 30) return 1; if (val > 20) return 2; return 2.5;
}

function scoreMACD(m) {
  if (!m) return 0;
  let s = 0;
  s += m.hist > 0 ? 0.5 : -0.5;
  s += m.line > m.signal ? 0.3 : -0.3;
  s += m.hist > m.prevHist ? 0.3 : -0.3;
  s += m.line > 0 && m.signal > 0 ? 0.2 : m.line < 0 && m.signal < 0 ? -0.2 : 0;
  return Math.max(-1.5, Math.min(1.5, s));
}

function scoreEMA(closes) {
  if (closes.length < 200) return 0;
  const e8 = ema(closes, 8), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  if (!e8 || !e21 || !e50 || !e200) return 0;
  let s = 0;
  if (e8 > e21 && e21 > e50 && e50 > e200) s = 1.5;
  else if (e8 < e21 && e21 < e50 && e50 < e200) s = -1.5;
  else if (closes[closes.length - 1] > e200) s = 0.3; else s = -0.3;
  return s;
}

function scoreBollinger(closes) {
  const bb = bollingerBands(closes);
  if (!bb) return 0;
  const p = (closes[closes.length - 1] - bb.lower) / (bb.upper - bb.lower);
  if (p > 0.95) return -1.2; if (p > 0.85) return -0.6;
  if (p < 0.05) return 1.2; if (p < 0.15) return 0.6;
  return 0;
}

function scoreStoch(candles) {
  const s = stochastic(candles);
  if (!s) return 0;
  if (s.k > 80 && s.d > 80) return -0.8;
  if (s.k < 20 && s.d < 20) return 0.8;
  if (s.k > s.d && s.k < 80) return 0.3;
  if (s.k < s.d && s.k > 20) return -0.3;
  return 0;
}

function scoreADX(candles) {
  const a = adx(candles);
  if (!a) return 0;
  if (a.adx > 25 && a.pDI > a.nDI) return 0.6;
  if (a.adx > 25 && a.nDI > a.pDI) return -0.6;
  return 0;
}

function scoreIchimoku(candles) {
  const ich = ichimoku(candles);
  if (!ich) return 0;
  let s = 0;
  s += ich.aboveCloud ? 0.5 : ich.belowCloud ? -0.5 : 0;
  s += ich.tkCross === 'bullish' ? 0.3 : -0.3;
  return s;
}

function scoreSAR(candles) {
  const s = parabolicSAR(candles);
  return s ? (s.isUp ? 0.4 : -0.4) : 0;
}

function scoreSuperTrendDaily(candles) {
  const st = superTrend(candles);
  if (!st) return 0;
  let s = st.direction === 'BULL' ? 0.5 : -0.5;
  if (st.flipped) s += st.direction === 'BULL' ? 0.5 : -0.5;
  return s;
}

function scoreMeanReversion(closes) {
  if (closes.length < 50) return 0;
  const m20 = sma(closes, 20), m50 = sma(closes, 50);
  const price = closes[closes.length - 1];
  if (!m20 || !m50) return 0;
  const dev20 = (price - m20) / m20;
  if (dev20 > 0.04) return -0.8;
  if (dev20 < -0.04) return 0.8;
  return 0;
}

function scoreConsecutive(candles) {
  let streak = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const chg = candles[i].c - candles[i - 1].c;
    if (streak === 0) streak = chg > 0 ? 1 : chg < 0 ? -1 : 0;
    else if (streak > 0 && chg > 0) streak++;
    else if (streak < 0 && chg < 0) streak--;
    else break;
  }
  if (Math.abs(streak) >= 5) return streak > 0 ? -1.0 : 1.0;
  if (Math.abs(streak) >= 3) return streak > 0 ? -0.4 : 0.4;
  return 0;
}

function scoreVolume(candles) {
  if (candles.length < 21) return 0;
  const avgVol = candles.slice(-21, -1).reduce((a, c) => a + c.v, 0) / 20;
  const lastVol = candles[candles.length - 1].v;
  const ratio = avgVol > 0 ? lastVol / avgVol : 1;
  const lastChg = candles[candles.length - 1].c - candles[candles.length - 2].c;
  if (ratio > 1.5 && lastChg > 0) return 0.5;
  if (ratio > 1.5 && lastChg < 0) return -0.5;
  return 0;
}

function scoreOBV(candles) {
  const slope = obvSlope(candles);
  if (slope == null) return 0;
  if (slope > 0.5) return 0.4;
  if (slope < -0.5) return -0.4;
  return 0;
}

function scoreZScore(closes) {
  const z = zScore(closes);
  if (z == null) return 0;
  if (z > 2) return -0.8; if (z > 1.5) return -0.4;
  if (z < -2) return 0.8; if (z < -1.5) return 0.4;
  return 0;
}

function scoreHurst(closes) {
  const h = hurstExponent(closes);
  if (h == null) return 0;
  if (h > 0.6) return 0.3;
  if (h < 0.4) return -0.2;
  return 0;
}

function scoreVIX(vixVal) {
  if (vixVal == null) return 0;
  if (vixVal > 35) return -1.0; if (vixVal > 25) return -0.5;
  if (vixVal < 14) return 0.3;
  return 0;
}

function scoreCalendar(date) {
  const dow = date.getUTCDay();
  if (dow === 1) return -0.15;
  if (dow === 5) return 0.15;
  const month = date.getUTCMonth();
  if (month === 0 || month === 10) return 0.1;
  if (month === 8) return -0.1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME & CRISIS DETECTION — identical to backtest
// ═══════════════════════════════════════════════════════════════════════════════

function detectRegime(candles, closes) {
  const adxData = adx(candles);
  const hurst = hurstExponent(closes);
  const atrP = atrPercentileRank(candles);
  const bb = bollingerBands(closes);
  const bbWidth = bb ? bb.width : 0;
  if (adxData && adxData.adx > 30 && hurst > 0.55) return 'TRENDING';
  if (adxData && adxData.adx < 20 && hurst < 0.45) return 'MEAN_REVERTING';
  if (atrP > 80 || bbWidth > 0.06) return 'VOLATILE';
  if (atrP < 20 && bbWidth < 0.02) return 'QUIET';
  return 'NORMAL';
}

function detectCrisis(vixSlice, spxSlice, asxSlice) {
  const crisis = { active: false, severity: 0, signals: [] };
  if (vixSlice && vixSlice.length >= 4) {
    const vixNow = vixSlice[vixSlice.length - 1].c;
    const vix3dAgo = vixSlice[vixSlice.length - 4].c;
    const vixVelocity = ((vixNow - vix3dAgo) / vix3dAgo) * 100;
    if (vixVelocity > 40) { crisis.severity += 3; crisis.signals.push('VIX_VELOCITY'); }
    else if (vixVelocity > 25) { crisis.severity += 2; crisis.signals.push('VIX_ELEVATED'); }
    if (vixNow > 35) { crisis.severity += 2; crisis.signals.push('VIX_EXTREME'); }
    else if (vixNow > 28) { crisis.severity += 1; crisis.signals.push('VIX_HIGH'); }
  }
  if (spxSlice && spxSlice.length >= 2) {
    const spxChg = Math.abs((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 2].c) / spxSlice[spxSlice.length - 2].c) * 100;
    if (spxChg > 4.0) { crisis.severity += 2; crisis.signals.push('SPX_GAP'); }
    if (spxSlice.length >= 4) {
      const spx3dChg = ((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 4].c) / spxSlice[spxSlice.length - 4].c) * 100;
      if (spx3dChg < -6) { crisis.severity += 2; crisis.signals.push('SPX_DRAWDOWN'); }
    }
  }
  if (asxSlice && asxSlice.length >= 2) {
    const asxChg = Math.abs((asxSlice[asxSlice.length - 1].c - asxSlice[asxSlice.length - 2].c) / asxSlice[asxSlice.length - 2].c) * 100;
    if (asxChg > 3.5) { crisis.severity += 1; crisis.signals.push('ASX_GAP'); }
  }
  crisis.active = crisis.severity >= 3;
  return crisis;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING — generates today's signal
// ═══════════════════════════════════════════════════════════════════════════════

function generateDayScore(asxSlice, vixSlice, goldSlice, oilSlice, audSlice, bondSlice, spxSlice) {
  const closes = asxSlice.map(c => c.c);
  const regime = detectRegime(asxSlice, closes);
  const crisis = detectCrisis(vixSlice, spxSlice, asxSlice);

  const regimeMultipliers = {
    TRENDING:       { trend: 1.3, contrarian: 0.7, momentum: 1.2, volatility: 0.9, macro: 1.0 },
    MEAN_REVERTING: { trend: 0.7, contrarian: 1.3, momentum: 0.8, volatility: 1.0, macro: 1.0 },
    VOLATILE:       { trend: 0.8, contrarian: 0.9, momentum: 0.8, volatility: 1.3, macro: 0.9 },
    QUIET:          { trend: 1.0, contrarian: 1.1, momentum: 1.0, volatility: 0.7, macro: 1.1 },
    NORMAL:         { trend: 1.0, contrarian: 1.0, momentum: 1.0, volatility: 1.0, macro: 1.0 },
  };
  const rm = regimeMultipliers[regime] || regimeMultipliers.NORMAL;
  const factors = [];

  // VIX-Conditional SPX Weight
  let spxWeight = 10.0;
  if (vixSlice && vixSlice.length >= 1) {
    const currentVIX = vixSlice[vixSlice.length - 1].c;
    if (crisis.active) spxWeight = 2.0;
    else if (currentVIX > 35) spxWeight = 3.0;
    else if (currentVIX > 25) spxWeight = 6.0;
    else if (currentVIX < 14) spxWeight = 12.0;
  }

  // SPX overnight move
  if (spxSlice && spxSlice.length >= 2) {
    const spxChg = ((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 2].c) / spxSlice[spxSlice.length - 2].c) * 100;
    let s = 0;
    const extremeThresh = crisis.active ? 4.5 : (vixSlice && vixSlice.length >= 1 && vixSlice[vixSlice.length - 1].c > 25) ? 3.5 : 2.9;
    if (spxChg > extremeThresh) s = 0.2;
    else if (spxChg > 0.55) s = 0.8;
    else if (spxChg > 0.1) s = 0.3;
    else if (spxChg < -extremeThresh) s = -0.2;
    else if (spxChg < -0.55) s = -0.8;
    else if (spxChg < -0.1) s = -0.3;
    factors.push({ w: spxWeight * rm.trend, s });
  }

  // VIX change
  if (vixSlice && vixSlice.length >= 2) {
    const vixChg = ((vixSlice[vixSlice.length - 1].c - vixSlice[vixSlice.length - 2].c) / vixSlice[vixSlice.length - 2].c) * 100;
    const vixChangeWeight = crisis.active ? 5.0 : 3.8;
    let s = 0;
    if (crisis.active && vixChg > 14) s = -0.3;
    else if (vixChg > 14) s = 0;
    else if (vixChg > 3) s = 0.3;
    else if (vixChg < -8) s = -0.3;
    else if (vixChg < -3) s = -0.15;
    factors.push({ w: vixChangeWeight * rm.volatility, s });
  }

  // Oil
  if (oilSlice && oilSlice.length >= 2) {
    const oChg = ((oilSlice[oilSlice.length - 1].c - oilSlice[oilSlice.length - 2].c) / oilSlice[oilSlice.length - 2].c) * 100;
    let s = 0;
    if (oChg > 3) s = 0.8; else if (oChg > 1) s = 0.3;
    else if (oChg < -3) s = -0.8; else if (oChg < -1) s = -0.3;
    factors.push({ w: 3.4 * rm.macro, s });
  }

  // AUD/USD
  if (audSlice && audSlice.length >= 2) {
    const aChg = ((audSlice[audSlice.length - 1].c - audSlice[audSlice.length - 2].c) / audSlice[audSlice.length - 2].c) * 100;
    let s = 0;
    if (aChg > 1.0) s = 0.8; else if (aChg > 0.3) s = 0.3;
    else if (aChg < -1.0) s = -0.8; else if (aChg < -0.3) s = -0.3;
    factors.push({ w: 4.0 * rm.macro, s });
  }

  // 1-Day Contrarian
  {
    const ret1d = closes.length >= 2 ? (closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2] * 100 : 0;
    let s = 0;
    if (ret1d > 1.6) s = -0.8; else if (ret1d > 0.02) s = -0.3;
    else if (ret1d < -1.6) s = 0.8; else if (ret1d < -0.02) s = 0.3;
    factors.push({ w: 2.8 * rm.contrarian, s });
  }

  // 3-Day Contrarian
  {
    const ret3d = closes.length >= 4 ? (closes[closes.length-1] - closes[closes.length-4]) / closes[closes.length-4] * 100 : 0;
    let s = 0;
    if (ret3d > 2.0) s = -0.5; else if (ret3d > 1.0) s = -0.3;
    else if (ret3d < -2.0) s = 0.5; else if (ret3d < -1.0) s = 0.3;
    factors.push({ w: 1.6 * rm.contrarian, s });
  }

  // Tier 2 factors
  factors.push({ w: 3.5 * rm.contrarian, s: scoreConsecutive(asxSlice) });
  factors.push({ w: 2.1 * rm.contrarian, s: scoreZScore(closes) });
  factors.push({ w: 1.8 * rm.contrarian, s: scoreMeanReversion(closes) });
  if (vixSlice && vixSlice.length >= 1) {
    const vixLevelWeight = crisis.active ? 5.0 : 1.7;
    factors.push({ w: vixLevelWeight * rm.volatility, s: scoreVIX(vixSlice[vixSlice.length - 1].c) });
  }
  const wrVal = williamsR(asxSlice);
  factors.push({ w: 1.3 * rm.momentum, s: wrVal != null ? (wrVal > -20 ? -0.5 : wrVal < -80 ? 0.5 : 0) : 0 });
  factors.push({ w: 1.0 * rm.volatility, s: scoreBollinger(closes) });
  const date = new Date(asxSlice[asxSlice.length - 1].t);
  factors.push({ w: 0.7, s: scoreCalendar(date) });
  if (bondSlice && bondSlice.length >= 2) {
    const bChg = ((bondSlice[bondSlice.length - 1].c - bondSlice[bondSlice.length - 2].c) / bondSlice[bondSlice.length - 2].c) * 100;
    factors.push({ w: 0.6 * rm.macro, s: bChg > 3 ? -0.3 : bChg < -3 ? 0.3 : 0 });
  }
  if (crisis.active) {
    const crisisSeverityScore = Math.min(0.6, crisis.severity * 0.10);
    factors.push({ w: 2.5, s: -crisisSeverityScore });
  }

  // Tier 3 display-only
  factors.push({ w: 0.1, s: scoreRSI(rsi(closes)) });
  factors.push({ w: 0.1, s: scoreMACD(macd(closes)) });
  factors.push({ w: 0.1, s: scoreEMA(closes) });
  factors.push({ w: 0.1, s: scoreStoch(asxSlice) });
  factors.push({ w: 0.1, s: scoreADX(asxSlice) });
  factors.push({ w: 0.1, s: scoreIchimoku(asxSlice) });
  factors.push({ w: 0.1, s: scoreSAR(asxSlice) });
  factors.push({ w: 0.1, s: scoreSuperTrendDaily(asxSlice) });
  factors.push({ w: 0.1, s: scoreVolume(asxSlice) });
  factors.push({ w: 0.1, s: scoreOBV(asxSlice) });
  if (goldSlice && goldSlice.length >= 2) {
    const gChg = ((goldSlice[goldSlice.length - 1].c - goldSlice[goldSlice.length - 2].c) / goldSlice[goldSlice.length - 2].c) * 100;
    factors.push({ w: 0.1, s: gChg > 1.5 ? -0.3 : gChg < -1.5 ? 0.3 : 0 });
  }
  const acVal = autocorrelation(closes);
  factors.push({ w: 0.1, s: acVal != null ? (acVal > 0.15 ? 0.3 : acVal < -0.15 ? -0.3 : 0) : 0 });
  factors.push({ w: 0.1, s: scoreHurst(closes) });

  let totalWS = 0, totalW = 0;
  for (const f of factors) { totalWS += f.s * f.w; totalW += f.w; }
  const score = totalW > 0 ? totalWS / totalW : 0;

  const rawFactors = {
    spx: factors[0]?.s || 0, vixChg: factors[1]?.s || 0, oil: factors[2]?.s || 0,
    aud: factors[3]?.s || 0, cont1d: factors[4]?.s || 0, cont3d: factors[5]?.s || 0,
    consec: factors[6]?.s || 0, zscore: factors[7]?.s || 0, meanRev: factors[8]?.s || 0,
    vixLevel: factors[9]?.s || 0, wr: factors[10]?.s || 0, boll: factors[11]?.s || 0,
    calendar: factors[12]?.s || 0, bond: factors[13]?.s || 0, crisis: factors[14]?.s || 0,
  };

  return { score, regime, crisis: crisis.active, crisisSignals: crisis.signals, factors: factors.length, rawFactors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALK-FORWARDED WEIGHTS & THRESHOLDS
// These are the LATEST optimized parameters from the most recent walk-forward
// window of backtest-10yr.js. Updated periodically when backtest is re-run.
// ═══════════════════════════════════════════════════════════════════════════════

// Latest walk-forward weights (from most recent training window)
const LIVE_WEIGHTS = {
  wSpx: 10.0, wVixChg: 3.8, wOil: 3.4, wAud: 4.0,
  wCont1d: 2.8, wCont3d: 1.6, wConsec: 3.5, wZscore: 2.1, wMeanRev: 1.8,
  wVixLevel: 1.7, wWr: 1.3, wBoll: 1.0, wCalendar: 0.7, wBond: 0.6, wCrisis: 2.5,
};

// Latest walk-forward thresholds
const LIVE_PARAMS = {
  bullBase: 0.07, bearBase: -0.13,
  bullCrisis: 0.15, bearCrisis: -0.20,
  bullVol: 0.12, bearVol: -0.16,
  bullQuiet: 0.05, bearQuiet: -0.09,
  bullTrend: 0.06, bearTrend: -0.11,
  bullMR: 0.09, bearMR: -0.15,
};

function scoreWithWeights(rawFactors, weights) {
  const vals = [
    rawFactors.spx * weights.wSpx, rawFactors.vixChg * weights.wVixChg,
    rawFactors.oil * weights.wOil, rawFactors.aud * weights.wAud,
    rawFactors.cont1d * weights.wCont1d, rawFactors.cont3d * weights.wCont3d,
    rawFactors.consec * weights.wConsec, rawFactors.zscore * weights.wZscore,
    rawFactors.meanRev * weights.wMeanRev, rawFactors.vixLevel * weights.wVixLevel,
    rawFactors.wr * weights.wWr, rawFactors.boll * weights.wBoll,
    rawFactors.calendar * weights.wCalendar, rawFactors.bond * weights.wBond,
    rawFactors.crisis * weights.wCrisis,
  ];
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  return totalW > 0 ? vals.reduce((a, b) => a + b, 0) / totalW : 0;
}

function applyThresholds(score, regime, crisis, params) {
  let bullThresh = params.bullBase, bearThresh = params.bearBase;
  if (crisis) { bullThresh = params.bullCrisis; bearThresh = params.bearCrisis; }
  else if (regime === 'VOLATILE') { bullThresh = params.bullVol; bearThresh = params.bearVol; }
  else if (regime === 'QUIET') { bullThresh = params.bullQuiet; bearThresh = params.bearQuiet; }
  else if (regime === 'TRENDING') { bullThresh = params.bullTrend; bearThresh = params.bearTrend; }
  else if (regime === 'MEAN_REVERTING') { bullThresh = params.bullMR; bearThresh = params.bearMR; }
  return score > bullThresh ? 'BULL' : score < bearThresh ? 'BEAR' : 'NEUTRAL';
}

function getLeverage(score) {
  const abs = Math.abs(score);
  if (abs >= 0.4) return 2.5;
  if (abs >= 0.3) return 2.0;
  if (abs >= 0.2) return 1.5;
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IG MARKETS API — REST client for AU live account
// ═══════════════════════════════════════════════════════════════════════════════

class IGClient {
  constructor(apiKey, username, password, isDemo = false) {
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;
    this.baseUrl = isDemo ? IG_DEMO_URL : IG_API_URL;
    this.cst = null;
    this.securityToken = null;
    this.accountId = null;
  }

  async login() {
    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IG-API-KEY': this.apiKey,
        'VERSION': '2',
      },
      body: JSON.stringify({
        identifier: this.username,
        password: this.password,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`IG login failed (${res.status}): ${err}`);
    }

    this.cst = res.headers.get('CST');
    this.securityToken = res.headers.get('X-SECURITY-TOKEN');

    const data = await res.json();
    this.accountId = data.currentAccountId;
    return data;
  }

  getHeaders(version = '2') {
    return {
      'Content-Type': 'application/json',
      'X-IG-API-KEY': this.apiKey,
      'CST': this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
      'VERSION': version,
    };
  }

  async getAccounts() {
    const res = await fetch(`${this.baseUrl}/accounts`, {
      headers: this.getHeaders('1'),
    });
    if (!res.ok) throw new Error(`IG accounts failed: ${res.status}`);
    return res.json();
  }

  async getPositions() {
    const res = await fetch(`${this.baseUrl}/positions`, {
      headers: this.getHeaders('2'),
    });
    if (!res.ok) throw new Error(`IG positions failed: ${res.status}`);
    return res.json();
  }

  async closePosition(dealId, direction, size) {
    // IG uses DELETE method with _method override for closing
    const res = await fetch(`${this.baseUrl}/positions/otc`, {
      method: 'POST',
      headers: {
        ...this.getHeaders('1'),
        '_method': 'DELETE',
      },
      body: JSON.stringify({
        dealId,
        direction: direction === 'BUY' ? 'SELL' : 'BUY', // opposite to close
        size: size.toString(),
        orderType: 'MARKET',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`IG close position failed: ${err}`);
    }
    return res.json();
  }

  async openPosition(direction, size, epic = ASX_EPIC) {
    const res = await fetch(`${this.baseUrl}/positions/otc`, {
      method: 'POST',
      headers: this.getHeaders('2'),
      body: JSON.stringify({
        epic,
        direction, // 'BUY' or 'SELL'
        size: size.toString(),
        orderType: 'MARKET',
        currencyCode: 'AUD',
        forceOpen: true,
        guaranteedStop: false,
        expiry: 'DFB', // Daily funded bet (rolling daily)
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`IG open position failed: ${err}`);
    }
    return res.json();
  }

  async confirmDeal(dealReference) {
    const res = await fetch(`${this.baseUrl}/confirms/${dealReference}`, {
      headers: this.getHeaders('1'),
    });
    if (!res.ok) throw new Error(`IG confirm failed: ${res.status}`);
    return res.json();
  }

  async getMarketInfo(epic = ASX_EPIC) {
    const res = await fetch(`${this.baseUrl}/markets/${epic}`, {
      headers: this.getHeaders('3'),
    });
    if (!res.ok) throw new Error(`IG market info failed: ${res.status}`);
    return res.json();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — Netlify Scheduled Function
// ═══════════════════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  // Allow manual trigger via HTTP as well as scheduled
  const isScheduled = event.httpMethod === undefined;
  const now = new Date();
  const log = [];
  const addLog = (msg) => { log.push(`[${new Date().toISOString()}] ${msg}`); console.log(msg); };

  try {
    addLog('═══ ApexTrade Auto-Execution Starting ═══');

    // ── Check kill switch ─────────────────────────────────────────────────
    const tradeEnabled = process.env.TRADE_ENABLED !== 'false';
    if (!tradeEnabled) {
      addLog('⛔ TRADE_ENABLED is false — skipping execution');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'disabled', log }) };
    }

    // ── Check if it's a trading day (Mon-Fri) ─────────────────────────────
    // AEST = UTC + 10
    const aestHour = (now.getUTCHours() + 10) % 24;
    const aestDay = new Date(now.getTime() + 10 * 3600000).getUTCDay();
    if (aestDay === 0 || aestDay === 6) {
      addLog('📅 Weekend — no trade today');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'weekend', log }) };
    }

    // ── Validate IG credentials ───────────────────────────────────────────
    const igApiKey = process.env.IG_API_KEY;
    const igUsername = process.env.IG_USERNAME;
    const igPassword = process.env.IG_PASSWORD;
    const isDemo = process.env.IG_DEMO === 'true';

    if (!igApiKey || !igUsername || !igPassword) {
      addLog('❌ Missing IG credentials (IG_API_KEY, IG_USERNAME, IG_PASSWORD)');
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing IG credentials', log }) };
    }

    // ── Step 1: Fetch market data ─────────────────────────────────────────
    addLog('📡 Fetching market data...');
    const [asxData, vixData, goldData, oilData, audData, bondData, spxData] = await Promise.all([
      safeFetch('^AXJO', '2y'),
      safeFetch('^VIX', '2y'),
      safeFetch('GC=F', '6mo'),
      safeFetch('CL=F', '6mo'),
      safeFetch('AUDUSD=X', '6mo'),
      safeFetch('^TNX', '6mo'),
      safeFetch('^GSPC', '6mo'),
    ]);

    if (!asxData || asxData.length < 200) {
      addLog(`❌ Insufficient ASX data: ${asxData?.length || 0} bars`);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Insufficient data', log }) };
    }
    addLog(`  ASX: ${asxData.length} bars | VIX: ${vixData?.length || 0} | SPX: ${spxData?.length || 0}`);

    // ── Step 2: Generate signal ───────────────────────────────────────────
    addLog('🧠 Generating signal...');
    const signal = generateDayScore(asxData, vixData, goldData, oilData, audData, bondData, spxData);

    // Apply walk-forwarded weights to raw factors
    const weightedScore = scoreWithWeights(signal.rawFactors, LIVE_WEIGHTS);
    const direction = applyThresholds(weightedScore, signal.regime, signal.crisis, LIVE_PARAMS);
    const leverage = getLeverage(weightedScore);

    addLog(`  Score: ${weightedScore.toFixed(4)}`);
    addLog(`  Direction: ${direction}`);
    addLog(`  Regime: ${signal.regime}`);
    addLog(`  Crisis: ${signal.crisis ? '⚠️ YES' : 'No'}`);
    addLog(`  Leverage: ${leverage}x`);
    addLog(`  Factors: ${JSON.stringify(signal.rawFactors)}`);

    // ── Step 3: Connect to IG Markets ─────────────────────────────────────
    addLog('🔗 Connecting to IG Markets...');
    const ig = new IGClient(igApiKey, igUsername, igPassword, isDemo);
    const session = await ig.login();
    addLog(`  Logged in as: ${session.currentAccountId}`);

    // Get account balance
    const accounts = await ig.getAccounts();
    const account = accounts.accounts?.find(a => a.accountId === session.currentAccountId);
    const balance = account?.balance?.balance || 0;
    const available = account?.balance?.available || 0;
    addLog(`  Balance: $${balance.toFixed(2)} | Available: $${available.toFixed(2)}`);

    // ── Safety check: max daily loss ──────────────────────────────────────
    const maxDailyLoss = balance * 0.05; // 5% max daily loss
    const todayPnl = account?.balance?.profitLoss || 0;
    if (todayPnl < -maxDailyLoss) {
      addLog(`⛔ Daily loss limit hit: $${todayPnl.toFixed(2)} (limit: -$${maxDailyLoss.toFixed(2)})`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'daily_loss_limit', todayPnl, log }) };
    }

    // ── Step 4: Check current positions ───────────────────────────────────
    addLog('📊 Checking current positions...');
    const positions = await ig.getPositions();
    const asxPositions = positions.positions?.filter(p =>
      p.market?.epic === ASX_EPIC || p.market?.instrumentName?.includes('Australia 200')
    ) || [];

    addLog(`  Current ASX positions: ${asxPositions.length}`);
    for (const pos of asxPositions) {
      addLog(`    ${pos.position.direction} ${pos.position.size} @ ${pos.position.openLevel} (P&L: ${pos.position.currency} ${pos.position?.profitLoss || 'N/A'})`);
    }

    // ── Step 5: Execute trade ─────────────────────────────────────────────
    const igDirection = direction === 'BULL' ? 'BUY' : direction === 'BEAR' ? 'SELL' : null;

    // Get market info for position sizing
    const marketInfo = await ig.getMarketInfo();
    const minSize = marketInfo.dealingRules?.minDealSize?.value || 1;
    const asxPrice = marketInfo.snapshot?.bid || 8000;
    addLog(`  ASX 200 Price: ${asxPrice} | Min size: ${minSize}`);

    // Calculate position size: full equity / price per point, scaled by leverage
    // For ASX 200 CFD on IG, size is in "contracts" where 1 contract = $1/point
    // So $5000 balance at 1x leverage = $5000 / 1 = 5000 * contractValueFactor
    // IG ASX200: 1 contract = AUD $1 per point movement
    // We want to risk full balance with leverage applied
    const targetExposure = available * leverage;
    // Size in contracts: how many $1/point contracts
    // Risk per point = size * $1. We want total exposure ≈ targetExposure
    // A rough sizing: balance / (price * valuePerPoint) but for CFDs, it's simpler
    // IG uses "size" as number of contracts, value per point = $1 per contract
    // Margin required = size * marginFactor * price
    const marginFactor = marketInfo.instrument?.marginFactor || 5; // typically 5% for ASX200
    const marginPercent = parseFloat(marginFactor) / 100;
    // Max size we can afford: available / (marginPercent * price)
    let size = Math.floor(available / (marginPercent * asxPrice));
    // Apply leverage multiplier (within margin constraints)
    size = Math.max(minSize, Math.min(size, Math.floor(targetExposure / (marginPercent * asxPrice))));
    addLog(`  Calculated size: ${size} contracts (leverage: ${leverage}x)`);

    if (direction === 'NEUTRAL') {
      // Close any existing positions
      if (asxPositions.length > 0) {
        addLog('⚪ NEUTRAL signal — closing existing positions');
        for (const pos of asxPositions) {
          const closeResult = await ig.closePosition(pos.position.dealId, pos.position.direction, pos.position.size);
          const confirm = await ig.confirmDeal(closeResult.dealReference);
          addLog(`  Closed: ${confirm.dealStatus} (${confirm.reason || 'OK'})`);
        }
      } else {
        addLog('⚪ NEUTRAL signal — no positions to close, sitting out');
      }
    } else {
      // Check if we need to flip direction
      const currentDir = asxPositions.length > 0 ? asxPositions[0].position.direction : null;
      const needsFlip = currentDir && currentDir !== igDirection;
      const needsOpen = !currentDir;

      if (needsFlip) {
        // Close existing position first
        addLog(`🔄 Flipping from ${currentDir} to ${igDirection}`);
        for (const pos of asxPositions) {
          const closeResult = await ig.closePosition(pos.position.dealId, pos.position.direction, pos.position.size);
          const confirm = await ig.confirmDeal(closeResult.dealReference);
          addLog(`  Closed old: ${confirm.dealStatus}`);
        }
      }

      if (needsFlip || needsOpen) {
        // Open new position
        addLog(`📈 Opening ${igDirection} position: ${size} contracts`);
        const openResult = await ig.openPosition(igDirection, size);
        const confirm = await ig.confirmDeal(openResult.dealReference);
        addLog(`  Opened: ${confirm.dealStatus} at ${confirm.level} (${confirm.reason || 'OK'})`);

        if (confirm.dealStatus !== 'ACCEPTED') {
          addLog(`  ⚠️ Deal rejected: ${confirm.reason}`);
        }
      } else {
        // Already in the right direction — check if size needs adjusting
        const currentSize = asxPositions.reduce((a, p) => a + p.position.size, 0);
        addLog(`  Already ${igDirection} with ${currentSize} contracts — holding`);
      }
    }

    // ── Build response ────────────────────────────────────────────────────
    const result = {
      status: 'executed',
      timestamp: now.toISOString(),
      signal: {
        score: +weightedScore.toFixed(4),
        direction,
        regime: signal.regime,
        crisis: signal.crisis,
        leverage,
        rawFactors: signal.rawFactors,
      },
      account: {
        balance: +balance.toFixed(2),
        available: +available.toFixed(2),
      },
      log,
    };

    addLog('═══ Auto-Execution Complete ═══');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(result, null, 2),
    };

  } catch (error) {
    addLog(`❌ ERROR: ${error.message}`);
    console.error(error);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: error.message, log }),
    };
  }
};
