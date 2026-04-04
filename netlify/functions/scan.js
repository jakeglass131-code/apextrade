// CRT Scanner — evaluates all 4 CRT models across all 5 timeframes
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
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('no data');
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const raw = ts.map((t,i) => ({ t:t*1000, date:new Date(t*1000).toISOString().slice(0,10), o:q.open?.[i], h:q.high?.[i], l:q.low?.[i], c:q.close?.[i], v:q.volume?.[i]||0 })).filter(c=>c.o&&c.c);
    if (raw.length < 20) throw new Error('insufficient data');
    const agg = (d,n) => { const o=[]; for(let i=0;i<d.length;i+=n){const s=d.slice(i,i+n);if(!s.length)continue;o.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max(...s.map(x=>x.h)),l:Math.min(...s.map(x=>x.l)),c:s[s.length-1].c,v:s.reduce((a,x)=>a+x.v,0)});}return o; };
    const C = { '1D':raw,'2D':agg(raw,2),'3D':agg(raw,3),'4D':agg(raw,4),'1W':agg(raw,5),'2W':agg(raw,10),'3W':agg(raw,15),'1M':agg(raw,21),'3M':agg(raw,63),'6M':agg(raw,126),'9M':agg(raw,189),'12M':agg(raw,252) };
    const MODELS = [
      {label:'1M CRT',crtTF:'1M',tbosTF:'2D',entryTFs:['1D','4H']},
      {label:'3M CRT',crtTF:'3M',tbosTF:'4D',entryTFs:['2D','3D']},
      {label:'6M CRT',crtTF:'6M',tbosTF:'2W',entryTFs:['2W','1W']},
      {label:'9M CRT',crtTF:'9M',tbosTF:'2W',entryTFs:['2W','1W']},
      {label:'12M CRT',crtTF:'12M',tbosTF:'1M',entryTFs:['3W','2W']},
    ];
    const signals = [];
    for (const m of MODELS) {
      const crtC = C[m.crtTF], tbosC = C[m.tbosTF];
      if (!crtC||crtC.length<3||!tbosC||tbosC.length<3) continue;
      for (let i=Math.max(1,crtC.length-4);i<crtC.length-1;i++) {
        const cc=crtC[i], rel=tbosC.filter(x=>x.t>=cc.t);
        if (rel.length<2) continue;
        // BULLISH: sweep low then BOS above swing high
        let swHi=null; for(let j=0;j<Math.min(rel.length,15);j++){if(rel[j].h>cc.l&&rel[j].h<cc.h){swHi=rel[j];break;}}
        if (swHi) {
          let swIdx=null,purge=0; for(let j=0;j<rel.length;j++){if(rel[j].l<cc.l){if(swIdx===null)swIdx=j;purge++;}}
          if (swIdx!==null) {
            let tbos=null,tIdx=null; for(let j=swIdx+1;j<rel.length;j++){if(rel[j].c>swHi.h){tbos=rel[j];tIdx=j;break;}}
            if (tbos) {
              const age=rel.length-1-tIdx;
              if(age<=5){let conf=60;if(purge>=2)conf+=5;if(age<=2)conf+=10;if(age===0)conf+=5;
              signals.push({type:purge>=2?'Double Purge CRT':'Classic CRT',model:m.label,direction:'LONG',crtHigh:cc.h,crtLow:cc.l,tbosLevel:swHi.h,tbosDate:tbos.date,tbosAge:age,purgeCount:purge,sweepLow:Math.min(...rel.slice(swIdx,swIdx+3).map(x=>x.l)),baseConfidence:Math.min(conf,85),entryTFs:m.entryTFs});}
            }
          }
        }
        // BEARISH: sweep high then BOS below swing low
        let swLo=null; for(let j=0;j<Math.min(rel.length,15);j++){if(rel[j].l>cc.l&&rel[j].l<cc.h){swLo=rel[j];break;}}
        if (swLo) {
          let swIdx=null,purge=0; for(let j=0;j<rel.length;j++){if(rel[j].h>cc.h){if(swIdx===null)swIdx=j;purge++;}}
          if (swIdx!==null) {
            let tbos=null,tIdx=null; for(let j=swIdx+1;j<rel.length;j++){if(rel[j].c<swLo.l){tbos=rel[j];tIdx=j;break;}}
            if (tbos) {
              const age=rel.length-1-tIdx;
              if(age<=5){let conf=60;if(purge>=2)conf+=5;if(age<=2)conf+=10;if(age===0)conf+=5;
              signals.push({type:purge>=2?'Double Purge CRT':'Classic CRT',model:m.label,direction:'SHORT',crtHigh:cc.h,crtLow:cc.l,tbosLevel:swLo.l,tbosDate:tbos.date,tbosAge:age,purgeCount:purge,sweepHigh:Math.max(...rel.slice(swIdx,swIdx+3).map(x=>x.h)),baseConfidence:Math.min(conf,85),entryTFs:m.entryTFs});}
            }
          }
        }
      }
    }
    return { statusCode:200, headers, body:JSON.stringify({ ticker, signals, meta:{ price:raw[raw.length-1]?.c, date:raw[raw.length-1]?.date } }) };
  } catch(err) {
    return { statusCode:200, headers, body:JSON.stringify({ ticker, signals:[], error:err.message }) };
  }
};