exports.handler = async (event) => {
  const H = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:H,body:''};
  const {ticker} = event.queryStringParameters||{};
  if (!ticker) return {statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  const sym = ticker.includes('.')?ticker:ticker+'.AX';
  async function yf(interval,range){
    const r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+interval+'&range='+range,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status+' '+interval);
    const d=await r.json();
    const res=d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    const ts=res.timestamp||[],q=(res.indicators&&res.indicators.quote&&res.indicators.quote[0])||{};
    return ts.map((t,i)=>({t:t*1000,date:new Date(t*1000).toISOString().slice(0,7),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i]})).filter(c=>c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null);
  }
  function every(arr,n){
    const out=[];
    for(var i=0;i<arr.length;i+=n){
      var s=arr.slice(i,i+n);
      if(!s.length)continue;
      out.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max.apply(null,s.map(function(x){return x.h;})),l:Math.min.apply(null,s.map(function(x){return x.l;})),c:s[s.length-1].c});
    }
    return out;
  }
  try {
    var mo1=await yf('1mo','10y');
    var mo3=await yf('3mo','10y');
    var wk1=await yf('1wk','5y');
    var day1=await yf('1d','3y');
    if(!mo1.length)throw new Error('no monthly data');
    function agg2d(arr){var out=[];for(var i=0;i<arr.length;i+=2){var s=arr.slice(i,i+2);if(!s.length)continue;out.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max(s[0].h,s[1]?s[1].h:s[0].h),l:Math.min(s[0].l,s[1]?s[1].l:s[0].l),c:s[s.length-1].c});}return out;}
    var day2=agg2d(day1);
    var MODELS=[
      {label:'1M CRT', C:mo1,         T:day2, entryTFs:['1D','4H']},
      {label:'3M CRT', C:mo3,         T:mo1,  entryTFs:['2D','3D']},
      {label:'6M CRT', C:every(mo1,6),T:wk1,  entryTFs:['2W','1W']},
      {label:'9M CRT', C:every(mo1,9),T:wk1,  entryTFs:['2W','1W']},
      {label:'12M CRT',C:every(mo1,12),T:mo1, entryTFs:['3W','2W']},
    ];
    var signals=[];
    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi],C=m.C,T=m.T;
      if(!C||C.length<3)continue;
      // Only check the MOST RECENT completed CRT candle = C[-3]
      // C[-3]=CRT, C[-2]=inside/sweep, C[-1]=current (TBOS forming or confirmed)
      // Also check C[-2] as CRT with C[-1] as inside, current candle as sweep/TBOS
      var checks=[
        {crtIdx:C.length-3, innerIdx:C.length-2, isCurrent:true},
        {crtIdx:C.length-4, innerIdx:C.length-3, isCurrent:false},
      ];
      for(var ci=0;ci<checks.length;ci++){
        var ck=checks[ci];
        if(ck.crtIdx<0||ck.innerIdx<0||ck.innerIdx>=C.length)continue;
        var crt=C[ck.crtIdx],inner=C[ck.innerIdx];
        if(!crt||!inner)continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0)continue;
        // Rule: inner candle BODY (open AND close) must be inside CRT range
        var bHi=Math.max(inner.o,inner.c),bLo=Math.min(inner.o,inner.c);
        if(bHi>crt.h||bLo<crt.l)continue;
        for(var dir=0;dir<2;dir++){
          var bull=dir===0;
          var sweepLvl=bull?crt.l:crt.h;
          // Get TBOS-timeframe candles after the CRT candle formed
          var tbos=T.filter(function(x){return x.t>crt.t;});
          if(!tbos.length)continue;
          // Find sweep: wick past sweepLvl, close back inside (NOT closed past it)
          var purges=0,firstPurgeIdx=-1,lastPurgeIdx=-1,invalidated=false;
          for(var j=0;j<tbos.length;j++){
            var wicked=bull?(tbos[j].l<sweepLvl):(tbos[j].h>sweepLvl);
            var closedPast=bull?(tbos[j].c<sweepLvl):(tbos[j].c>sweepLvl);
            if(closedPast){invalidated=true;break;}
            if(wicked){if(firstPurgeIdx<0)firstPurgeIdx=j;purges++;lastPurgeIdx=j;}
          }
          if(invalidated||purges===0)continue;
          // TBOS level = swing high/low that formed after CRT and BEFORE first sweep
          var tbosLvl=null;
          for(var j=0;j<firstPurgeIdx;j++){
            if(bull){if(tbosLvl===null||tbos[j].h>tbosLvl)tbosLvl=tbos[j].h;}
            else{if(tbosLvl===null||tbos[j].l<tbosLvl)tbosLvl=tbos[j].l;}
          }
          // Fallback: use the CRT high/low as TBOS level (no swing formed before sweep)
          if(tbosLvl===null)tbosLvl=bull?crt.h:crt.l;
          // Find TBOS candle after last purge
          var tbosC=null,tbosAge=null;
          for(var j=lastPurgeIdx+1;j<tbos.length;j++){
            var tbosed=bull?(tbos[j].c>tbosLvl):(tbos[j].c<tbosLvl);
            if(tbosed){tbosC=tbos[j];tbosAge=tbos.length-1-j;break;}
          }
          // Check if currently sweeping (no TBOS yet)
          var lastT=tbos[tbos.length-1];
          var sweepingNow=(bull?(lastT.l<sweepLvl&&lastT.c>=sweepLvl):(lastT.h>sweepLvl&&lastT.c<=sweepLvl))&&!tbosC;
          // Check if TBOS forming now (price above TBOS level on current candle, not yet closed)
          var tbosForming=(bull?(lastT.c>tbosLvl):(lastT.c<tbosLvl))&&!tbosC;
          if(!tbosC&&!sweepingNow&&!tbosForming)continue;
          if(tbosC&&tbosAge>3)continue;
          var conf=60;
          if(purges>=2)conf+=10;
          if(tbosForming)conf+=15;
          else if(tbosC&&tbosAge===0)conf+=15;
          else if(tbosC&&tbosAge===1)conf+=10;
          else if(tbosC&&tbosAge===2)conf+=5;
          if(sweepingNow)conf+=5;
          if((bHi-bLo)/crtRange<0.5)conf+=5;
          conf=Math.min(conf,85);
          var sweepC=tbos[lastPurgeIdx];
          signals.push({
            type:purges>=2?'Double Purge CRT':'Classic CRT',
            model:m.label,direction:bull?'LONG':'SHORT',
            crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
            innerClose:inner.c,innerDate:inner.date,
            tbosLevel:tbosLvl,
            tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
            tbosAge:tbosC?tbosAge:-1,purgeCount:purges,
            sweepDate:sweepC.date,sweepLow:bull?sweepC.l:null,sweepHigh:bull?null:sweepC.h,
            entryTFs:m.entryTFs,baseConfidence:conf,
            sweepingNow:sweepingNow,tbosForming:tbosForming,
          });
        }
      }
    }
    var price=day1.length?day1[day1.length-1].c:null;
    return {statusCode:200,headers:H,body:JSON.stringify({ticker,signals,meta:{price,date:day1.length?day1[day1.length-1].date:null}})};
  }catch(err){
    return {statusCode:200,headers:H,body:JSON.stringify({ticker,signals:[],error:err.message})};
  }
};