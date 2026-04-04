// CRT Scanner - Jake's exact rules
// CRT = C[-2] establishes range; C[-1] closes inside C[-2]; C[0] wicks below low (no close below), then closes above TBOS level
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const { ticker } = event.queryStringParameters || {};
  if (!ticker) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ticker required' }) };
  const symbol = ticker.includes('.') ? ticker : ticker + '.AX';
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=2y', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Yahoo ' + r.status);
    const data = await r.json();
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error('no data');
    const ts = result.timestamp || [];
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0] || {};
    const raw = ts.map((t, i) => ({ t: t*1000, date: new Date(t*1000).toISOString().slice(0,10), o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i], v: q.volume && q.volume[i] || 0 })).filter(c => c.o != null && c.c != null && c.h != null && c.l != null);
    if (raw.length < 20) throw new Error('insufficient data');
    function agg(days) {
      const out = [];
      for (let i = 0; i < raw.length; i += days) {
        const s = raw.slice(i, i + days);
        if (!s.length) continue;
        out.push({ t: s[0].t, date: s[0].date, o: s[0].o, h: Math.max.apply(null, s.map(x => x.h)), l: Math.min.apply(null, s.map(x => x.l)), c: s[s.length-1].c, v: s.reduce((a,x) => a+x.v, 0) });
      }
      return out;
    }
    const MODELS = [
      { label: '1M CRT', crt: agg(21), tbos: agg(2), entryTFs: ['1D','4H'] },
      { label: '3M CRT', crt: agg(63), tbos: agg(4), entryTFs: ['2D','3D'] },
      { label: '6M CRT', crt: agg(126), tbos: agg(10), entryTFs: ['2W','1W'] },
      { label: '9M CRT', crt: agg(189), tbos: agg(10), entryTFs: ['2W','1W'] },
      { label: '12M CRT', crt: agg(252), tbos: agg(21), entryTFs: ['3W','2W'] },
    ];
    const signals = [];
    for (let mi = 0; mi < MODELS.length; mi++) {
      const m = MODELS[mi];
      const C = m.crt, T = m.tbos;
      if (C.length < 3) continue;
      for (let dir = 0; dir < 2; dir++) {
        const bullish = dir === 0;
        for (let i = C.length - 3; i < C.length - 1; i++) {
          const crt = C[i], inner = C[i+1];
          const bodyHigh = Math.max(inner.o, inner.c);
          const bodyLow = Math.min(inner.o, inner.c);
          // Rule 1: inner body must be fully inside CRT range
          if (bodyHigh > crt.h || bodyLow < crt.l) continue;
          const crtRange = crt.h - crt.l;
          if (crtRange <= 0) continue;
          // Rule 2: sweep level
          const sweepLevel = bullish ? Math.min(crt.l, inner.l) : Math.max(crt.h, inner.h);
          // Get TBOS candles after CRT
          const tbosCandles = T.filter(x => x.t >= crt.t);
          if (tbosCandles.length < 2) continue;
          // Find first sweep (wick only - no close beyond sweep level)
          let firstSweepIdx = null;
          for (let j = 0; j < tbosCandles.length; j++) {
            const swept = bullish ? tbosCandles[j].l < sweepLevel : tbosCandles[j].h > sweepLevel;
            const closedBeyond = bullish ? tbosCandles[j].c < sweepLevel : tbosCandles[j].c > sweepLevel;
            if (swept && !closedBeyond) { firstSweepIdx = j; break; }
            if (closedBeyond) break; // closed beyond = invalid
          }
          if (firstSweepIdx === null) continue;
          // Find TBOS level = last swing high/low BEFORE first sweep
          let tbosLevel = null;
          for (let j = 0; j < firstSweepIdx; j++) {
            if (bullish) { if (tbosLevel === null || tbosCandles[j].h > tbosLevel) tbosLevel = tbosCandles[j].h; }
            else { if (tbosLevel === null || tbosCandles[j].l < tbosLevel) tbosLevel = tbosCandles[j].l; }
          }
          if (tbosLevel === null) continue;
          // Count purges after first sweep (wick only sweeps)
          let purgeCount = 0, lastPurgeIdx = firstSweepIdx;
          for (let j = firstSweepIdx; j < tbosCandles.length; j++) {
            const swept = bullish ? tbosCandles[j].l < sweepLevel : tbosCandles[j].h > sweepLevel;
            const closedBeyond = bullish ? tbosCandles[j].c < sweepLevel : tbosCandles[j].c > sweepLevel;
            const tbosed = bullish ? tbosCandles[j].c > tbosLevel : tbosCandles[j].c < tbosLevel;
            if (closedBeyond) break;
            if (swept && !closedBeyond) { purgeCount++; lastPurgeIdx = j; }
            if (tbosed) break;
          }
          if (purgeCount === 0) continue;
          // Find TBOS candle (close beyond TBOS level after last purge)
          let tbosCandle = null, tbosAge = null;
          for (let j = lastPurgeIdx + 1; j < tbosCandles.length; j++) {
            const tbosed = bullish ? tbosCandles[j].c > tbosLevel : tbosCandles[j].c < tbosLevel;
            if (tbosed) { tbosCandle = tbosCandles[j]; tbosAge = tbosCandles.length - 1 - j; break; }
          }
          // Check if sweep forming on current candle (no TBOS yet)
          const lastC = tbosCandles[tbosCandles.length - 1];
          const sweepingNow = (bullish ? lastC.l < sweepLevel && lastC.c >= sweepLevel : lastC.h > sweepLevel && lastC.c <= sweepLevel) && !tbosCandle;
          if (!tbosCandle && !sweepingNow) continue;
          if (tbosCandle && tbosAge > 3) continue;
          let conf = 60;
          if (purgeCount >= 2) conf += 10;
          if (tbosCandle && tbosAge === 0) conf += 15;
          if (tbosCandle && tbosAge === 1) conf += 10;
          if (tbosCandle && tbosAge === 2) conf += 5;
          if (sweepingNow) conf += 5;
          const innerBodyPct = (bodyHigh - bodyLow) / crtRange;
          if (innerBodyPct < 0.5) conf += 5;
          conf = Math.min(conf, 85);
          const sweepCandle = tbosCandles[firstSweepIdx];
          signals.push({
            type: purgeCount >= 2 ? 'Double Purge CRT' : 'Classic CRT',
            model: m.label, direction: bullish ? 'LONG' : 'SHORT',
            crtHigh: crt.h, crtLow: crt.l, crtDate: crt.date, innerClose: inner.c,
            tbosLevel, tbosDate: tbosCandle ? tbosCandle.date : (sweepingNow ? 'Forming' : null),
            tbosAge: tbosCandle ? tbosAge : -1, purgeCount,
            sweepLow: bullish ? sweepCandle.l : null, sweepHigh: bullish ? null : sweepCandle.h,
            sweepDate: sweepCandle.date, entryTFs: m.entryTFs, baseConfidence: conf, sweepingNow,
          });
        }
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ticker, signals, meta: { price: raw[raw.length-1] && raw[raw.length-1].c, date: raw[raw.length-1] && raw[raw.length-1].date, candles: raw.length } }) };
  } catch(err) {
    return { statusCode: 200, headers, body: JSON.stringify({ ticker, signals: [], error: err.message }) };
  }
};