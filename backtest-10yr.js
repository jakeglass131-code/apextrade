#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// ApexTrade Max-Range Walk-Forward Backtest
// ═══════════════════════════════════════════════════════════════════════════════
// Fetches 10+ years of daily data for ASX 200 and intermarket assets,
// then walks forward day-by-day applying the quant model's scoring logic
// to generate next-day predictions. Compares predictions to actual returns.
//
// Usage: node backtest-10yr.js
// ═══════════════════════════════════════════════════════════════════════════════

const LOOKBACK = 60; // Minimum bars needed before we can generate a signal

// ── Yahoo Finance data fetcher ──────────────────────────────────────────────
async function yahooChart(symbol, range = 'max', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexTrade-Multi/1.0)' },
    signal: AbortSignal.timeout(20000),
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

async function safeFetch(symbol, range = 'max') {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await yahooChart(symbol, range);
      if (data && data.length > 500) return data;
      // Got too little data, retry after a pause
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      if (attempt === 2) { console.warn(`  ⚠ ${symbol}: ${e.message}`); return null; }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR LIBRARY (copied from predict-v2.js for standalone execution)
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

function cci(candles, period = 20) {
  if (candles.length < period) return null;
  const tps = candles.slice(-period).map(c => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  return meanDev === 0 ? 0 : (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}

function mfi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const rawFlow = tp * candles[i].v;
    if (tp > prevTp) posFlow += rawFlow; else negFlow += rawFlow;
  }
  return negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
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

function roc(closes, period = 12) {
  if (closes.length < period + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
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

function zScore(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = []; for (let i = closes.length - period; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return std === 0 ? 0 : (rets[rets.length - 1] - mean) / std;
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

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS — same logic as predict-v2.js
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
  if (h > 0.6) return 0.3; // trending, go with momentum
  if (h < 0.4) return -0.2; // mean reverting
  return 0;
}

function scoreIntermarket(imChg) {
  if (imChg == null) return 0;
  return imChg > 1 ? 0.6 : imChg > 0.3 ? 0.3 : imChg < -1 ? -0.6 : imChg < -0.3 ? -0.3 : 0;
}

function scoreVIX(vixVal) {
  if (vixVal == null) return 0;
  if (vixVal > 35) return -1.0; if (vixVal > 25) return -0.5;
  if (vixVal < 14) return 0.3;
  return 0;
}

function scoreCalendar(date) {
  const dow = date.getUTCDay(); // 0=Sun
  if (dow === 1) return -0.15; // Monday weakness
  if (dow === 5) return 0.15;  // Friday strength
  const month = date.getUTCMonth();
  if (month === 0 || month === 10) return 0.1; // Jan, Nov
  if (month === 8) return -0.1; // Sep
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME DETECTION
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

// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS DETECTION — Change 1
// Detects market crisis using VIX velocity, correlation breakdown, gap analysis
// When crisis detected: dampen futures, boost VIX, widen thresholds
// ═══════════════════════════════════════════════════════════════════════════════
function detectCrisis(vixSlice, spxSlice, asxSlice) {
  const crisis = { active: false, severity: 0, signals: [] };

  // 1. VIX velocity — 40%+ jump over 3 trading days
  if (vixSlice && vixSlice.length >= 4) {
    const vixNow = vixSlice[vixSlice.length - 1].c;
    const vix3dAgo = vixSlice[vixSlice.length - 4].c;
    const vixVelocity = ((vixNow - vix3dAgo) / vix3dAgo) * 100;
    if (vixVelocity > 40) {
      crisis.severity += 3;
      crisis.signals.push('VIX_VELOCITY');
    } else if (vixVelocity > 25) {
      crisis.severity += 2;
      crisis.signals.push('VIX_ELEVATED');
    }
    // Absolute VIX level check
    if (vixNow > 35) {
      crisis.severity += 2;
      crisis.signals.push('VIX_EXTREME');
    } else if (vixNow > 28) {
      crisis.severity += 1;
      crisis.signals.push('VIX_HIGH');
    }
  }

  // 2. SPX gap analysis — large overnight gaps signal panic
  if (spxSlice && spxSlice.length >= 2) {
    const spxChg = Math.abs((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 2].c) / spxSlice[spxSlice.length - 2].c) * 100;
    if (spxChg > 4.0) {
      crisis.severity += 2;
      crisis.signals.push('SPX_GAP');
    }
    // 3-day SPX drawdown
    if (spxSlice.length >= 4) {
      const spx3dChg = ((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 4].c) / spxSlice[spxSlice.length - 4].c) * 100;
      if (spx3dChg < -6) {
        crisis.severity += 2;
        crisis.signals.push('SPX_DRAWDOWN');
      }
    }
  }

  // 3. ASX gap / correlation breakdown
  if (asxSlice && asxSlice.length >= 2) {
    const asxChg = Math.abs((asxSlice[asxSlice.length - 1].c - asxSlice[asxSlice.length - 2].c) / asxSlice[asxSlice.length - 2].c) * 100;
    if (asxChg > 3.5) {
      crisis.severity += 1;
      crisis.signals.push('ASX_GAP');
    }
  }

  crisis.active = crisis.severity >= 3;
  return crisis;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING — generates a score for a single day using all available data
// ═══════════════════════════════════════════════════════════════════════════════

function generateDayScore(asxSlice, vixSlice, goldSlice, oilSlice, audSlice, bondSlice, spxSlice) {
  const closes = asxSlice.map(c => c.c);
  const lastPrice = closes[closes.length - 1];

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIMIZER-TUNED 3-Tier Factor System (v3.0)
  // Changes: Crisis Detection, Asymmetric BEAR, VIX-Conditional Futures,
  //          Dynamic Regime Weights, Improved Position Sizing
  // ═══════════════════════════════════════════════════════════════════════════
  const regime = detectRegime(asxSlice, closes);
  const crisis = detectCrisis(vixSlice, spxSlice, asxSlice);

  // ═══ Change 4: Dynamic Regime Weight Multipliers ═══
  // Moderate adjustments: 1.3/0.7 instead of 2.0/0.3 to avoid noise
  const regimeMultipliers = {
    TRENDING:       { trend: 1.3, contrarian: 0.7, momentum: 1.2, volatility: 0.9, macro: 1.0 },
    MEAN_REVERTING: { trend: 0.7, contrarian: 1.3, momentum: 0.8, volatility: 1.0, macro: 1.0 },
    VOLATILE:       { trend: 0.8, contrarian: 0.9, momentum: 0.8, volatility: 1.3, macro: 0.9 },
    QUIET:          { trend: 1.0, contrarian: 1.1, momentum: 1.0, volatility: 0.7, macro: 1.1 },
    NORMAL:         { trend: 1.0, contrarian: 1.0, momentum: 1.0, volatility: 1.0, macro: 1.0 },
  };
  const rm = regimeMultipliers[regime] || regimeMultipliers.NORMAL;

  const factors = [];

  // ═══ TIER 1: ALPHA FACTORS — these DRIVE the prediction ═══

  // ═══ Change 3: VIX-Conditional Futures Weight ═══
  // When VIX is extreme (>35), SPX futures become unreliable — reduce weight
  // When VIX is low (<14), SPX is highly predictive — increase weight
  let spxWeight = 10.0; // base
  if (vixSlice && vixSlice.length >= 1) {
    const currentVIX = vixSlice[vixSlice.length - 1].c;
    if (crisis.active) spxWeight = 2.0;       // Crisis: SPX is noise
    else if (currentVIX > 35) spxWeight = 3.0; // High fear: unreliable
    else if (currentVIX > 25) spxWeight = 6.0; // Elevated: reduce
    else if (currentVIX < 14) spxWeight = 12.0; // Calm: SPX very predictive
    // else keep 10.0
  }

  // Overnight S&P 500 move (VIX-conditional weight)
  if (spxSlice && spxSlice.length >= 2) {
    const spxChg = ((spxSlice[spxSlice.length - 1].c - spxSlice[spxSlice.length - 2].c) / spxSlice[spxSlice.length - 2].c) * 100;
    let s = 0;
    // Widen extreme thresholds during high VIX (more room for "moderate" signal)
    const extremeThresh = crisis.active ? 4.5 : (vixSlice && vixSlice.length >= 1 && vixSlice[vixSlice.length - 1].c > 25) ? 3.5 : 2.9;
    if (spxChg > extremeThresh) s = 0.2;       // Extreme up → capped
    else if (spxChg > 0.55) s = 0.8;            // Moderate up → strong bull
    else if (spxChg > 0.1) s = 0.3;             // Small up → mild bull
    else if (spxChg < -extremeThresh) s = -0.2; // Extreme down → capped
    else if (spxChg < -0.55) s = -0.8;          // Moderate down → strong bear
    else if (spxChg < -0.1) s = -0.3;           // Small down → mild bear
    factors.push({ w: spxWeight * rm.trend, s });
  }

  // VIX change — weight boosted during crisis (Change 1 + 3)
  if (vixSlice && vixSlice.length >= 2) {
    const vixChg = ((vixSlice[vixSlice.length - 1].c - vixSlice[vixSlice.length - 2].c) / vixSlice[vixSlice.length - 2].c) * 100;
    const vixChangeWeight = crisis.active ? 5.0 : 3.8;
    let s = 0;
    if (crisis.active && vixChg > 14) s = -0.3; // During crisis, big VIX spike = bear
    else if (vixChg > 14) s = 0;                  // Normal: big spike unreliable
    else if (vixChg > 3) s = 0.3;
    else if (vixChg < -8) s = -0.3;
    else if (vixChg < -3) s = -0.15;
    factors.push({ w: vixChangeWeight * rm.volatility, s });
  }

  // Oil — pro-cyclical for ASX miners (w:3.4)
  if (oilSlice && oilSlice.length >= 2) {
    const oChg = ((oilSlice[oilSlice.length - 1].c - oilSlice[oilSlice.length - 2].c) / oilSlice[oilSlice.length - 2].c) * 100;
    let s = 0;
    if (oChg > 3) s = 0.8;
    else if (oChg > 1) s = 0.3;
    else if (oChg < -3) s = -0.8;
    else if (oChg < -1) s = -0.3;
    factors.push({ w: 3.4 * rm.macro, s });
  }

  // AUD/USD — risk appetite proxy (w:4.0)
  if (audSlice && audSlice.length >= 2) {
    const aChg = ((audSlice[audSlice.length - 1].c - audSlice[audSlice.length - 2].c) / audSlice[audSlice.length - 2].c) * 100;
    let s = 0;
    if (aChg > 1.0) s = 0.8;
    else if (aChg > 0.3) s = 0.3;
    else if (aChg < -1.0) s = -0.8;
    else if (aChg < -0.3) s = -0.3;
    factors.push({ w: 4.0 * rm.macro, s });
  }

  // 1-Day Contrarian (w:2.8) — regime-adjusted
  {
    const ret1d = closes.length >= 2 ? (closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2] * 100 : 0;
    let s = 0;
    if (ret1d > 1.6) s = -0.8;
    else if (ret1d > 0.02) s = -0.3;
    else if (ret1d < -1.6) s = 0.8;
    else if (ret1d < -0.02) s = 0.3;
    factors.push({ w: 2.8 * rm.contrarian, s });
  }

  // 3-Day Contrarian (w:1.6) — regime-adjusted
  {
    const ret3d = closes.length >= 4 ? (closes[closes.length-1] - closes[closes.length-4]) / closes[closes.length-4] * 100 : 0;
    let s = 0;
    if (ret3d > 2.0) s = -0.5;
    else if (ret3d > 1.0) s = -0.3;
    else if (ret3d < -2.0) s = 0.5;
    else if (ret3d < -1.0) s = 0.3;
    factors.push({ w: 1.6 * rm.contrarian, s });
  }

  // ═══ TIER 2: EDGE FACTORS — supplementary signal ═══

  // Consecutive Days — streak exhaustion (w:3.5, biggest edge factor)
  factors.push({ w: 3.5 * rm.contrarian, s: scoreConsecutive(asxSlice) });

  // Z-Score (w:2.1)
  factors.push({ w: 2.1 * rm.contrarian, s: scoreZScore(closes) });

  // Mean Reversion (w:1.8)
  factors.push({ w: 1.8 * rm.contrarian, s: scoreMeanReversion(closes) });

  // VIX Level — boosted during crisis (w:1.7 base, 5.0 crisis)
  if (vixSlice && vixSlice.length >= 1) {
    const vixLevelWeight = crisis.active ? 5.0 : 1.7;
    factors.push({ w: vixLevelWeight * rm.volatility, s: scoreVIX(vixSlice[vixSlice.length - 1].c) });
  }

  // Williams %R (w:1.3)
  const wrVal = williamsR(asxSlice);
  factors.push({ w: 1.3 * rm.momentum, s: wrVal != null ? (wrVal > -20 ? -0.5 : wrVal < -80 ? 0.5 : 0) : 0 });

  // Bollinger (w:1.0)
  factors.push({ w: 1.0 * rm.volatility, s: scoreBollinger(closes) });

  // Calendar — day-of-week & seasonal (w:0.7)
  const date = new Date(asxSlice[asxSlice.length - 1].t);
  factors.push({ w: 0.7, s: scoreCalendar(date) });

  // Bond yields (w:0.6)
  if (bondSlice && bondSlice.length >= 2) {
    const bChg = ((bondSlice[bondSlice.length - 1].c - bondSlice[bondSlice.length - 2].c) / bondSlice[bondSlice.length - 2].c) * 100;
    factors.push({ w: 0.6 * rm.macro, s: bChg > 3 ? -0.3 : bChg < -3 ? 0.3 : 0 });
  }

  // ═══ Crisis Dampener Factor (Change 1) ═══
  // When crisis is active, inject a moderate BEAR pressure factor
  if (crisis.active) {
    const crisisSeverityScore = Math.min(0.6, crisis.severity * 0.10);
    factors.push({ w: 2.5, s: -crisisSeverityScore });
  }

  // ═══ TIER 3: DISPLAY-ONLY — noise/negative IC, near-zero weight ═══
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

  // Weighted average
  let totalWS = 0, totalW = 0;
  for (const f of factors) { totalWS += f.s * f.w; totalW += f.w; }
  const score = totalW > 0 ? totalWS / totalW : 0;

  // Also return raw factor signals (unweighted) for walk-forward weight optimization
  // Group into named factors with their raw signal values
  const rawFactors = {
    spx: factors[0]?.s || 0,           // SPX futures
    vixChg: factors[1]?.s || 0,        // VIX change
    oil: factors[2]?.s || 0,           // Oil
    aud: factors[3]?.s || 0,           // AUD/USD
    cont1d: factors[4]?.s || 0,        // 1-day contrarian
    cont3d: factors[5]?.s || 0,        // 3-day contrarian
    consec: factors[6]?.s || 0,        // Consecutive days
    zscore: factors[7]?.s || 0,        // Z-Score
    meanRev: factors[8]?.s || 0,       // Mean reversion
    vixLevel: factors[9]?.s || 0,      // VIX level
    wr: factors[10]?.s || 0,           // Williams %R
    boll: factors[11]?.s || 0,         // Bollinger
    calendar: factors[12]?.s || 0,     // Calendar
    bond: factors[13]?.s || 0,         // Bond yields
    crisis: factors[14]?.s || 0,       // Crisis dampener (0 if no crisis)
  };

  return { score, regime, crisis: crisis.active, factors: factors.length, rawFactors };
}

// Apply thresholds to get direction — separated for optimizer replay
function applyThresholds(score, regime, crisis, params) {
  let bullThresh = params.bullBase, bearThresh = params.bearBase;
  if (crisis) { bullThresh = params.bullCrisis; bearThresh = params.bearCrisis; }
  else if (regime === 'VOLATILE') { bullThresh = params.bullVol; bearThresh = params.bearVol; }
  else if (regime === 'QUIET') { bullThresh = params.bullQuiet; bearThresh = params.bearQuiet; }
  else if (regime === 'TRENDING') { bullThresh = params.bullTrend; bearThresh = params.bearTrend; }
  else if (regime === 'MEAN_REVERTING') { bullThresh = params.bullMR; bearThresh = params.bearMR; }

  return score > bullThresh ? 'BULL' : score < bearThresh ? 'BEAR' : 'NEUTRAL';
}

const DEFAULT_PARAMS = {
  // Thresholds
  bullBase: 0.07, bearBase: -0.13,
  bullCrisis: 0.15, bearCrisis: -0.20,
  bullVol: 0.12, bearVol: -0.16,
  bullQuiet: 0.05, bearQuiet: -0.09,
  bullTrend: 0.06, bearTrend: -0.11,
  bullMR: 0.09, bearMR: -0.15,
  // Position sizing
  posBase: 0.8, posScale: 1.0, posMax: 1.0,
  highConvThresh: 0.25, highConvMult: 1.0, // full size always
  kellyLookback: 120, kellyMult: 1.0, kellyFloor: 0.8,
  ddStart: 2, ddRate: 0.15, ddMin: 0.2,
  lossStreakPenalty: 0.1, lossStreakFloor: 0.5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// WALK-FORWARD BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function alignByDate(primary, ...others) {
  // Build date → index maps for each series
  const dateMap = new Map();
  for (let i = 0; i < primary.length; i++) {
    const d = new Date(primary[i].t).toISOString().slice(0, 10);
    dateMap.set(d, i);
  }
  return { dateMap, primaryDates: [...dateMap.keys()] };
}

function findSliceUpTo(candles, date, maxBars = 500) {
  if (!candles) return null;
  const dateStr = new Date(date).toISOString().slice(0, 10);
  let endIdx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (new Date(candles[i].t).toISOString().slice(0, 10) <= dateStr) { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  return candles.slice(Math.max(0, endIdx - maxBars), endIdx + 1);
}

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' ApexTrade Max-Range Walk-Forward Backtest');
  console.log(' Prediction Engine v3.0 — Crisis-Aware Dynamic Regime Model');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Fetch all data
  console.log('📡 Fetching 10+ years of historical data...\n');
  const [asxData, vixData, goldData, oilData, audData, bondData, spxData] = await Promise.all([
    safeFetch('^AXJO', '25y'),      // ASX 200
    safeFetch('^VIX', '25y'),       // VIX
    safeFetch('GC=F', '25y'),       // Gold
    safeFetch('CL=F', '25y'),       // Oil
    safeFetch('AUDUSD=X', '25y'),   // AUD/USD
    safeFetch('^TNX', '25y'),       // US 10Y yield
    safeFetch('^GSPC', '25y'),      // S&P 500
  ]);

  if (!asxData || asxData.length < 500) {
    console.error('❌ Insufficient ASX data. Got', asxData?.length || 0, 'bars. Retrying may help.');
    return;
  }
  console.log(`\n  📊 Total bars received — should be 6000+ for max range`);

  console.log(`  ASX 200:  ${asxData.length} bars (${new Date(asxData[0].t).toISOString().slice(0,10)} → ${new Date(asxData[asxData.length-1].t).toISOString().slice(0,10)})`);
  console.log(`  VIX:      ${vixData?.length || 0} bars`);
  console.log(`  Gold:     ${goldData?.length || 0} bars`);
  console.log(`  Oil:      ${oilData?.length || 0} bars`);
  console.log(`  AUD/USD:  ${audData?.length || 0} bars`);
  console.log(`  US 10Y:   ${bondData?.length || 0} bars`);
  console.log(`  S&P 500:  ${spxData?.length || 0} bars`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: PRECOMPUTE raw signals (expensive — do once)
  // ═══════════════════════════════════════════════════════════════════════════
  const startIdx = Math.max(LOOKBACK + 200, 252);
  console.log(`\n⏳ Precomputing raw signals for ${asxData.length - startIdx - 1} trading days...`);
  const precomputed = [];
  const progressInterval = Math.floor((asxData.length - startIdx - 1) / 20);
  for (let i = startIdx; i < asxData.length - 1; i++) {
    if ((i - startIdx) % progressInterval === 0) {
      process.stdout.write(`\r   Progress: ${((i - startIdx) / (asxData.length - startIdx - 1) * 100).toFixed(0)}%`);
    }
    const dayDate = asxData[i].t;
    const asxSlice = asxData.slice(Math.max(0, i - 500), i + 1);
    try {
      const signal = generateDayScore(asxSlice,
        findSliceUpTo(vixData, dayDate, 200), findSliceUpTo(goldData, dayDate, 50),
        findSliceUpTo(oilData, dayDate, 50), findSliceUpTo(audData, dayDate, 50),
        findSliceUpTo(bondData, dayDate, 50), findSliceUpTo(spxData, dayDate, 50));
      precomputed.push({
        date: new Date(dayDate).toISOString().slice(0, 10),
        year: new Date(dayDate).getUTCFullYear(),
        score: signal.score, regime: signal.regime, crisis: signal.crisis,
        rawFactors: signal.rawFactors,
        actualReturn: (asxData[i + 1].c - asxData[i].c) / asxData[i].c,
      });
    } catch(e) {}
  }
  console.log(`\r   Precomputed ${precomputed.length} signals.                    \n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // REALISTIC COSTS
  // ═══════════════════════════════════════════════════════════════════════════
  const COST_PER_TRADE = 0.0008;  // 0.08% brokerage round-trip (ASX CFD/ETF)
  const SLIPPAGE       = 0.0003;  // 0.03% slippage per trade (market impact)
  const FUNDING_RATE   = 0.065;   // 6.5% p.a. overnight funding on leveraged portion
  const DAILY_FUNDING  = FUNDING_RATE / 252; // per trading day

  // Conviction-based leverage tiers
  function getLeverage(score) {
    const abs = Math.abs(score);
    if (abs >= 0.4) return 2.5;
    if (abs >= 0.3) return 2.0;
    if (abs >= 0.2) return 1.5;
    return 1.0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WALK-FORWARD SCORE — apply optimizable weights to raw factor signals
  // This replaces the hardcoded weights in generateDayScore for replay
  // ═══════════════════════════════════════════════════════════════════════════
  const FACTOR_NAMES = ['spx','vixChg','oil','aud','cont1d','cont3d','consec','zscore','meanRev','vixLevel','wr','boll','calendar','bond','crisis'];

  const DEFAULT_WEIGHTS = {
    wSpx: 10.0, wVixChg: 3.8, wOil: 3.4, wAud: 4.0,
    wCont1d: 2.8, wCont3d: 1.6, wConsec: 3.5, wZscore: 2.1, wMeanRev: 1.8,
    wVixLevel: 1.7, wWr: 1.3, wBoll: 1.0, wCalendar: 0.7, wBond: 0.6, wCrisis: 2.5,
  };
  const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);

  function scoreWithWeights(rawFactors, weights) {
    const vals = [
      rawFactors.spx * weights.wSpx,
      rawFactors.vixChg * weights.wVixChg,
      rawFactors.oil * weights.wOil,
      rawFactors.aud * weights.wAud,
      rawFactors.cont1d * weights.wCont1d,
      rawFactors.cont3d * weights.wCont3d,
      rawFactors.consec * weights.wConsec,
      rawFactors.zscore * weights.wZscore,
      rawFactors.meanRev * weights.wMeanRev,
      rawFactors.vixLevel * weights.wVixLevel,
      rawFactors.wr * weights.wWr,
      rawFactors.boll * weights.wBoll,
      rawFactors.calendar * weights.wCalendar,
      rawFactors.bond * weights.wBond,
      rawFactors.crisis * weights.wCrisis,
    ];
    const totalW = weights.wSpx + weights.wVixChg + weights.wOil + weights.wAud +
      weights.wCont1d + weights.wCont3d + weights.wConsec + weights.wZscore + weights.wMeanRev +
      weights.wVixLevel + weights.wWr + weights.wBoll + weights.wCalendar + weights.wBond + weights.wCrisis;
    return totalW > 0 ? vals.reduce((a,b)=>a+b,0) / totalW : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FAST REPLAY — uses walk-forwarded weights + thresholds + realistic costs
  // ═══════════════════════════════════════════════════════════════════════════
  function replaySim(signals, params, weights, startEquity = 10000) {
    let equity = startEquity, maxEq = startEquity, maxDD = 0;
    let wins = 0;
    let totalPW = 0, totalPL = 0;
    let prevDir = null;
    for (const s of signals) {
      // Recompute score from raw factors using walk-forwarded weights
      const score = s.rawFactors ? scoreWithWeights(s.rawFactors, weights) : s.score;
      const dir = applyThresholds(score, s.regime, s.crisis, params);
      const sd = dir === 'BULL' ? 1 : dir === 'BEAR' ? -1 : 0;
      const won = dir === 'NEUTRAL' ? Math.abs(s.actualReturn) < 0.005
        : (dir === 'BULL' && s.actualReturn > 0) || (dir === 'BEAR' && s.actualReturn < 0);
      const lev = getLeverage(score);
      const pnl = sd * s.actualReturn * lev * equity;
      // Costs: brokerage + slippage on direction changes, overnight funding on leveraged portion
      let cost = 0;
      if (dir !== prevDir) cost += equity * lev * (COST_PER_TRADE + SLIPPAGE);
      if (lev > 1.0) cost += equity * (lev - 1.0) * DAILY_FUNDING; // funding on leveraged part only
      equity += pnl - cost;
      if (equity <= 0) return { equity: 0, accuracy: 0, maxDD: 100, pf: 0, composite: -999, wins: 0, total: signals.length };
      maxEq = Math.max(maxEq, equity);
      maxDD = Math.max(maxDD, (maxEq - equity) / maxEq * 100);
      if (pnl > 0) totalPW += pnl; else totalPL += Math.abs(pnl);
      if (won) { wins++; }
      prevDir = dir;
    }
    const acc = signals.length > 0 ? wins / signals.length : 0;
    const pf = totalPL > 0 ? totalPW / totalPL : 99;
    if (maxDD > 50 || equity < startEquity * 0.5) return { equity: 0, accuracy: acc, maxDD, pf, composite: -999, wins, total: signals.length };
    const logEq = Math.log10(Math.max(1, equity));
    const composite = logEq * 15 + acc * 40 + pf * 2 + Math.max(0, 25 - maxDD) * 0.5;
    return { equity, accuracy: acc, maxDD, pf, composite, wins, total: signals.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WALK-FORWARD OPTIMIZER — Optimizes BOTH signal weights AND thresholds
  // Train on past data, test on unseen future — ZERO hindsight bias
  // ═══════════════════════════════════════════════════════════════════════════
  const TRAIN_DAYS = 756;  // ~3 years training window
  const TEST_DAYS  = 252;  // ~1 year test window

  const THRESH_STEPS = { bullBase:.01,bearBase:.01,bullCrisis:.02,bearCrisis:.02,bullVol:.01,bearVol:.01,
    bullQuiet:.01,bearQuiet:.01,bullTrend:.01,bearTrend:.01,bullMR:.01,bearMR:.01 };
  const WEIGHT_STEPS = { wSpx:1.0,wVixChg:0.5,wOil:0.5,wAud:0.5,wCont1d:0.3,wCont3d:0.3,
    wConsec:0.5,wZscore:0.3,wMeanRev:0.3,wVixLevel:0.3,wWr:0.2,wBoll:0.2,wCalendar:0.1,wBond:0.1,wCrisis:0.3 };

  function optimizeOnWindow(trainSignals) {
    let bestParams = { ...DEFAULT_PARAMS };
    let bestWeights = { ...DEFAULT_WEIGHTS };
    let bestResult = replaySim(trainSignals, bestParams, bestWeights);

    // Phase 1: Grid search on thresholds
    const BULL_R = [0.04,0.06,0.08,0.10,0.12,0.14];
    const BEAR_R = [-0.06,-0.08,-0.10,-0.12,-0.14,-0.16,-0.18];
    for (const bull of BULL_R) for (const bear of BEAR_R) {
      const p = { ...bestParams, bullBase: bull, bearBase: bear,
        bullQuiet: Math.max(0.02, bull-0.03), bearQuiet: bear+0.03,
        bullTrend: Math.max(0.02, bull-0.02), bearTrend: bear+0.02,
        bullVol: bull+0.04, bearVol: bear-0.04,
        bullMR: bull+0.02, bearMR: bear-0.02,
        bullCrisis: bull+0.08, bearCrisis: bear-0.08 };
      const r = replaySim(trainSignals, p, bestWeights);
      if (r.composite > bestResult.composite) { bestResult = r; bestParams = { ...p }; }
    }

    // Phase 2: Hill climb on signal weights
    for (let iter = 0; iter < 10; iter++) {
      let improved = false;
      for (const key of WEIGHT_KEYS) {
        const step = WEIGHT_STEPS[key] || 0.3;
        for (const d of [step, -step, step*2, -step*2]) {
          const w = { ...bestWeights, [key]: Math.max(0, bestWeights[key] + d) };
          const r = replaySim(trainSignals, bestParams, w);
          if (r.composite > bestResult.composite) { bestResult = r; bestWeights = { ...w }; improved = true; }
        }
      }
      if (!improved) break;
    }

    // Phase 3: Hill climb on thresholds with updated weights
    const THRESH_KEYS = Object.keys(THRESH_STEPS);
    for (let iter = 0; iter < 10; iter++) {
      let improved = false;
      for (const key of THRESH_KEYS) {
        const step = THRESH_STEPS[key] || 0.01;
        for (const d of [step, -step, step*2, -step*2]) {
          const p = { ...bestParams, [key]: bestParams[key] + d };
          if (key.startsWith('bull') && p[key] < 0) continue;
          if (key.startsWith('bear') && p[key] > 0) continue;
          const r = replaySim(trainSignals, p, bestWeights);
          if (r.composite > bestResult.composite) { bestResult = r; bestParams = { ...p }; improved = true; }
        }
      }
      if (!improved) break;
    }

    // Phase 4: Random exploration (both weights and thresholds)
    const ALL_KEYS = [...THRESH_KEYS, ...WEIGHT_KEYS];
    const ALL_STEPS = { ...THRESH_STEPS, ...WEIGHT_STEPS };
    for (let r = 0; r < 300; r++) {
      const p = { ...bestParams };
      const w = { ...bestWeights };
      const n = 2 + Math.floor(Math.random() * 4);
      for (let j = 0; j < n; j++) {
        const key = ALL_KEYS[Math.floor(Math.random() * ALL_KEYS.length)];
        const step = ALL_STEPS[key] || 0.1;
        if (WEIGHT_KEYS.includes(key)) {
          w[key] = Math.max(0, w[key] + (Math.random() * 2 - 1) * step * 3);
        } else {
          p[key] += (Math.random() * 2 - 1) * step * 3;
          if (key.startsWith('bull') && p[key] < 0) p[key] = 0.01;
          if (key.startsWith('bear') && p[key] > 0) p[key] = -0.01;
        }
      }
      const res = replaySim(trainSignals, p, w);
      if (res.composite > bestResult.composite) { bestResult = res; bestParams = { ...p }; bestWeights = { ...w }; }
    }

    return { params: bestParams, weights: bestWeights, trainResult: bestResult };
  }

  // ── Run walk-forward ───────────────────────────────────────────────────────
  console.log('🔍 Walk-Forward Optimization (train 3yr → test 1yr, rolling)...');
  console.log(`   Optimizing: signal weights (${WEIGHT_KEYS.length}) + thresholds (${Object.keys(THRESH_STEPS).length})`);
  console.log(`   Costs: ${(COST_PER_TRADE*100).toFixed(2)}% brokerage + ${(SLIPPAGE*100).toFixed(2)}% slippage + ${(FUNDING_RATE*100).toFixed(1)}% p.a. overnight funding`);
  console.log(`   Position sizing: 100% of equity, conviction leverage up to 2.5x`);
  console.log(`   Total signals: ${precomputed.length}\n`);

  const walkForwardResults = [];
  let windowCount = 0;

  for (let start = 0; start + TRAIN_DAYS + TEST_DAYS <= precomputed.length; start += TEST_DAYS) {
    const trainSlice = precomputed.slice(start, start + TRAIN_DAYS);
    const testSlice  = precomputed.slice(start + TRAIN_DAYS, start + TRAIN_DAYS + TEST_DAYS);
    if (testSlice.length < 50) break;

    const { params, weights } = optimizeOnWindow(trainSlice);

    // Apply trained params+weights to UNSEEN test data — recompute scores from raw factors
    for (const s of testSlice) {
      const recomputedScore = s.rawFactors ? scoreWithWeights(s.rawFactors, weights) : s.score;
      walkForwardResults.push({ ...s, score: recomputedScore, wfParams: params, wfWeights: weights });
    }
    windowCount++;
    const trainYears = `${trainSlice[0].date.slice(0,4)}-${trainSlice[trainSlice.length-1].date.slice(0,4)}`;
    const testYears  = `${testSlice[0].date.slice(0,4)}-${testSlice[testSlice.length-1].date.slice(0,4)}`;
    console.log(`   Window ${windowCount}: Train ${trainYears} → Test ${testYears} (${testSlice.length} days)`);
  }
  console.log(`\n   ${windowCount} walk-forward windows, ${walkForwardResults.length} out-of-sample signals\n`);

  const bestParams = walkForwardResults.length > 0 ? walkForwardResults[walkForwardResults.length - 1].wfParams : DEFAULT_PARAMS;
  const bestWeights = walkForwardResults.length > 0 ? walkForwardResults[walkForwardResults.length - 1].wfWeights : DEFAULT_WEIGHTS;

  console.log('── Latest Window Parameters ────────────────────────────────');
  console.log(`  Thresholds: Bull ${bestParams.bullBase.toFixed(3)} / Bear ${bestParams.bearBase.toFixed(3)}`);
  console.log(`  Top weights: SPX ${bestWeights.wSpx.toFixed(1)} | AUD ${bestWeights.wAud.toFixed(1)} | Consec ${bestWeights.wConsec.toFixed(1)} | Oil ${bestWeights.wOil.toFixed(1)} | VIX ${bestWeights.wVixChg.toFixed(1)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FULL REPLAY on OUT-OF-SAMPLE signals — walk-forwarded weights + thresholds
  // Signal weights, thresholds, leverage, costs ALL accounted for
  // ═══════════════════════════════════════════════════════════════════════════
  const results = [];
  const regimeResults = { TRENDING:{wins:0,total:0}, MEAN_REVERTING:{wins:0,total:0}, VOLATILE:{wins:0,total:0}, QUIET:{wins:0,total:0}, NORMAL:{wins:0,total:0} };
  const yearlyResults = {}, monthlyResults = {};
  const directionResults = { BULL:{wins:0,total:0,returns:[]}, BEAR:{wins:0,total:0,returns:[]}, NEUTRAL:{wins:0,total:0,returns:[]} };
  let equity = 10000; const equityCurve = [];
  let maxEquity = equity, maxDrawdown = 0;
  let winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  let totalPnlWin = 0, totalPnlLoss = 0;
  let crisisDays = 0, crisisWins = 0, crisisTotal = 0;
  const tradeHist = [];
  let prevDir = null, totalCosts = 0, totalFunding = 0, totalSlippage = 0, totalBrokerage = 0;
  let maxDDdate = '', maxDDpeak = 0, maxDDtrough = 0;

  for (const s of walkForwardResults) {
    const direction = applyThresholds(s.score, s.regime, s.crisis, s.wfParams);
    const signDir = direction === 'BULL' ? 1 : direction === 'BEAR' ? -1 : 0;
    const actualDir = s.actualReturn > 0.001 ? 'BULL' : s.actualReturn < -0.001 ? 'BEAR' : 'NEUTRAL';
    let won = direction === 'NEUTRAL' ? Math.abs(s.actualReturn) < 0.005
      : (direction === 'BULL' && s.actualReturn > 0) || (direction === 'BEAR' && s.actualReturn < 0);
    if (s.crisis) { crisisDays++; crisisTotal++; if (won) crisisWins++; }

    // Conviction-based leverage
    const lev = getLeverage(s.score);
    const pnl = signDir * s.actualReturn * lev * equity;

    // Realistic costs
    let cost = 0;
    // Brokerage + slippage on direction changes
    if (direction !== prevDir) {
      const brok = equity * lev * COST_PER_TRADE;
      const slip = equity * lev * SLIPPAGE;
      totalBrokerage += brok;
      totalSlippage += slip;
      cost += brok + slip;
    }
    // Overnight funding on leveraged portion (every day you hold leverage)
    if (lev > 1.0) {
      const fund = equity * (lev - 1.0) * DAILY_FUNDING;
      totalFunding += fund;
      cost += fund;
    }
    totalCosts += cost;
    equity += pnl - cost;
    if (equity <= 0) { equity = 0; break; }
    maxEquity = Math.max(maxEquity, equity);
    const curDD = (maxEquity-equity)/maxEquity*100;
    if (curDD > maxDrawdown) { maxDrawdown = curDD; maxDDdate = s.date; maxDDpeak = maxEquity; maxDDtrough = equity; }
    equityCurve.push({ date: s.date, equity: +equity.toFixed(2), pnl: +pnl.toFixed(2) });
    if (pnl > 0) totalPnlWin += pnl; else totalPnlLoss += Math.abs(pnl);
    if (won) { winStreak++; lossStreak = 0; maxWinStreak = Math.max(maxWinStreak, winStreak); }
    else { lossStreak++; winStreak = 0; maxLossStreak = Math.max(maxLossStreak, lossStreak); }
    if (regimeResults[s.regime]) { regimeResults[s.regime].total++; if (won) regimeResults[s.regime].wins++; }
    if (!yearlyResults[s.year]) yearlyResults[s.year] = { wins:0, total:0, pnl:0, returns:[], startEq: equity - pnl + cost };
    yearlyResults[s.year].total++; if (won) yearlyResults[s.year].wins++;
    yearlyResults[s.year].pnl += pnl - cost; yearlyResults[s.year].returns.push(signDir * s.actualReturn * lev);
    const mk = s.date.slice(0,7);
    if (!monthlyResults[mk]) monthlyResults[mk] = { wins:0, total:0, pnl:0 };
    monthlyResults[mk].total++; if (won) monthlyResults[mk].wins++; monthlyResults[mk].pnl += pnl - cost;
    directionResults[direction].total++; if (won) directionResults[direction].wins++;
    directionResults[direction].returns.push(s.actualReturn);
    tradeHist.push(signDir * s.actualReturn * lev);
    prevDir = direction;
    results.push({ date: s.date, predicted: direction, actual: actualDir, score: s.score, actualReturn: s.actualReturn * 100, won, regime: s.regime });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERATE REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  const wins = results.filter(r => r.won).length;
  const total = results.length;
  const accuracy = ((wins / total) * 100).toFixed(2);
  const avgReturn = results.reduce((a, r) => a + r.actualReturn, 0) / total;

  // Sharpe ratio
  const stratReturns = results.map(r => {
    const dir = r.predicted === 'BULL' ? 1 : r.predicted === 'BEAR' ? -1 : 0;
    return dir * r.actualReturn / 100 * getLeverage(r.score);
  });
  const meanRet = stratReturns.reduce((a, b) => a + b, 0) / stratReturns.length;
  const stdRet = Math.sqrt(stratReturns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / stratReturns.length);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

  // Profit factor
  const profitFactor = totalPnlLoss > 0 ? (totalPnlWin / totalPnlLoss) : Infinity;

  // Kelly criterion
  const pWin = wins / total;
  const avgWinR = results.filter(r => r.won).reduce((a, r) => a + Math.abs(r.actualReturn), 0) / Math.max(1, wins);
  const avgLossR = results.filter(r => !r.won).reduce((a, r) => a + Math.abs(r.actualReturn), 0) / Math.max(1, total - wins);
  const kelly = avgLossR > 0 ? (pWin - (1 - pWin) / (avgWinR / avgLossR)) * 100 : 0;

  // CAGR
  const firstDate = new Date(results[0].date);
  const lastDate = new Date(results[results.length - 1].date);
  const years = (lastDate - firstDate) / (365.25 * 86400000);
  const cagr = ((equity / 10000) ** (1 / years) - 1) * 100;

  // Calmar ratio
  const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

  // Print report
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' WALK-FORWARD BACKTEST — FULLY REALISTIC OUT-OF-SAMPLE');
  console.log(' Walk-forwarded weights + thresholds · Brokerage + Slippage + Funding');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`📅 Period:           ${results[0].date} → ${results[results.length - 1].date} (${years.toFixed(1)} years)`);
  console.log(`📊 Total signals:    ${total}`);
  console.log(`✅ Wins:             ${wins}`);
  console.log(`❌ Losses:           ${total - wins}`);
  console.log(`🎯 Accuracy:         ${accuracy}%`);
  console.log('');
  console.log('── Performance Metrics ──────────────────────────────────────');
  console.log(`💰 Starting equity:  $10,000`);
  console.log(`💰 Final equity:     $${equity.toFixed(2)}`);
  console.log(`📈 Total return:     ${((equity / 10000 - 1) * 100).toFixed(2)}%`);
  console.log(`📈 CAGR:             ${cagr.toFixed(2)}%`);
  console.log(`📊 Sharpe ratio:     ${sharpe.toFixed(3)}`);
  console.log(`📊 Profit factor:    ${profitFactor.toFixed(3)}`);
  console.log(`📊 Calmar ratio:     ${calmar.toFixed(3)}`);
  console.log(`📊 Kelly criterion:  ${kelly.toFixed(2)}%`);
  console.log(`📉 Max drawdown:     ${maxDrawdown.toFixed(2)}% on ${maxDDdate} (peak $${maxDDpeak.toFixed(0)} → trough $${maxDDtrough.toFixed(0)})`);
  console.log(`📊 Avg win:          +${avgWinR.toFixed(3)}%`);
  console.log(`📊 Avg loss:         -${avgLossR.toFixed(3)}%`);
  console.log(`📊 Win/loss ratio:   ${(avgWinR / Math.max(0.001, avgLossR)).toFixed(3)}`);
  console.log(`🔥 Max win streak:   ${maxWinStreak}`);
  console.log(`❄️  Max loss streak:  ${maxLossStreak}`);
  console.log(`🚨 Crisis days:      ${crisisDays} (${crisisTotal > 0 ? ((crisisWins/crisisTotal)*100).toFixed(1) : 'N/A'}% accuracy)`);

  console.log('\n── Accuracy by Direction ────────────────────────────────────');
  for (const [dir, data] of Object.entries(directionResults)) {
    if (data.total > 0) {
      console.log(`  ${dir.padEnd(10)} ${((data.wins / data.total) * 100).toFixed(1)}% (${data.wins}/${data.total})`);
    }
  }

  console.log('\n── Accuracy by Market Regime ────────────────────────────────');
  for (const [regime, data] of Object.entries(regimeResults)) {
    if (data.total > 20) {
      console.log(`  ${regime.padEnd(16)} ${((data.wins / data.total) * 100).toFixed(1)}% (${data.wins}/${data.total})`);
    }
  }

  console.log('\n── Yearly Breakdown ────────────────────────────────────────');
  console.log('  Year    Accuracy    Signals    PnL($)       Sharpe');
  console.log('  ────    ────────    ───────    ──────       ──────');
  for (const [year, data] of Object.entries(yearlyResults).sort()) {
    const yAcc = ((data.wins / data.total) * 100).toFixed(1);
    const yMean = data.returns.reduce((a, b) => a + b, 0) / data.returns.length;
    const yStd = Math.sqrt(data.returns.reduce((a, b) => a + (b - yMean) ** 2, 0) / data.returns.length);
    const ySharpe = yStd > 0 ? (yMean / yStd) * Math.sqrt(252) : 0;
    console.log(`  ${year}    ${yAcc.padStart(6)}%    ${String(data.total).padStart(7)}    ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(0).padStart(8)}    ${ySharpe.toFixed(2).padStart(6)}`);
  }

  // Monthly heatmap (last 3 years)
  console.log('\n── Monthly PnL Heatmap (recent 3 years) ────────────────────');
  console.log('  Month      Jan    Feb    Mar    Apr    May    Jun    Jul    Aug    Sep    Oct    Nov    Dec');
  const recentYears = Object.keys(yearlyResults).sort().slice(-3);
  for (const year of recentYears) {
    let line = `  ${year}    `;
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      const md = monthlyResults[key];
      if (md) {
        const val = md.pnl >= 0 ? `+${(md.pnl).toFixed(0)}` : `${(md.pnl).toFixed(0)}`;
        line += val.padStart(6) + ' ';
      } else {
        line += '     — ';
      }
    }
    console.log(line);
  }

  // Score distribution
  console.log('\n── Score Distribution ───────────────────────────────────────');
  const scoreBuckets = {};
  for (const r of results) {
    const bucket = (Math.round(r.score * 10) / 10).toFixed(1);
    if (!scoreBuckets[bucket]) scoreBuckets[bucket] = { wins: 0, total: 0, avgReturn: 0 };
    scoreBuckets[bucket].total++;
    if (r.won) scoreBuckets[bucket].wins++;
    scoreBuckets[bucket].avgReturn += r.actualReturn;
  }
  console.log('  Score    Count   Accuracy   Avg Next-Day Return');
  console.log('  ─────    ─────   ────────   ───────────────────');
  for (const [bucket, data] of Object.entries(scoreBuckets).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    if (data.total >= 10) {
      const avgR = data.avgReturn / data.total;
      console.log(`  ${bucket.padStart(5)}    ${String(data.total).padStart(5)}   ${((data.wins / data.total) * 100).toFixed(1).padStart(6)}%   ${(avgR >= 0 ? '+' : '') + avgR.toFixed(3)}%`);
    }
  }

  // Strong signal performance
  console.log('\n── High-Conviction Signals (|score| > 0.3) ─────────────────');
  const strongBull = results.filter(r => r.score > 0.3);
  const strongBear = results.filter(r => r.score < -0.3);
  if (strongBull.length) {
    const sbWins = strongBull.filter(r => r.won).length;
    const sbAvgRet = strongBull.reduce((a, r) => a + r.actualReturn, 0) / strongBull.length;
    console.log(`  Strong BULL: ${((sbWins / strongBull.length) * 100).toFixed(1)}% accuracy (${sbWins}/${strongBull.length}), avg next-day: ${sbAvgRet >= 0 ? '+' : ''}${sbAvgRet.toFixed(3)}%`);
  }
  if (strongBear.length) {
    const sbWins = strongBear.filter(r => r.won).length;
    const sbAvgRet = strongBear.reduce((a, r) => a + r.actualReturn, 0) / strongBear.length;
    console.log(`  Strong BEAR: ${((sbWins / strongBear.length) * 100).toFixed(1)}% accuracy (${sbWins}/${strongBear.length}), avg next-day: ${sbAvgRet >= 0 ? '+' : ''}${sbAvgRet.toFixed(3)}%`);
  }

  // Leverage breakdown
  console.log('\n── Leverage Tier Breakdown ──────────────────────────────────');
  const levTiers = { '1.0x': {w:0,t:0}, '1.5x': {w:0,t:0}, '2.0x': {w:0,t:0}, '2.5x': {w:0,t:0} };
  for (const r of results) {
    const lev = getLeverage(r.score);
    const key = `${lev.toFixed(1)}x`;
    if (levTiers[key]) { levTiers[key].t++; if (r.won) levTiers[key].w++; }
  }
  for (const [tier, d] of Object.entries(levTiers)) {
    if (d.t > 0) console.log(`  ${tier.padEnd(6)} ${d.t} trades, ${((d.w/d.t)*100).toFixed(1)}% accuracy`);
  }

  // COVID crash analysis
  console.log('\n── Crisis Period Performance ────────────────────────────────');
  const crisisPeriods = [
    { name: 'COVID Crash (Feb-Mar 2020)', start: '2020-02-20', end: '2020-03-31' },
    { name: 'COVID Recovery (Apr-Jun 2020)', start: '2020-04-01', end: '2020-06-30' },
    { name: '2022 Rate Hike Selloff', start: '2022-01-01', end: '2022-06-30' },
    { name: '2023 Banking Crisis', start: '2023-03-01', end: '2023-03-31' },
    { name: '2024-25 Tariff Wars', start: '2024-11-01', end: '2025-04-30' },
  ];
  for (const cp of crisisPeriods) {
    const crisisResults = results.filter(r => r.date >= cp.start && r.date <= cp.end);
    if (crisisResults.length > 5) {
      const cWins = crisisResults.filter(r => r.won).length;
      console.log(`  ${cp.name}: ${((cWins / crisisResults.length) * 100).toFixed(1)}% (${cWins}/${crisisResults.length})`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\n  ${accuracy}% accuracy over ${years.toFixed(1)} years (${total} signals)`);
  console.log(`  $10,000 → $${equity.toFixed(2)} (${cagr.toFixed(2)}% CAGR)`);
  console.log(`  Sharpe ${sharpe.toFixed(2)} · Profit Factor ${profitFactor.toFixed(2)} · Max DD ${maxDrawdown.toFixed(1)}%`);
  console.log(`\n  ── Cost Breakdown ──`);
  console.log(`  Brokerage:        $${totalBrokerage.toFixed(2)}`);
  console.log(`  Slippage:         $${totalSlippage.toFixed(2)}`);
  console.log(`  Overnight funding: $${totalFunding.toFixed(2)}`);
  console.log(`  TOTAL COSTS:       $${totalCosts.toFixed(2)}`);
  console.log(`  Kelly suggests ${kelly.toFixed(1)}% position sizing`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT JSON DATA for backtest-charts.html
  // ═══════════════════════════════════════════════════════════════════════════
  const { writeFileSync } = require('fs');
  const { join } = require('path');

  // Build scoreBuckets array for charting
  const scoreBucketsArr = Object.entries(scoreBuckets)
    .map(([bucket, data]) => ({
      bucket: parseFloat(bucket),
      wins: data.wins,
      total: data.total,
      accuracy: data.total > 0 ? +((data.wins / data.total) * 100).toFixed(2) : 0,
      avgReturn: data.total > 0 ? +(data.avgReturn / data.total).toFixed(4) : 0,
    }))
    .filter(d => d.total >= 5)
    .sort((a, b) => a.bucket - b.bucket);

  // Build leverage tiers array
  const levTiersArr = Object.entries(levTiers)
    .filter(([, d]) => d.t > 0)
    .map(([tier, d]) => ({
      tier,
      wins: d.w,
      total: d.t,
      accuracy: +((d.w / d.t) * 100).toFixed(2),
    }));

  // Build yearly results array with sharpe
  const yearlyArr = Object.entries(yearlyResults).sort().map(([year, data]) => {
    const yMean = data.returns.reduce((a, b) => a + b, 0) / data.returns.length;
    const yStd = Math.sqrt(data.returns.reduce((a, b) => a + (b - yMean) ** 2, 0) / data.returns.length);
    const ySharpe = yStd > 0 ? (yMean / yStd) * Math.sqrt(252) : 0;
    return {
      year: parseInt(year),
      accuracy: +((data.wins / data.total) * 100).toFixed(2),
      wins: data.wins,
      total: data.total,
      pnl: +data.pnl.toFixed(2),
      sharpe: +ySharpe.toFixed(3),
    };
  });

  // Build monthly results array
  const monthlyArr = Object.entries(monthlyResults).sort().map(([month, data]) => ({
    month,
    wins: data.wins,
    total: data.total,
    pnl: +data.pnl.toFixed(2),
    accuracy: data.total > 0 ? +((data.wins / data.total) * 100).toFixed(2) : 0,
  }));

  // Build direction results array
  const directionArr = Object.entries(directionResults).map(([dir, data]) => ({
    direction: dir,
    wins: data.wins,
    total: data.total,
    accuracy: data.total > 0 ? +((data.wins / data.total) * 100).toFixed(2) : 0,
  }));

  // Build regime results array
  const regimeArr = Object.entries(regimeResults)
    .filter(([, d]) => d.total > 0)
    .map(([regime, data]) => ({
      regime,
      wins: data.wins,
      total: data.total,
      accuracy: data.total > 0 ? +((data.wins / data.total) * 100).toFixed(2) : 0,
    }));

  const jsonData = {
    summary: {
      accuracy: parseFloat(accuracy),
      finalEquity: +equity.toFixed(2),
      startEquity: 10000,
      cagr: +cagr.toFixed(4),
      sharpe: +sharpe.toFixed(4),
      maxDD: +maxDrawdown.toFixed(4),
      maxDDdate,
      maxDDpeak: +maxDDpeak.toFixed(2),
      maxDDtrough: +maxDDtrough.toFixed(2),
      profitFactor: +profitFactor.toFixed(4),
      totalCosts: +totalCosts.toFixed(2),
      totalBrokerage: +totalBrokerage.toFixed(2),
      totalSlippage: +totalSlippage.toFixed(2),
      totalFunding: +totalFunding.toFixed(2),
      totalReturn: +(((equity / 10000) - 1) * 100).toFixed(4),
      years: +years.toFixed(2),
      totalSignals: total,
      wins,
      losses: total - wins,
      kelly: +kelly.toFixed(2),
      calmar: +calmar.toFixed(4),
      maxWinStreak,
      maxLossStreak,
      periodStart: results[0].date,
      periodEnd: results[results.length - 1].date,
    },
    equityCurve,
    yearlyResults: yearlyArr,
    monthlyResults: monthlyArr,
    directionResults: directionArr,
    regimeResults: regimeArr,
    scoreBuckets: scoreBucketsArr,
    leverageTiers: levTiersArr,
  };

  // Determine output path relative to script location (__dirname is available in CJS)
  const outPath = join(__dirname, 'backtest-data.json');
  writeFileSync(outPath, JSON.stringify(jsonData, null, 2));
  console.log(`\n  JSON data written to: ${outPath}`);
  console.log('');
}

runBacktest().catch(e => { console.error('Fatal:', e); process.exit(1); });
