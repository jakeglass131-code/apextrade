exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin':'*','Content-Type':'application/json' };
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:H,body:''};
  const {ticker} = event.queryStringParameters||{};
  if (!ticker) return {statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  const sym = ticker.includes('.')?ticker:ticker+'.AX';
  
  async function fetchCandles(interval, range) {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+interval+'&range='+range;
    const r = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
    if (!r.ok) throw new Error('Yahoo '+r.status+' '+interval);
    const d = await r.json();
    const res = d.chart&&d.chart.result&&d.chart.result[0];
    if (!res) throw new Error('no data '+interval);
    const ts=res.timestamp||[], q=(res.indicators&&res.indicators.quote&&res.indicators.quote[0])||{};
    return ts.map((t,i)=>({
      t:t*1000, date:new Date(t*1000).toISOString().slice(0,10),
      o:q.open&&q.open[i], h:q.high&&q.high[i],
      l:q.low&&q.low[i], c:q.close&&q.close[i],
    })).filter(c=>c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null);
  }
  
  try {
    // Fetch all needed timeframes in parallel
    // CRT TFs: 1mo=1M, 3mo=3M, 6mo~6M(use 3mo+count), 1y=12M
    // TBOS TFs: 1d, 5d=1W, 1wk=1W
    const [mo1, mo3, wk1, day2, day1] = await Promise.all([
      fetchCandles('1mo','10y'),   // 1M and 12M CRT
      fetchCandles('3mo','10y'),   // 3M, 6M, 9M CRT  
      fetchCandles('1wk','5y'),    // weekly TBOS
      fetchCandles('5d','5y'),     // ~2 week TBOS
      fetchCandles('1d','3y'),     // daily TBOS
    ]);
    
    if (!mo1.length||!mo3.length) throw new Error('no candle data');
    
    // Build 6M from monthly (every 6 months)
    function every(arr, n) {
      const out=[];
      for(let i=0;i<arr.length;i+=n){
        const s=arr.slice(i,i+n);
        if(!s.length)continue;
        out.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max.apply(null,s.map(x=>x.h)),l:Math.min.apply(null,s.map(x=>x.l)),c:s[s.length-1].c});
      }
      return out;
    }
    
    // 2D candles = aggregate daily into 2-day
    function agg2d(arr) {
      const out=[];
      for(let i=0;i<arr.length;i+=2){
        const s=arr.slice(i,i+2);
        if(!s.length)continue;
        out.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max.apply(null,s.map(x=>x.h)),l:Math.min.apply(null,s.map(x=>x.l)),c:s[s.length-1].c});
      }
      return out;
    }
    
    const day2agg = agg2d(day1);
    
    // Model definitions: [label, CRT candles, TBOS candles, entryTF labels]
    const MODELS = [
      {label:'1M CRT',  C:mo1,         T:day2agg, entryTFs:['1D','4H']},
      {label:'3M CRT',  C:mo3,         T:every(mo1,1), entryTFs:['2D','3D']},
      {label:'6M CRT',  C:every(mo1,6),T:wk1,     entryTFs:['2W','1W']},
      {label:'9M CRT',  C:every(mo1,9),T:wk1,     entryTFs:['2W','1W']},
      {label:'12M CRT', C:every(mo1,12),T:every(mo1,1),entryTFs:['3W','2W']},
    ];
    
    const signals=[];
    
    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi], C=m.C, T=m.T;
      if(!C||C.length<3||!T||T.length<2) continue;
      
      // Check last 5 completed CRT candles as potential CRT candles
      var startI=Math.max(0,C.length-6);
      for(var i=startI;i<C.length-1;i++){
        var crt=C[i], inner=C[i+1];
        
        // Rule 1: inner candle BODY must close inside CRT range
        var bHi=Math.max(inner.o,inner.c), bLo=Math.min(inner.o,inner.c);
        if(bHi>crt.h||bLo<crt.l) continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0) continue;
        
        // Check both directions
        for(var dir=0;dir<2;dir++){
          var bull=dir===0;
          var sweepLvl=bull?Math.min(crt.l,inner.l):Math.max(crt.h,inner.h);
          
          // Get TBOS candles that fall AFTER the inner candle started
          var tbos=T.filter(function(x){return x.t>inner.t;});
          if(!tbos.length) continue;
          
          // Walk through TBOS candles looking for sweep + TBOS
          var purges=0, firstPurgeIdx=-1, lastPurgeIdx=-1;
          var invalidated=false;
          
          for(var j=0;j<tbos.length;j++){
            var c=tbos[j];
            var wickedPast=bull?(c.l<sweepLvl):(c.h>sweepLvl);
            var closedPast=bull?(c.c<sweepLvl):(c.c>sweepLvl);
            
            // If price CLOSED past sweep level, setup invalidated
            if(closedPast){invalidated=true;break;}
            
            if(wickedPast){
              if(firstPurgeIdx<0)firstPurgeIdx=j;
              purges++;
              lastPurgeIdx=j;
            }
          }
          
          if(invalidated||purges===0) continue;
          
          // TBOS level = the swing high/low that formed before the first purge
          var tbosLvl=null;
          for(var j=0;j<firstPurgeIdx;j++){
            var c=tbos[j];
            if(bull){if(tbosLvl===null||c.h>tbosLvl)tbosLvl=c.h;}
            else{if(tbosLvl===null||c.l<tbosLvl)tbosLvl=c.l;}
          }
          // Fallback: use CRT high/low as TBOS level
          if(tbosLvl===null) tbosLvl=bull?crt.h:crt.l;
          
          // Find TBOS candle: closes past tbosLvl after last purge
          var tbosC=null, tbosAge=null;
          for(var j=lastPurgeIdx+1;j<tbos.length;j++){
            var c=tbos[j];
            var tbosed=bull?(c.c>tbosLvl):(c.c<tbosLvl);
            if(tbosed){tbosC=c;tbosAge=tbos.length-1-j;break;}
          }
          
          // Also valid: current TBOS candle is sweeping right now (no TBOS yet)
          var lastT=tbos[tbos.length-1];
          var sweepingNow=(bull?(lastT.l<sweepLvl&&lastT.c>=sweepLvl):(lastT.h>sweepLvl&&lastT.c<=sweepLvl))&&!tbosC;
          
          if(!tbosC&&!sweepingNow) continue;
          if(tbosC&&tbosAge>3) continue;
          
          // Confidence
          var conf=60;
          if(purges>=2)conf+=10;
          if(tbosC&&tbosAge===0)conf+=15;
          else if(tbosC&&tbosAge===1)conf+=10;
          else if(tbosC&&tbosAge===2)conf+=5;
          if(sweepingNow)conf+=5;
          if((bHi-bLo)/crtRange<0.5)conf+=5;
          conf=Math.min(conf,85);
          
          var sweepC=tbos[lastPurgeIdx];
          signals.push({
            type:purges>=2?'Double Purge CRT':'Classic CRT',
            model:m.label, direction:bull?'LONG':'SHORT',
            crtHigh:crt.h, crtLow:crt.l, crtDate:crt.date,
            innerClose:inner.c, innerDate:inner.date,
            tbosLevel:tbosLvl,
            tbosDate:tbosC?tbosC.date:(sweepingNow?'Forming':null),
            tbosAge:tbosC?tbosAge:-1,
            purgeCount:purges,
            sweepDate:sweepC.date,
            sweepLow:bull?sweepC.l:null,
            sweepHigh:bull?null:sweepC.h,
            entryTFs:m.entryTFs,
            baseConfidence:conf,
            sweepingNow:sweepingNow,
          });
        }
      }
    }
    
    var price=day1.length?day1[day1.length-1].c:null;
    return {statusCode:200,headers:H,body:JSON.stringify({ticker,signals,meta:{price,date:day1.length?day1[day1.length-1].date:null,mo1Count:mo1.length,mo3Count:mo3.length}})};
    
  } catch(err){
    return {statusCode:200,headers:H,body:JSON.stringify({ticker,signals:[],error:err.message})};
  }
};