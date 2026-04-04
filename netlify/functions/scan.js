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
    const res = data.chart && data.chart.result && data.chart.result[0];
    if (!res) throw new Error('no data');
    const ts = res.timestamp || [];
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const raw = ts.map((t,i) => ({ t:t*1000, date:new Date(t*1000).toISOString().slice(0,10), o:q.open&&q.open[i], h:q.high&&q.high[i], l:q.low&&q.low[i], c:q.close&&q.close[i], v:(q.volume&&q.volume[i])||0 })).filter(c=>c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null);
    if (raw.length < 30) throw new Error('insufficient data');
    function agg(days) { const out=[]; for(let i=0;i<raw.length;i+=days){const s=raw.slice(i,i+days);if(!s.length)continue;out.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max.apply(null,s.map(x=>x.h)),l:Math.min.apply(null,s.map(x=>x.l)),c:s[s.length-1].c,v:s.reduce((a,x)=>a+x.v,0)});} return out; }
    const MODELS = [
      { label:'1M CRT', crt:agg(21), tbos:agg(2),  entryTFs:['1D','4H'] },
      { label:'3M CRT', crt:agg(63), tbos:agg(4),  entryTFs:['2D','3D'] },
      { label:'6M CRT', crt:agg(126),tbos:agg(10), entryTFs:['2W','1W'] },
      { label:'9M CRT', crt:agg(189),tbos:agg(10), entryTFs:['2W','1W'] },
      { label:'12M CRT',crt:agg(252),tbos:agg(21), entryTFs:['3W','2W'] },
    ];
    const signals = [];
    for (var mi=0;mi<MODELS.length;mi++) {
      var m=MODELS[mi], C=m.crt, T=m.tbos;
      if (C.length < 3) continue;
      // Check last 5 CRT candles as potential CRT candles
      var start = Math.max(0, C.length-6);
      for (var i=start; i<C.length-1; i++) {
        var crt=C[i], inner=C[i+1];
        // Rule 1: inner candle body must close inside CRT range
        var bHi=Math.max(inner.o,inner.c), bLo=Math.min(inner.o,inner.c);
        if (bHi>crt.h||bLo<crt.l) continue;
        var crtRange=crt.h-crt.l;
        if (crtRange<=0) continue;
        for (var dir=0;dir<2;dir++) {
          var bull = dir===0;
          var sweepLvl = bull ? Math.min(crt.l,inner.l) : Math.max(crt.h,inner.h);
          // Get TBOS candles from AFTER the inner candle formed
          var tbos = T.filter(function(x){return x.t>inner.t;});
          if (!tbos.length) continue;
          // Find sweep: wick past sweepLvl, close back inside
          var purges=0, lastPurgeIdx=-1, firstPurgeIdx=-1;
          var invalidClose=false;
          for (var j=0;j<tbos.length;j++) {
            var swept = bull?(tbos[j].l<sweepLvl):(tbos[j].h>sweepLvl);
            var closedBeyond = bull?(tbos[j].c<sweepLvl):(tbos[j].c>sweepLvl);
            if (closedBeyond) { invalidClose=true; break; }
            if (swept) { if(firstPurgeIdx<0)firstPurgeIdx=j; purges++; lastPurgeIdx=j; }
          }
          if (invalidClose||purges===0) continue;
          // Find TBOS level = last swing high/low before first purge
          var tbosLvl=null;
          for (var j=0;j<firstPurgeIdx;j++) {
            if (bull) { if(tbosLvl===null||tbos[j].h>tbosLvl)tbosLvl=tbos[j].h; }
            else { if(tbosLvl===null||tbos[j].l<tbosLvl)tbosLvl=tbos[j].l; }
          }
          // If no candles before first purge, use the CRT high/inner high as TBOS level
          if (tbosLvl===null) tbosLvl = bull?Math.max(crt.h,inner.h):Math.min(crt.l,inner.l);
          // Find TBOS candle: close past tbosLvl after last purge
          var tbosC=null, tbosAge=null;
          for (var j=lastPurgeIdx+1;j<tbos.length;j++) {
            var tbosed = bull?(tbos[j].c>tbosLvl):(tbos[j].c<tbosLvl);
            if (tbosed) { tbosC=tbos[j]; tbosAge=tbos.length-1-j; break; }
          }
          // Check if current candle is sweeping now (no TBOS yet)
          var lastT=tbos[tbos.length-1];
          var sweepingNow = (bull?(lastT.l<sweepLvl&&lastT.c>=sweepLvl):(lastT.h>sweepLvl&&lastT.c<=sweepLvl)) && !tbosC;
          if (!tbosC && !sweepingNow) continue;
          if (tbosC && tbosAge>3) continue;
          var conf=60;
          if(purges>=2)conf+=10;
          if(tbosC&&tbosAge===0)conf+=15;
          if(tbosC&&tbosAge===1)conf+=10;
          if(tbosC&&tbosAge===2)conf+=5;
          if(sweepingNow)conf+=5;
          if((bHi-bLo)/crtRange<0.5)conf+=5;
          conf=Math.min(conf,85);
          var sweepC=tbos[lastPurgeIdx];
          signals.push({
            type:purges>=2?'Double Purge CRT':'Classic CRT',
            model:m.label, direction:bull?'LONG':'SHORT',
            crtHigh:crt.h, crtLow:crt.l, crtDate:crt.date, innerClose:inner.c,
            tbosLevel:tbosLvl,
            tbosDate:tbosC?tbosC.date:(sweepingNow?'Forming':null),
            tbosAge:tbosC?tbosAge:-1, purgeCount:purges,
            sweepLow:bull?sweepC.l:null, sweepHigh:bull?null:sweepC.h,
            sweepDate:sweepC.date, entryTFs:m.entryTFs,
            baseConfidence:conf, sweepingNow:sweepingNow,
          });
        }
      }
    }
    return { statusCode:200, headers, body:JSON.stringify({ ticker, signals, meta:{ price:raw[raw.length-1].c, date:raw[raw.length-1].date, candles:raw.length } }) };
  } catch(err) {
    return { statusCode:200, headers, body:JSON.stringify({ ticker, signals:[], error:err.message }) };
  }
};