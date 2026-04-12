#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// ApexTrade Multi-Timeframe Backtest + Optimizer
// Tests WEEKLY (5-day) and MONTHLY (22-day) forward predictions
// Fetches max range data, pre-computes indicators, then optimizes weights
// Usage: node backtest-multi.js [weekly|monthly|both]
// ═══════════════════════════════════════════════════════════════════════════════

const TIMEFRAME = process.argv[2] || 'both';
const FWD_WEEKLY = 5;
const FWD_MONTHLY = 22;

// ── Yahoo Finance ─────────────────────────────────────────────────────────
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
  try { return await yahooChart(symbol, range); } catch (e) { console.warn(`  ⚠ ${symbol}: ${e.message}`); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════
function sma(arr, p) { if (arr.length < p) return null; return arr.slice(-p).reduce((a,b)=>a+b,0)/p; }
function ema(arr, p) { if (arr.length < p) return null; const k=2/(p+1); let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
function emaSeries(arr, p) { if(arr.length<p)return[]; const k=2/(p+1); let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p; const out=[e]; for(let i=p;i<arr.length;i++){e=arr[i]*k+e*(1-k);out.push(e);} return out; }

function rsi(closes, period=14) {
  if (closes.length < period+1) return null;
  let g=0,l=0; for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1]; if(d>0)g+=d; else l-=d;}
  if(l===0) return 100; return 100-100/(1+(g/period)/(l/period));
}
function macd(closes) {
  if(closes.length<35) return null;
  const e12=emaSeries(closes,12),e26=emaSeries(closes,26); if(e26.length<9) return null;
  const ml=[]; const off=26-12; for(let i=0;i<e26.length;i++) ml.push(e12[i+off]-e26[i]);
  const sig=emaSeries(ml,9); const hist=ml[ml.length-1]-sig[sig.length-1];
  const prev=ml.length>=2&&sig.length>=2?ml[ml.length-2]-sig[sig.length-2]:hist;
  return {line:ml[ml.length-1],signal:sig[sig.length-1],hist,prevHist:prev};
}
function bollingerBands(closes,period=20,mult=2) {
  if(closes.length<period) return null;
  const s=closes.slice(-period),mean=s.reduce((a,b)=>a+b,0)/period;
  const std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/period);
  return {upper:mean+mult*std,middle:mean,lower:mean-mult*std,std,width:(mult*2*std)/mean};
}
function stochastic(candles,kP=14,dP=3) {
  if(candles.length<kP+dP) return null;
  const kVals=[];
  for(let i=candles.length-kP-dP+1;i<candles.length;i++){
    const w=candles.slice(Math.max(0,i-kP+1),i+1);
    const hi=Math.max(...w.map(c=>c.h)),lo=Math.min(...w.map(c=>c.l));
    kVals.push(hi===lo?50:((candles[i].c-lo)/(hi-lo))*100);
  }
  return {k:kVals[kVals.length-1],d:kVals.slice(-dP).reduce((a,b)=>a+b,0)/dP};
}
function adx(candles,period=14) {
  if(candles.length<period*2+1) return null;
  let a14=0,pDM=0,nDM=0;
  for(let i=1;i<=period;i++){a14+=Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-candles[i-1].c),Math.abs(candles[i].l-candles[i-1].c));const u=candles[i].h-candles[i-1].h,d=candles[i-1].l-candles[i].l;pDM+=(u>d&&u>0)?u:0;nDM+=(d>u&&d>0)?d:0;}
  const dx=[];
  for(let i=period+1;i<candles.length;i++){const tr=Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-candles[i-1].c),Math.abs(candles[i].l-candles[i-1].c));a14=a14-a14/period+tr;const u=candles[i].h-candles[i-1].h,d=candles[i-1].l-candles[i].l;pDM=pDM-pDM/period+((u>d&&u>0)?u:0);nDM=nDM-nDM/period+((d>u&&d>0)?d:0);const pDI=(pDM/a14)*100,nDI=(nDM/a14)*100;dx.push({dx:(Math.abs(pDI-nDI)/(pDI+nDI))*100,pDI,nDI});}
  if(dx.length<period) return null;
  return {adx:dx.slice(-period).reduce((a,b)=>a+b.dx,0)/period,pDI:dx[dx.length-1].pDI,nDI:dx[dx.length-1].nDI};
}
function ichimoku(candles) {
  if(candles.length<52) return null;
  const midHL=a=>{const h=Math.max(...a.map(c=>c.h)),l=Math.min(...a.map(c=>c.l));return(h+l)/2;};
  const ten=midHL(candles.slice(-9)),kij=midHL(candles.slice(-26));
  const sA=(ten+kij)/2,sB=midHL(candles.slice(-52));
  const cT=Math.max(sA,sB),cB=Math.min(sA,sB),p=candles[candles.length-1].c;
  return {aboveCloud:p>cT,belowCloud:p<cB,tkCross:ten>kij?'bullish':'bearish'};
}
function williamsR(candles,period=14) {
  if(candles.length<period) return null;
  const w=candles.slice(-period),hi=Math.max(...w.map(c=>c.h)),lo=Math.min(...w.map(c=>c.l));
  return hi===lo?-50:((hi-candles[candles.length-1].c)/(hi-lo))*-100;
}
function zScore(closes,period=20) {
  if(closes.length<period+1) return null;
  const rets=[];for(let i=closes.length-period;i<closes.length;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const s=Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/rets.length);
  return s===0?0:(rets[rets.length-1]-m)/s;
}
function autocorrelation(closes,lag=1) {
  const rets=[];for(let i=1;i<closes.length;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
  if(rets.length<lag+10) return null;
  const n=rets.length,m=rets.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;for(let i=lag;i<n;i++) num+=(rets[i]-m)*(rets[i-lag]-m);for(let i=0;i<n;i++) den+=(rets[i]-m)**2;
  return den===0?0:num/den;
}
function hurstExponent(closes,maxLag=20) {
  if(closes.length<maxLag*4) return null;
  const rets=[];for(let i=1;i<closes.length;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
  const lags=[],rs=[];
  for(let lag=4;lag<=maxLag;lag++){const ch=Math.floor(rets.length/lag);if(ch<2)continue;let tRS=0;for(let c=0;c<ch;c++){const ck=rets.slice(c*lag,(c+1)*lag);const m=ck.reduce((a,b)=>a+b,0)/ck.length;let sum=0;const cd=[];for(const d of ck.map(r=>r-m)){sum+=d;cd.push(sum);}const R=Math.max(...cd)-Math.min(...cd);const S=Math.sqrt(ck.reduce((a,b)=>a+(b-m)**2,0)/ck.length);if(S>0)tRS+=R/S;}lags.push(Math.log(lag));rs.push(Math.log(tRS/ch));}
  if(lags.length<3) return 0.5;
  const n=lags.length,sX=lags.reduce((a,b)=>a+b,0),sY=rs.reduce((a,b)=>a+b,0);
  const sXY=lags.reduce((a,b,i)=>a+b*rs[i],0),sX2=lags.reduce((a,b)=>a+b*b,0);
  return Math.max(0,Math.min(1,(n*sXY-sX*sY)/(n*sX2-sX*sX)));
}
function atrSeries(candles,period=14) {
  const out=[];for(let i=period;i<candles.length;i++){let s=0;for(let j=i-period+1;j<=i;j++) s+=Math.max(candles[j].h-candles[j].l,Math.abs(candles[j].h-candles[j-1].c),Math.abs(candles[j].l-candles[j-1].c));out.push(s/period);}return out;
}
function atrPercentileRank(candles,lookback=252) {
  const atrs=atrSeries(candles,14);if(atrs.length<20) return 50;
  const w=atrs.slice(-Math.min(lookback,atrs.length)),cur=w[w.length-1];
  return(w.filter(a=>a<=cur).length/w.length)*100;
}
function superTrend(candles,period=10,multiplier=3) {
  if(candles.length<period+1) return null;
  const tr=[];for(let i=1;i<candles.length;i++) tr.push(Math.max(candles[i].h-candles[i].l,Math.abs(candles[i].h-candles[i-1].c),Math.abs(candles[i].l-candles[i-1].c)));
  const atrA=[];let aS=0;for(let i=0;i<period&&i<tr.length;i++) aS+=tr[i];atrA.push(aS/period);for(let i=period;i<tr.length;i++) atrA.push((atrA[atrA.length-1]*(period-1)+tr[i])/period);
  const st=[];
  for(let i=0;i<atrA.length;i++){const ci=i+1;const hl2=(candles[ci].h+candles[ci].l)/2;let ub=hl2+multiplier*atrA[i],lb=hl2-multiplier*atrA[i];
    if(st.length>0){const p=st[st.length-1];if(lb>p.lower&&candles[ci-1].c>p.lower)lb=Math.max(lb,p.lower);if(ub<p.upper&&candles[ci-1].c<p.upper)ub=Math.min(ub,p.upper);}
    let trend;if(st.length===0)trend=candles[ci].c>ub?1:-1;else{const p=st[st.length-1];if(p.trend===1&&candles[ci].c<p.lower)trend=-1;else if(p.trend===-1&&candles[ci].c>p.upper)trend=1;else trend=p.trend;}
    st.push({upper:ub,lower:lb,trend});}
  if(st.length<2) return null;
  const last=st[st.length-1],prev=st[st.length-2];
  return {direction:last.trend===1?'BULL':'BEAR',flipped:last.trend!==prev.trend,trend:last.trend};
}
function obvSlope(candles,lookback=10) {
  if(candles.length<lookback+1) return null;
  let obv=0;const arr=[];for(let i=1;i<candles.length;i++){if(candles[i].c>candles[i-1].c)obv+=candles[i].v;else if(candles[i].c<candles[i-1].c)obv-=candles[i].v;arr.push(obv);}
  const r=arr.slice(-lookback),avg=candles.slice(-20).reduce((a,c)=>a+c.v,0)/20;
  return avg>0?(r[r.length-1]-r[0])/(avg*lookback):0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
function scoreRSI(val) { if(val==null) return 0; if(val>80)return -2;if(val>70)return -1;if(val>65)return -0.3;if(val>55)return 0.2;if(val>45)return 0;if(val>35)return 0.3;if(val>30)return 1;if(val>20)return 2;return 2.5; }
function scoreMACD(m) { if(!m) return 0; let s=0;s+=m.hist>0?0.5:-0.5;s+=m.line>m.signal?0.3:-0.3;s+=m.hist>m.prevHist?0.3:-0.3;s+=m.line>0&&m.signal>0?0.2:m.line<0&&m.signal<0?-0.2:0;return Math.max(-1.5,Math.min(1.5,s)); }
function scoreEMA(closes) {
  if(closes.length<200) return 0;
  const e8=ema(closes,8),e21=ema(closes,21),e50=ema(closes,50),e200=ema(closes,200);
  if(!e8||!e21||!e50||!e200) return 0;
  if(e8>e21&&e21>e50&&e50>e200) return 1.5;
  if(e8<e21&&e21<e50&&e50<e200) return -1.5;
  return closes[closes.length-1]>e200?0.3:-0.3;
}
function scoreBollinger(closes) { const bb=bollingerBands(closes);if(!bb) return 0;const p=(closes[closes.length-1]-bb.lower)/(bb.upper-bb.lower);if(p>0.95)return -1.2;if(p>0.85)return -0.6;if(p<0.05)return 1.2;if(p<0.15)return 0.6;return 0; }
function scoreStoch(candles) { const s=stochastic(candles);if(!s) return 0;if(s.k>80&&s.d>80) return -0.8;if(s.k<20&&s.d<20) return 0.8;if(s.k>s.d&&s.k<80) return 0.3;if(s.k<s.d&&s.k>20) return -0.3;return 0; }
function scoreADX(candles) { const a=adx(candles);if(!a) return 0;if(a.adx>25&&a.pDI>a.nDI) return 0.6;if(a.adx>25&&a.nDI>a.pDI) return -0.6;return 0; }
function scoreIchimoku(candles) { const i=ichimoku(candles);if(!i) return 0;let s=0;s+=i.aboveCloud?0.5:i.belowCloud?-0.5:0;s+=i.tkCross==='bullish'?0.3:-0.3;return s; }
function scoreSAR(candles) { const st=superTrend(candles);return st?(st.direction==='BULL'?0.4:-0.4):0; }
function scoreSuperTrend(candles) { const st=superTrend(candles);if(!st) return 0;let s=st.direction==='BULL'?0.5:-0.5;if(st.flipped) s+=st.direction==='BULL'?0.5:-0.5;return s; }
function scoreZScore(closes) { const z=zScore(closes);if(z==null) return 0;if(z>2)return -0.8;if(z>1.5)return -0.4;if(z<-2)return 0.8;if(z<-1.5)return 0.4;return 0; }
function scoreMeanReversion(closes) { if(closes.length<50) return 0;const m20=sma(closes,20);const p=closes[closes.length-1];if(!m20) return 0;const d=(p-m20)/m20;if(d>0.04)return -0.8;if(d<-0.04)return 0.8;return 0; }
function scoreConsecutive(candles) { let s=0;for(let i=candles.length-1;i>=1;i--){const c=candles[i].c-candles[i-1].c;if(s===0)s=c>0?1:c<0?-1:0;else if(s>0&&c>0)s++;else if(s<0&&c<0)s--;else break;}if(Math.abs(s)>=5)return s>0?-1.0:1.0;if(Math.abs(s)>=3)return s>0?-0.4:0.4;return 0; }
function scoreVolume(candles) { if(candles.length<21)return 0;const avg=candles.slice(-21,-1).reduce((a,c)=>a+c.v,0)/20;const last=candles[candles.length-1].v;const r=avg>0?last/avg:1;const chg=candles[candles.length-1].c-candles[candles.length-2].c;if(r>1.5&&chg>0)return 0.5;if(r>1.5&&chg<0)return -0.5;return 0; }
function scoreVIX(vixVal) { if(vixVal==null) return 0;if(vixVal>35)return -1.0;if(vixVal>25)return -0.5;if(vixVal<14)return 0.3;return 0; }
function scoreCalendar(date) { const dow=date.getUTCDay();let s=0;if(dow===1)s=-0.15;if(dow===5)s=0.15;const m=date.getUTCMonth();if(m===0||m===10)s+=0.1;if(m===8)s-=0.1;return s; }
function scoreHurst(closes) { const h=hurstExponent(closes);if(h==null)return 0;if(h>0.6)return 0.3;if(h<0.4)return -0.2;return 0; }

function detectRegime(candles,closes) {
  const a=adx(candles),h=hurstExponent(closes),aP=atrPercentileRank(candles),bb=bollingerBands(closes),bw=bb?bb.width:0;
  if(a&&a.adx>30&&h>0.55) return 'TRENDING';
  if(a&&a.adx<20&&h<0.45) return 'MEAN_REVERTING';
  if(aP>80||bw>0.06) return 'VOLATILE';
  if(aP<20&&bw<0.02) return 'QUIET';
  return 'NORMAL';
}

// Crisis detection (v3.0)
function detectCrisis(vixSlice, spxSlice, asxSlice) {
  let severity = 0;
  if (vixSlice && vixSlice.length >= 4) {
    const vixNow = vixSlice[vixSlice.length - 1].c;
    const vix3dAgo = vixSlice[vixSlice.length - 4].c;
    const vel = ((vixNow - vix3dAgo) / vix3dAgo) * 100;
    if (vel > 40) severity += 3; else if (vel > 25) severity += 2;
    if (vixNow > 35) severity += 2; else if (vixNow > 28) severity += 1;
  }
  if (spxSlice && spxSlice.length >= 2) {
    const chg = Math.abs((spxSlice[spxSlice.length-1].c - spxSlice[spxSlice.length-2].c) / spxSlice[spxSlice.length-2].c) * 100;
    if (chg > 4.0) severity += 2;
    if (spxSlice.length >= 4) {
      const d3 = ((spxSlice[spxSlice.length-1].c - spxSlice[spxSlice.length-4].c) / spxSlice[spxSlice.length-4].c) * 100;
      if (d3 < -6) severity += 2;
    }
  }
  return severity >= 3;
}

function findSliceUpTo(candles,date,maxBars=500) {
  if(!candles) return null;
  const ds=new Date(date).toISOString().slice(0,10);
  let ei=-1;for(let i=candles.length-1;i>=0;i--){if(new Date(candles[i].t).toISOString().slice(0,10)<=ds){ei=i;break;}}
  if(ei<0) return null;
  return candles.slice(Math.max(0,ei-maxBars),ei+1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-COMPUTE all indicator values for each day
// ═══════════════════════════════════════════════════════════════════════════════
function precompute(asxData, vixData, goldData, oilData, audData, bondData, spxData) {
  const startIdx = Math.max(260, 252);
  const days = [];

  for (let i = startIdx; i < asxData.length; i++) {
    const dayDate = asxData[i].t;
    const asxSlice = asxData.slice(Math.max(0, i - 500), i + 1);
    const closes = asxSlice.map(c => c.c);
    const vixSlice = findSliceUpTo(vixData, dayDate, 200);
    const goldSlice = findSliceUpTo(goldData, dayDate, 50);
    const oilSlice = findSliceUpTo(oilData, dayDate, 50);
    const audSlice = findSliceUpTo(audData, dayDate, 50);
    const bondSlice = findSliceUpTo(bondData, dayDate, 50);
    const spxSlice = findSliceUpTo(spxData, dayDate, 50);

    try {
      // Forward returns
      const fwd1 = i+1 < asxData.length ? (asxData[i+1].c - asxData[i].c) / asxData[i].c : null;
      const fwd5 = i+5 < asxData.length ? (asxData[i+5].c - asxData[i].c) / asxData[i].c : null;
      const fwd22 = i+22 < asxData.length ? (asxData[i+22].c - asxData[i].c) / asxData[i].c : null;

      // Intermarket changes
      let spxChg=null; if(spxSlice&&spxSlice.length>=2) spxChg=((spxSlice[spxSlice.length-1].c-spxSlice[spxSlice.length-2].c)/spxSlice[spxSlice.length-2].c)*100;
      let vixChg=null,vixLevel=null; if(vixSlice&&vixSlice.length>=2){vixChg=((vixSlice[vixSlice.length-1].c-vixSlice[vixSlice.length-2].c)/vixSlice[vixSlice.length-2].c)*100;vixLevel=vixSlice[vixSlice.length-1].c;}
      let oilChg=null; if(oilSlice&&oilSlice.length>=2) oilChg=((oilSlice[oilSlice.length-1].c-oilSlice[oilSlice.length-2].c)/oilSlice[oilSlice.length-2].c)*100;
      let audChg=null; if(audSlice&&audSlice.length>=2) audChg=((audSlice[audSlice.length-1].c-audSlice[audSlice.length-2].c)/audSlice[audSlice.length-2].c)*100;
      let bondChg=null; if(bondSlice&&bondSlice.length>=2) bondChg=((bondSlice[bondSlice.length-1].c-bondSlice[bondSlice.length-2].c)/bondSlice[bondSlice.length-2].c)*100;
      let goldChg=null; if(goldSlice&&goldSlice.length>=2) goldChg=((goldSlice[goldSlice.length-1].c-goldSlice[goldSlice.length-2].c)/goldSlice[goldSlice.length-2].c)*100;

      // SPX 5-day and 20-day trends
      let spx5dChg=null,spx20dChg=null;
      if(spxSlice&&spxSlice.length>=6) spx5dChg=((spxSlice[spxSlice.length-1].c-spxSlice[spxSlice.length-6].c)/spxSlice[spxSlice.length-6].c)*100;
      if(spxSlice&&spxSlice.length>=21) spx20dChg=((spxSlice[spxSlice.length-1].c-spxSlice[spxSlice.length-21].c)/spxSlice[spxSlice.length-21].c)*100;

      // VIX 5-day trend
      let vix5dChg=null;
      if(vixSlice&&vixSlice.length>=6) vix5dChg=((vixSlice[vixSlice.length-1].c-vixSlice[vixSlice.length-6].c)/vixSlice[vixSlice.length-6].c)*100;

      // ASX returns
      const ret1d = closes.length>=2?(closes[closes.length-1]-closes[closes.length-2])/closes[closes.length-2]*100:0;
      const ret3d = closes.length>=4?(closes[closes.length-1]-closes[closes.length-4])/closes[closes.length-4]*100:0;
      const ret5d = closes.length>=6?(closes[closes.length-1]-closes[closes.length-6])/closes[closes.length-6]*100:0;
      const ret10d = closes.length>=11?(closes[closes.length-1]-closes[closes.length-11])/closes[closes.length-11]*100:0;
      const ret20d = closes.length>=21?(closes[closes.length-1]-closes[closes.length-21])/closes[closes.length-21]*100:0;

      // Pre-computed scores
      const rsiVal = rsi(closes);
      const macdVal = macd(closes);
      const bbData = bollingerBands(closes);

      days.push({
        date: new Date(dayDate).toISOString().slice(0, 10),
        close: asxData[i].c,
        fwd1, fwd5, fwd22,
        // Intermarket
        spxChg, vixChg, vixLevel, oilChg, audChg, bondChg, goldChg,
        spx5dChg, spx20dChg, vix5dChg,
        // ASX returns
        ret1d, ret3d, ret5d, ret10d, ret20d,
        // Indicator scores
        rsiScore: scoreRSI(rsiVal),
        macdScore: scoreMACD(macdVal),
        emaScore: scoreEMA(closes),
        bollScore: scoreBollinger(closes),
        stochScore: scoreStoch(asxSlice),
        adxScore: scoreADX(asxSlice),
        ichimokuScore: scoreIchimoku(asxSlice),
        superTrendScore: scoreSuperTrend(asxSlice),
        zScoreVal: scoreZScore(closes),
        meanRevVal: scoreMeanReversion(closes),
        consecVal: scoreConsecutive(asxSlice),
        wrScore: (()=>{const w=williamsR(asxSlice);return w!=null?(w>-20?-0.5:w<-80?0.5:0):0;})(),
        volScore: scoreVolume(asxSlice),
        calScore: scoreCalendar(new Date(dayDate)),
        vixLevelScore: vixLevel!=null?scoreVIX(vixLevel):0,
        hurstScore: scoreHurst(closes),
        acScore: (()=>{const a=autocorrelation(closes);return a!=null?(a>0.15?0.3:a<-0.15?-0.3:0):0;})(),
        // BB width for squeeze detection
        bbWidth: bbData ? bbData.width * 100 : 0,
        // RSI raw
        rsiRaw: rsiVal,
        // Regime & Crisis
        regime: detectRegime(asxSlice, closes),
        crisis: detectCrisis(vixSlice, spxSlice, asxSlice),
      });
    } catch(e) { /* skip */ }
  }
  return days;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURABLE SCORING
// ═══════════════════════════════════════════════════════════════════════════════
function scoreDay(day, cfg, timeframe) {
  const factors = [];
  const fwd = timeframe === 'weekly' ? 5 : 22;

  // ── SPX overnight — VIX-conditional weight (v3.0) ──
  if (day.spxChg != null) {
    let s = 0;
    const extremeThresh = day.crisis ? 4.5 : (day.vixLevel && day.vixLevel > 25) ? 3.5 : 2.9;
    if (day.spxChg > extremeThresh) s = 0.2;
    else if (day.spxChg > 0.55) s = 0.8;
    else if (day.spxChg > 0.1) s = 0.3;
    else if (day.spxChg < -extremeThresh) s = -0.2;
    else if (day.spxChg < -0.55) s = -0.8;
    else if (day.spxChg < -0.1) s = -0.3;
    // VIX-conditional weight adjustment
    let spxW = cfg.wSPX1d;
    if (day.crisis) spxW *= 0.2;
    else if (day.vixLevel && day.vixLevel > 35) spxW *= 0.3;
    else if (day.vixLevel && day.vixLevel > 25) spxW *= 0.6;
    else if (day.vixLevel && day.vixLevel < 14) spxW *= 1.2;
    factors.push({ w: spxW, s });
  }

  // ── SPX 5-day trend (meaningful for weekly/monthly) ──
  if (day.spx5dChg != null && cfg.wSPX5d > 0) {
    let s = 0;
    if (day.spx5dChg > 3) s = 0.8;
    else if (day.spx5dChg > 1) s = 0.4;
    else if (day.spx5dChg < -3) s = -0.8;
    else if (day.spx5dChg < -1) s = -0.4;
    factors.push({ w: cfg.wSPX5d, s });
  }

  // ── SPX 20-day trend (for monthly) ──
  if (day.spx20dChg != null && cfg.wSPX20d > 0) {
    let s = 0;
    if (day.spx20dChg > 5) s = 0.8;
    else if (day.spx20dChg > 2) s = 0.4;
    else if (day.spx20dChg < -5) s = -0.8;
    else if (day.spx20dChg < -2) s = -0.4;
    factors.push({ w: cfg.wSPX20d, s });
  }

  // ── VIX change ──
  if (day.vixChg != null && cfg.wVIXChg > 0) {
    let s = 0;
    if (day.vixChg > 14) s = 0;
    else if (day.vixChg > 3) s = 0.3;
    else if (day.vixChg < -8) s = -0.3;
    else if (day.vixChg < -3) s = -0.15;
    factors.push({ w: cfg.wVIXChg, s });
  }

  // ── VIX 5-day change ──
  if (day.vix5dChg != null && cfg.wVIX5d > 0) {
    let s = 0;
    if (day.vix5dChg > 30) s = 0.8;
    else if (day.vix5dChg > 15) s = 0.5;
    else if (day.vix5dChg > 5) s = 0.2;
    else if (day.vix5dChg < -20) s = -0.5;
    else if (day.vix5dChg < -10) s = -0.3;
    factors.push({ w: cfg.wVIX5d, s });
  }

  // ── VIX Level ──
  if (cfg.wVIXLevel > 0) factors.push({ w: cfg.wVIXLevel, s: day.vixLevelScore });

  // ── Oil ──
  if (day.oilChg != null && cfg.wOil > 0) {
    let s=0;if(day.oilChg>3)s=0.8;else if(day.oilChg>1)s=0.3;else if(day.oilChg<-3)s=-0.8;else if(day.oilChg<-1)s=-0.3;
    factors.push({ w: cfg.wOil, s });
  }

  // ── AUD ──
  if (day.audChg != null && cfg.wAUD > 0) {
    let s=0;if(day.audChg>1)s=0.8;else if(day.audChg>0.3)s=0.3;else if(day.audChg<-1)s=-0.8;else if(day.audChg<-0.3)s=-0.3;
    factors.push({ w: cfg.wAUD, s });
  }

  // ── 1d Contrarian ──
  if (cfg.wCont1d > 0) {
    let s=0;
    if(day.ret1d>1.6)s=-0.8;else if(day.ret1d>0.02)s=-0.3;else if(day.ret1d<-1.6)s=0.8;else if(day.ret1d<-0.02)s=0.3;
    factors.push({ w: cfg.wCont1d, s });
  }

  // ── 5d Contrarian ──
  if (cfg.wCont5d > 0) {
    let s=0;if(day.ret5d>3)s=-0.5;else if(day.ret5d>1.5)s=-0.3;else if(day.ret5d<-3)s=0.5;else if(day.ret5d<-1.5)s=0.3;
    factors.push({ w: cfg.wCont5d, s });
  }

  // ── 10d Contrarian ──
  if (cfg.wCont10d > 0) {
    let s=0;if(day.ret10d>5)s=-0.5;else if(day.ret10d>2)s=-0.3;else if(day.ret10d<-5)s=0.5;else if(day.ret10d<-2)s=0.3;
    factors.push({ w: cfg.wCont10d, s });
  }

  // ── 20d Contrarian ──
  if (cfg.wCont20d > 0) {
    let s=0;if(day.ret20d>8)s=-0.5;else if(day.ret20d>3)s=-0.3;else if(day.ret20d<-8)s=0.5;else if(day.ret20d<-3)s=0.3;
    factors.push({ w: cfg.wCont20d, s });
  }

  // ── Trend indicators (promoted for longer timeframes) ──
  if (cfg.wEMA > 0) factors.push({ w: cfg.wEMA, s: day.emaScore });
  if (cfg.wADX > 0) factors.push({ w: cfg.wADX, s: day.adxScore });
  if (cfg.wMACD > 0) factors.push({ w: cfg.wMACD, s: day.macdScore });
  if (cfg.wIchimoku > 0) factors.push({ w: cfg.wIchimoku, s: day.ichimokuScore });
  if (cfg.wSuperTrend > 0) factors.push({ w: cfg.wSuperTrend, s: day.superTrendScore });
  if (cfg.wHurst > 0) factors.push({ w: cfg.wHurst, s: day.hurstScore });
  if (cfg.wRSI > 0) factors.push({ w: cfg.wRSI, s: day.rsiScore });

  // ── Mean reversion / stat ──
  if (cfg.wZScore > 0) factors.push({ w: cfg.wZScore, s: day.zScoreVal });
  if (cfg.wConsec > 0) factors.push({ w: cfg.wConsec, s: day.consecVal });
  if (cfg.wMeanRev > 0) factors.push({ w: cfg.wMeanRev, s: day.meanRevVal });
  if (cfg.wWR > 0) factors.push({ w: cfg.wWR, s: day.wrScore });
  if (cfg.wBoll > 0) factors.push({ w: cfg.wBoll, s: day.bollScore });
  if (cfg.wStoch > 0) factors.push({ w: cfg.wStoch, s: day.stochScore });

  // ── Other ──
  if (cfg.wCal > 0) factors.push({ w: cfg.wCal, s: day.calScore });
  if (cfg.wVol > 0) factors.push({ w: cfg.wVol, s: day.volScore });
  if (day.bondChg != null && cfg.wBond > 0) factors.push({ w: cfg.wBond, s: day.bondChg>3?-0.3:day.bondChg<-3?0.3:0 });
  if (day.goldChg != null && cfg.wGold > 0) factors.push({ w: cfg.wGold, s: day.goldChg>1.5?-0.3:day.goldChg<-1.5?0.3:0 });

  // Crisis dampener (v3.0)
  if (day.crisis) {
    factors.push({ w: 2.5, s: -0.4 });
  }

  // VIX level boost during crisis
  if (day.crisis && cfg.wVIXLevel > 0) {
    factors.push({ w: 3.0, s: day.vixLevelScore });
  }

  let totalWS=0,totalW=0;
  for(const f of factors){totalWS+=f.s*f.w;totalW+=f.w;}
  const score = totalW>0?totalWS/totalW:0;
  // Always directional — no neutral zone. Weekly/monthly = bias calls every period.
  const direction = score >= 0 ? 'BULL' : 'BEAR';
  return {score,direction};
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════
function evaluate(days, cfg, timeframe) {
  const fwdKey = timeframe === 'weekly' ? 'fwd5' : 'fwd22';
  const fwdBars = timeframe === 'weekly' ? 5 : 22;
  const step = fwdBars; // non-overlapping periods

  let equity=10000,maxEquity=10000,maxDD=0;
  let dirWins=0,dirTotal=0,allTotal=0;
  let totalPnlWin=0,totalPnlLoss=0;
  const stratReturns=[];

  for (let i = 0; i < days.length; i += step) {
    const day = days[i];
    if (day[fwdKey] == null) continue;

    const signal = scoreDay(day, cfg, timeframe);
    const dir = signal.direction==='BULL'?1:-1; // Always directional
    let posSize = Math.min(1, 0.5 + Math.abs(signal.score)*1.5); // Always at least 50% invested
    // High-conviction leverage: 2x on strong signals
    if (Math.abs(signal.score) >= 0.25) posSize = Math.min(2.5, posSize * 2.0);
    const pnl = dir * day[fwdKey] * posSize * equity;
    equity += pnl;
    maxEquity = Math.max(maxEquity, equity);
    maxDD = Math.max(maxDD, (maxEquity-equity)/maxEquity*100);

    if(pnl>0) totalPnlWin+=pnl; else totalPnlLoss+=Math.abs(pnl);
    allTotal++;
    dirTotal++;
    const won=(signal.direction==='BULL'&&day[fwdKey]>0)||(signal.direction==='BEAR'&&day[fwdKey]<0);
    if(won) dirWins++;
    stratReturns.push(dir*day[fwdKey]);
  }

  const dirAccuracy=dirTotal>0?dirWins/dirTotal:0;
  const dirRate=allTotal>0?dirTotal/allTotal:0;
  const meanRet=stratReturns.reduce((a,b)=>a+b,0)/stratReturns.length;
  const stdRet=Math.sqrt(stratReturns.reduce((a,b)=>a+(b-meanRet)**2,0)/stratReturns.length);
  const sharpe=stdRet>0?(meanRet/stdRet)*Math.sqrt(252/fwdBars):0;
  const pf=totalPnlLoss>0?totalPnlWin/totalPnlLoss:Infinity;
  const years=(new Date(days[days.length-1].date)-new Date(days[0].date))/(365.25*86400000);
  const cagr=equity>0?((equity/10000)**(1/years)-1)*100:0;
  // Always fully invested — no participation penalty needed
  const cappedPF = pf===Infinity ? 1.0 : Math.min(pf,5);
  const composite = (dirAccuracy*100)*0.3 + sharpe*5 + cappedPF*3 + Math.max(0,20-maxDD)*0.5;

  return {accuracy:dirAccuracy,equity,sharpe,profitFactor:pf,maxDD,cagr,composite,wins:dirWins,total:dirTotal,allTotal};
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY BASELINE (trend-following heavy)
// ═══════════════════════════════════════════════════════════════════════════════
const WEEKLY_BASE = {
  wSPX1d: 3.0, wSPX5d: 5.0, wSPX20d: 0,
  wVIXChg: 2.0, wVIX5d: 3.0, wVIXLevel: 2.5,
  wOil: 4.0, wAUD: 4.5,
  wCont1d: 0.5, wCont5d: 2.0, wCont10d: 1.0, wCont20d: 0,
  wEMA: 4.0, wADX: 3.0, wMACD: 2.5, wIchimoku: 2.0, wSuperTrend: 3.0, wHurst: 2.5, wRSI: 1.5,
  wZScore: 1.0, wConsec: 1.5, wMeanRev: 2.5, wWR: 0.5, wBoll: 1.0, wStoch: 0.5,
  wCal: 0.3, wVol: 0.5, wBond: 0.5, wGold: 0.3,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MONTHLY BASELINE (strong trend-following)
// ═══════════════════════════════════════════════════════════════════════════════
const MONTHLY_BASE = {
  wSPX1d: 0, wSPX5d: 3.0, wSPX20d: 5.0,
  wVIXChg: 0, wVIX5d: 2.0, wVIXLevel: 3.0,
  wOil: 3.0, wAUD: 3.5,
  wCont1d: 0, wCont5d: 1.0, wCont10d: 2.0, wCont20d: 3.0,
  wEMA: 6.0, wADX: 4.0, wMACD: 3.0, wIchimoku: 2.5, wSuperTrend: 4.0, wHurst: 3.5, wRSI: 2.0,
  wZScore: 0.5, wConsec: 0.5, wMeanRev: 3.5, wWR: 0.5, wBoll: 2.0, wStoch: 0.5,
  wCal: 0, wVol: 0.5, wBond: 1.0, wGold: 0.5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// OPTIMIZER
// ═══════════════════════════════════════════════════════════════════════════════
const PERTURB_KEYS = [
  'wSPX1d','wSPX5d','wSPX20d','wVIXChg','wVIX5d','wVIXLevel',
  'wOil','wAUD','wCont1d','wCont5d','wCont10d','wCont20d',
  'wEMA','wADX','wMACD','wIchimoku','wSuperTrend','wHurst','wRSI',
  'wZScore','wConsec','wMeanRev','wWR','wBoll','wStoch',
  'wCal','wVol','wBond','wGold'
];

function optimize(days, baseline, timeframe) {
  console.log(`\n🔍 Grid Search for ${timeframe}...`);
  let best = { cfg: baseline, result: evaluate(days, baseline, timeframe) };
  console.log(`   Baseline: Acc ${(best.result.accuracy*100).toFixed(1)}% | Equity $${best.result.equity.toFixed(0)} | Sharpe ${best.result.sharpe.toFixed(3)} | Composite ${best.result.composite.toFixed(2)}`);

  // Grid search: vary each weight independently
  const configs = [];
  for (const key of PERTURB_KEYS) {
    const base = baseline[key];
    const vals = [0, base*0.3, base*0.5, base*0.7, base, base*1.3, base*1.5, base*2.0, base*2.5, base*3.0].filter(v => v >= 0);
    for (const v of vals) {
      configs.push({ ...baseline, [key]: v, label: `${key}=${v.toFixed(2)}` });
    }
  }

  console.log(`   Testing ${configs.length} grid configs...`);
  for (const cfg of configs) {
    const result = evaluate(days, cfg, timeframe);
    if (result.composite > best.result.composite) best = { cfg, result };
  }
  console.log(`   Grid best: Composite ${best.result.composite.toFixed(2)} | Acc ${(best.result.accuracy*100).toFixed(1)}%`);

  // Hill climbing
  console.log('   Hill climbing...');
  let improved = true, iters = 0;
  while (improved && iters < 15) {
    improved = false; iters++;
    for (const key of PERTURB_KEYS) {
      const cur = best.cfg[key] || 0;
      for (const delta of [-1, -0.5, -0.2, -0.1, -0.05, 0.05, 0.1, 0.2, 0.5, 1.0]) {
        let nv = Math.max(0, cur + delta);

        if (nv === cur) continue;
        const cfg = { ...best.cfg, [key]: nv };
        const result = evaluate(days, cfg, timeframe);
        if (result.composite > best.result.composite) { best = { cfg, result }; improved = true; }
      }
    }
    process.stdout.write(`\r   Iter ${iters}: Composite ${best.result.composite.toFixed(2)} | Acc ${(best.result.accuracy*100).toFixed(1)}% | Sharpe ${best.result.sharpe.toFixed(3)} | Equity $${best.result.equity.toFixed(0)}`);
  }
  console.log(`\n   Converged after ${iters} iterations`);

  // Random exploration
  console.log('   Random exploration (500 perturbations)...');
  for (let i = 0; i < 500; i++) {
    const cfg = { ...best.cfg };
    const np = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < np; j++) {
      const key = PERTURB_KEYS[Math.floor(Math.random() * PERTURB_KEYS.length)];
      const cur = cfg[key] || 0;
      const scale = cur > 0 ? cur : 1;
      let nv = Math.max(0, cur + (Math.random() - 0.5) * scale * 0.8);

      cfg[key] = nv;
    }
    const result = evaluate(days, cfg, timeframe);
    if (result.composite > best.result.composite) best = { cfg, result };
  }

  // Final hill climb
  improved = true; iters = 0;
  while (improved && iters < 10) {
    improved = false; iters++;
    for (const key of PERTURB_KEYS) {
      const cur = best.cfg[key] || 0;
      for (const delta of [-0.3, -0.15, -0.08, -0.03, 0.03, 0.08, 0.15, 0.3]) {
        let nv = Math.max(0, cur + delta);

        if (nv === cur) continue;
        const cfg = { ...best.cfg, [key]: nv };
        const result = evaluate(days, cfg, timeframe);
        if (result.composite > best.result.composite) { best = { cfg, result }; improved = true; }
      }
    }
  }
  console.log(`   Final: Composite ${best.result.composite.toFixed(2)}`);

  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL BACKTEST REPORT (with yearly breakdown)
// ═══════════════════════════════════════════════════════════════════════════════
function runFullBacktest(days, cfg, timeframe) {
  const fwdKey = timeframe === 'weekly' ? 'fwd5' : 'fwd22';
  const fwdBars = timeframe === 'weekly' ? 5 : 22;
  const step = fwdBars;
  const label = timeframe === 'weekly' ? 'WEEKLY (5-day)' : 'MONTHLY (22-day)';

  let equity=10000,maxEquity=10000,maxDD=0;
  let wins=0,total=0,totalPnlWin=0,totalPnlLoss=0;
  const yearlyResults={};
  const stratReturns=[];
  const dirResults={BULL:{wins:0,total:0},BEAR:{wins:0,total:0}};
  let maxWS=0,maxLS=0,ws=0,ls=0;
  const scoreBuckets={};

  for (let i = 0; i < days.length; i += step) {
    const day = days[i];
    if (day[fwdKey] == null) continue;

    const signal = scoreDay(day, cfg, timeframe);
    const dir = signal.direction==='BULL'?1:-1; // Always directional
    let posSize = Math.min(1, 0.5 + Math.abs(signal.score)*1.5); // Always at least 50% invested
    // High-conviction leverage: 2x on strong signals
    if (Math.abs(signal.score) >= 0.25) posSize = Math.min(2.5, posSize * 2.0);
    const pnl = dir * day[fwdKey] * posSize * equity;
    equity += pnl;
    maxEquity = Math.max(maxEquity, equity);
    maxDD = Math.max(maxDD, (maxEquity-equity)/maxEquity*100);

    if(pnl>0) totalPnlWin+=pnl; else totalPnlLoss+=Math.abs(pnl);

    const won=(signal.direction==='BULL'&&day[fwdKey]>0)||(signal.direction==='BEAR'&&day[fwdKey]<0);
    if(won){wins++;ws++;ls=0;maxWS=Math.max(maxWS,ws);}
    else{ls++;ws=0;maxLS=Math.max(maxLS,ls);}
    total++;
    stratReturns.push(dir*day[fwdKey]);

    // Direction
    dirResults[signal.direction].total++;
    if(won) dirResults[signal.direction].wins++;

    // Yearly
    const yr=day.date.slice(0,4);
    if(!yearlyResults[yr]) yearlyResults[yr]={wins:0,total:0,pnl:0,returns:[]};
    yearlyResults[yr].total++;
    if(won) yearlyResults[yr].wins++;
    yearlyResults[yr].pnl+=pnl;
    yearlyResults[yr].returns.push(dir*day[fwdKey]);

    // Score buckets
    const bucket = (Math.round(signal.score*10)/10).toFixed(1);
    if(!scoreBuckets[bucket]) scoreBuckets[bucket]={wins:0,total:0,sumRet:0};
    scoreBuckets[bucket].total++;
    if(won) scoreBuckets[bucket].wins++;
    scoreBuckets[bucket].sumRet+=day[fwdKey];
  }

  const accuracy=(wins/total*100).toFixed(2);
  const meanRet=stratReturns.reduce((a,b)=>a+b,0)/stratReturns.length;
  const stdRet=Math.sqrt(stratReturns.reduce((a,b)=>a+(b-meanRet)**2,0)/stratReturns.length);
  const sharpe=stdRet>0?(meanRet/stdRet)*Math.sqrt(252/fwdBars):0;
  const pf=totalPnlLoss>0?totalPnlWin/totalPnlLoss:Infinity;
  const years=(new Date(days[days.length-1].date)-new Date(days[0].date))/(365.25*86400000);
  const cagr=((equity/10000)**(1/years)-1)*100;

  console.log(`\n${'═'.repeat(65)}`);
  console.log(` ${label} BACKTEST RESULTS`);
  console.log(`${'═'.repeat(65)}\n`);

  console.log(`📅 Period:           ${days[0].date} → ${days[days.length-1].date} (${years.toFixed(1)} years)`);
  console.log(`📊 Total periods:    ${total} (every ${fwdBars} trading days, always invested)`);
  console.log(`✅ Wins:             ${wins}`);
  console.log(`❌ Losses:           ${total - wins}`);
  console.log(`🎯 Accuracy:         ${accuracy}%`);
  console.log('');
  console.log('── Performance Metrics ──────────────────────────────────────');
  console.log(`💰 Starting equity:  $10,000`);
  console.log(`💰 Final equity:     $${equity.toFixed(2)}`);
  console.log(`📈 Total return:     ${((equity/10000-1)*100).toFixed(2)}%`);
  console.log(`📈 CAGR:             ${cagr.toFixed(2)}%`);
  console.log(`📊 Sharpe ratio:     ${sharpe.toFixed(3)}`);
  console.log(`📊 Profit factor:    ${pf.toFixed(3)}`);
  console.log(`📉 Max drawdown:     ${maxDD.toFixed(2)}%`);
  console.log(`🔥 Max win streak:   ${maxWS}`);
  console.log(`❄️  Max loss streak:  ${maxLS}`);

  // Buy-and-hold comparison
  const firstPrice = days[0].close;
  const lastPrice = days[days.length-1].close;
  const bhReturn = ((lastPrice/firstPrice-1)*100);
  const bhCAGR = ((lastPrice/firstPrice)**(1/years)-1)*100;
  const bhFinal = 10000 * lastPrice / firstPrice;
  console.log('');
  console.log('── Buy & Hold Comparison ────────────────────────────────────');
  console.log(`  ASX 200 B&H:      $10,000 → $${bhFinal.toFixed(0)} (${bhReturn.toFixed(1)}%, ${bhCAGR.toFixed(1)}% CAGR)`);
  console.log(`  Model:             $10,000 → $${equity.toFixed(0)} (${((equity/10000-1)*100).toFixed(1)}%, ${cagr.toFixed(1)}% CAGR)`);
  console.log(`  Alpha vs B&H:      ${(cagr-bhCAGR).toFixed(1)}% CAGR`);

  console.log('\n── Accuracy by Direction ────────────────────────────────────');
  for(const [d,r] of Object.entries(dirResults)) {
    if(r.total>0) console.log(`  ${d.padEnd(10)} ${(r.wins/r.total*100).toFixed(1)}% (${r.wins}/${r.total})`);
  }

  console.log('\n── Yearly Breakdown ────────────────────────────────────────');
  console.log('  Year    Accuracy    Signals    PnL($)       Sharpe');
  for(const [yr,r] of Object.entries(yearlyResults).sort()) {
    const yrMean=r.returns.reduce((a,b)=>a+b,0)/r.returns.length;
    const yrStd=Math.sqrt(r.returns.reduce((a,b)=>a+(b-yrMean)**2,0)/r.returns.length);
    const yrSharpe=yrStd>0?(yrMean/yrStd)*Math.sqrt(252/fwdBars):0;
    console.log(`  ${yr}      ${(r.wins/r.total*100).toFixed(1)}%     ${String(r.total).padStart(5)}    ${r.pnl>=0?'+':' '}${String(r.pnl.toFixed(0)).padStart(7)}      ${yrSharpe.toFixed(2)}`);
  }

  console.log('\n── Score Distribution ───────────────────────────────────────');
  console.log('  Score    Count   Accuracy   Avg Fwd Return');
  for(const bucket of Object.keys(scoreBuckets).sort((a,b)=>+a-+b)) {
    const b=scoreBuckets[bucket];
    if(b.total>=3) console.log(`  ${bucket.padStart(5)}     ${String(b.total).padStart(4)}   ${(b.wins/b.total*100).toFixed(1)}%      ${(b.sumRet/b.total*100).toFixed(3)}%`);
  }

  // High conviction
  const hcBull=Object.entries(scoreBuckets).filter(([k])=>+k>=0.3).reduce((a,[,v])=>({wins:a.wins+v.wins,total:a.total+v.total}),{wins:0,total:0});
  const hcBear=Object.entries(scoreBuckets).filter(([k])=>+k<=-0.3).reduce((a,[,v])=>({wins:a.wins+v.wins,total:a.total+v.total}),{wins:0,total:0});
  if(hcBull.total>0) console.log(`\n  Strong BULL (>0.3): ${(hcBull.wins/hcBull.total*100).toFixed(1)}% accuracy (${hcBull.wins}/${hcBull.total})`);
  if(hcBear.total>0) console.log(`  Strong BEAR (<-0.3): ${(hcBear.wins/hcBear.total*100).toFixed(1)}% accuracy (${hcBear.wins}/${hcBear.total})`);

  console.log('\n── Optimized Weights ────────────────────────────────────────');
  const groups = {
    'INTERMARKET': ['wSPX1d','wSPX5d','wSPX20d','wVIXChg','wVIX5d','wVIXLevel','wOil','wAUD','wBond','wGold'],
    'CONTRARIAN': ['wCont1d','wCont5d','wCont10d','wCont20d'],
    'TREND': ['wEMA','wADX','wMACD','wIchimoku','wSuperTrend','wHurst','wRSI'],
    'STAT/MR': ['wZScore','wConsec','wMeanRev','wWR','wBoll','wStoch'],
    'OTHER': ['wCal','wVol'],
  };
  for(const [g,keys] of Object.entries(groups)) {
    console.log(`  ${g}:`);
    for(const k of keys) console.log(`    ${k.padEnd(16)} ${(cfg[k]||0).toFixed(2)}`);
  }

  return { accuracy: wins/total, equity, sharpe, pf, maxDD, cagr };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' ApexTrade Multi-Timeframe Backtest + Optimizer');
  console.log(`  Timeframe: ${TIMEFRAME.toUpperCase()}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('📡 Fetching max-range historical data...\n');
  const [asxData,vixData,goldData,oilData,audData,bondData,spxData] = await Promise.all([
    safeFetch('^AXJO','25y'), safeFetch('^VIX','25y'), safeFetch('GC=F','25y'),
    safeFetch('CL=F','25y'), safeFetch('AUDUSD=X','25y'), safeFetch('^TNX','25y'), safeFetch('^GSPC','25y'),
  ]);

  if(!asxData||asxData.length<500){console.error('❌ Insufficient ASX data');return;}
  const startDate=new Date(asxData[0].t).toISOString().slice(0,10);
  const endDate=new Date(asxData[asxData.length-1].t).toISOString().slice(0,10);
  console.log(`  ASX: ${asxData.length} bars (${startDate} → ${endDate})`);
  console.log(`  SPX: ${spxData?.length||0} | VIX: ${vixData?.length||0} | Oil: ${oilData?.length||0}`);
  console.log(`  AUD: ${audData?.length||0} | Gold: ${goldData?.length||0} | Bond: ${bondData?.length||0}`);

  console.log('\n⚙️  Pre-computing indicators...');
  const days = precompute(asxData, vixData, goldData, oilData, audData, bondData, spxData);
  console.log(`  ${days.length} trading days pre-computed (${days[0].date} → ${days[days.length-1].date})`);

  if (TIMEFRAME === 'weekly' || TIMEFRAME === 'both') {
    console.log('\n' + '═'.repeat(65));
    console.log(' OPTIMIZING WEEKLY (5-DAY FORWARD) PREDICTIONS');
    console.log('═'.repeat(65));

    const weeklyBest = optimize(days, WEEKLY_BASE, 'weekly');
    runFullBacktest(days, weeklyBest.cfg, 'weekly');

    console.log('\n── Weekly Config JSON ──');
    const wCfg = { ...weeklyBest.cfg }; delete wCfg.label;
    console.log(JSON.stringify(wCfg, null, 2));
  }

  if (TIMEFRAME === 'monthly' || TIMEFRAME === 'both') {
    console.log('\n' + '═'.repeat(65));
    console.log(' OPTIMIZING MONTHLY (22-DAY FORWARD) PREDICTIONS');
    console.log('═'.repeat(65));

    const monthlyBest = optimize(days, MONTHLY_BASE, 'monthly');
    runFullBacktest(days, monthlyBest.cfg, 'monthly');

    console.log('\n── Monthly Config JSON ──');
    const mCfg = { ...monthlyBest.cfg }; delete mCfg.label;
    console.log(JSON.stringify(mCfg, null, 2));
  }

  console.log('\n' + '═'.repeat(65));
  console.log(' OPTIMIZATION COMPLETE');
  console.log('═'.repeat(65));
}

main().catch(console.error);
