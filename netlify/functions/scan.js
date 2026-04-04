exports.handler = async (event) => {
  var H={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:H,body:''};
  var qp=event.queryStringParameters||{};
  var ticker=qp.ticker;
  if(!ticker)return{statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  var sym=ticker.includes('.')?ticker:ticker+'.AX';

  async function yf(interval,range){
    var url='https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+interval+'&range='+range;
    var r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status);
    var d=await r.json();
    var res=d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    var ts=res.timestamp||[];
    var q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
    return ts.map(function(t,i){
      return{t:t*1000,date:new Date(t*1000).toISOString().slice(0,10),
        o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i]};
    }).filter(function(c){return c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null;});
  }

  // Group monthly candles by calendar period
  // groupKey: function that returns a string key for each monthly candle
  function groupBy(mo1,keyFn){
    var groups={},order=[];
    for(var i=0;i<mo1.length;i++){
      var c=mo1[i];
      var k=keyFn(c);
      if(!groups[k]){groups[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,candles:[]};order.push(k);}
      var g=groups[k];
      if(c.h>g.h)g.h=c.h;
      if(c.l<g.l)g.l=c.l;
      g.c=c.c; // last candle in group = close
      g.candles.push(c);
    }
    return order.map(function(k){return groups[k];}).filter(function(g){return g.candles.length>0;});
  }

  // Calendar year: Jan-Dec
  function yr(c){return c.date.substring(0,4);}
  // Calendar quarter: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  function qtr(c){var m=parseInt(c.date.substring(5,7));var q=Math.floor((m-1)/3)+1;return c.date.substring(0,4)+'-Q'+q;}
  // Calendar half-year: H1=Jan-Jun, H2=Jul-Dec
  function half(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+(m<=6?'-H1':'-H2');}
  // 9M: group as 3 quarters = Jan-Sep and Oct-Dec rolls into next year's group
  // Approximate: use 3-quarter blocks anchored Jan, so Jan-Sep=period1, Oct-Dec+Jan-Mar=period2 etc
  function nine(c){
    var y=parseInt(c.date.substring(0,4));
    var m=parseInt(c.date.substring(5,7));
    // Jan-Sep = year period 1, Oct-Dec = year period 2 (starts 9M group)
    if(m<=9)return y+'-P1';
    return y+'-P2';
  }

  try{
    var mo1=await yf('1mo','15y');
    var wk1=await yf('1wk','5y');
    var day1=await yf('1d','3y');
    if(!mo1.length)throw new Error('no monthly data');

    // Build 2-day candles from daily
    var day2=[];
    for(var i=0;i<day1.length;i+=2){
      var s=day1.slice(i,i+2);
      if(!s.length)continue;
      day2.push({t:s[0].t,date:s[0].date,o:s[0].o,
        h:Math.max.apply(null,s.map(function(x){return x.h;})),
        l:Math.min.apply(null,s.map(function(x){return x.l;})),
        c:s[s.length-1].c});
    }

    // CRT models with proper calendar groupings
    var MODELS=[
      {label:'1M CRT', C:mo1,              T:day2, entryTFs:['1D','4H']},
      {label:'3M CRT', C:groupBy(mo1,qtr), T:mo1,  entryTFs:['2D','3D']},
      {label:'6M CRT', C:groupBy(mo1,half),T:wk1,  entryTFs:['2W','1W']},
      {label:'9M CRT', C:groupBy(mo1,nine),T:wk1,  entryTFs:['2W','1W']},
      {label:'12M CRT',C:groupBy(mo1,yr),  T:mo1,  entryTFs:['3W','2W']},
    ];

    var signals=[];

    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi],C=m.C,T=m.T;
      if(!C||C.length<3)continue;

      // Check last 2 completed CRT candles as potential CRT candle
      // C[n-2] = CRT, C[n-1] = inside candle (must close inside CRT body/range)
      // Then look at TBOS timeframe for sweep + TBOS
      for(var ii=C.length-3;ii<=C.length-2;ii++){
        if(ii<0)continue;
        var crt=C[ii],inner=C[ii+1];
        if(!crt||!inner)continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0)continue;

        // Rule: inner candle BODY (open AND close) must be inside CRT high/low range
        var bHi=Math.max(inner.o,inner.c);
        var bLo=Math.min(inner.o,inner.c);
        if(bHi>crt.h||bLo<crt.l)continue;

        // Check bullish and bearish
        for(var dir=0;dir<2;dir++){
          var bull=dir===0;
          var sweepLvl=bull?crt.l:crt.h;

          // TBOS candles that come AFTER the inner candle
          var tbos=T.filter(function(x){return x.t>inner.t;});
          if(!tbos.length)continue;

          // Find purges: wicks past sweepLvl, close back inside (no close past)
          var purges=0,firstPurgeIdx=-1,lastPurgeIdx=-1,invalidated=false;
          for(var j=0;j<tbos.length;j++){
            var wicked=bull?(tbos[j].l<sweepLvl):(tbos[j].h>sweepLvl);
            var closedPast=bull?(tbos[j].c<sweepLvl):(tbos[j].c>sweepLvl);
            if(closedPast){invalidated=true;break;}
            if(wicked){if(firstPurgeIdx<0)firstPurgeIdx=j;purges++;lastPurgeIdx=j;}
          }
          if(invalidated||purges===0)continue;

          // TBOS level = highest high (bull) or lowest low (bear) before first purge
          var tbosLvl=null;
          for(var j=0;j<firstPurgeIdx;j++){
            if(bull){if(tbosLvl===null||tbos[j].h>tbosLvl)tbosLvl=tbos[j].h;}
            else{if(tbosLvl===null||tbos[j].l<tbosLvl)tbosLvl=tbos[j].l;}
          }
          // Fallback to CRT high/low if no swing formed before first purge
          if(tbosLvl===null)tbosLvl=bull?crt.h:crt.l;

          // Find TBOS candle after last purge
          var tbosC=null,tbosAge=null;
          for(var j=lastPurgeIdx+1;j<tbos.length;j++){
            var bosed=bull?(tbos[j].c>tbosLvl):(tbos[j].c<tbosLvl);
            if(bosed){tbosC=tbos[j];tbosAge=tbos.length-1-j;break;}
          }

          // Is current candle sweeping now?
          var last=tbos[tbos.length-1];
          var sweepingNow=(bull?(last.l<sweepLvl&&last.c>=sweepLvl):(last.h>sweepLvl&&last.c<=sweepLvl))&&!tbosC;
          // Is TBOS forming on current candle?
          var tbosForming=!tbosC&&!sweepingNow&&(bull?(last.c>tbosLvl):(last.c<tbosLvl));

          if(!tbosC&&!sweepingNow&&!tbosForming)continue;
          if(tbosC&&tbosAge>3)continue;

          // Confidence scoring
          var conf=60;
          if(purges>=2)conf+=10;
          if(tbosForming)conf+=15;
          else if(tbosC&&tbosAge===0)conf+=15;
          else if(tbosC&&tbosAge===1)conf+=10;
          else if(tbosC&&tbosAge===2)conf+=5;
          if(sweepingNow)conf+=5;
          // Tight inside candle (small body relative to CRT)
          if((bHi-bLo)/crtRange<0.5)conf+=5;
          conf=Math.min(conf,85);

          var sweepC=tbos[lastPurgeIdx];
          signals.push({
            type:purges>=2?'Double Purge CRT':'Classic CRT',
            model:m.label,
            direction:bull?'LONG':'SHORT',
            crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
            innerClose:inner.c,innerDate:inner.date,
            tbosLevel:tbosLvl,
            tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
            tbosAge:tbosC?tbosAge:-1,
            purgeCount:purges,
            sweepDate:sweepC.date,
            sweepLow:bull?sweepC.l:null,
            sweepHigh:bull?null:sweepC.h,
            entryTFs:m.entryTFs,
            baseConfidence:conf,
            sweepingNow:sweepingNow,
            tbosForming:tbosForming,
          });
        }
      }
    }

    var price=day1.length?day1[day1.length-1].c:null;
    var date=day1.length?day1[day1.length-1].date:null;
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals,meta:{price,date}})};
  }catch(err){
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals:[],error:err.message})};
  }
};