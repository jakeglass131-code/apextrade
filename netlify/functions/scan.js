exports.handler = async (event) => {
  var H={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:H,body:''};
  var ticker=(event.queryStringParameters||{}).ticker;
  if(!ticker)return{statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  var sym=ticker.includes('.')?ticker:ticker+'.AX';

  async function yf(interval,range){
    var r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+interval+'&range='+range,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status);
    var d=await r.json();
    var res=d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    var ts=res.timestamp||[],q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
    return ts.map(function(t,i){
      return{t:t*1000,date:new Date(t*1000).toISOString().slice(0,10),
        o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i]};
    }).filter(function(c){return c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null;});
  }

  // Group monthly candles by calendar year (Jan-Dec)
  function byYear(mo1){
    var g={},order=[];
    mo1.forEach(function(c){
      var y=c.date.substring(0,4);
      if(!g[y]){g[y]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};order.push(y);}
      else{if(c.h>g[y].h)g[y].h=c.h;if(c.l<g[y].l)g[y].l=c.l;g[y].c=c.c;}
    });
    return order.map(function(y){return g[y];});
  }

  // Group by calendar quarter (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec)
  function byQtr(mo1){
    var g={},order=[];
    mo1.forEach(function(c){
      var m=parseInt(c.date.substring(5,7));
      var k=c.date.substring(0,4)+'-Q'+Math.ceil(m/3);
      if(!g[k]){g[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};order.push(k);}
      else{if(c.h>g[k].h)g[k].h=c.h;if(c.l<g[k].l)g[k].l=c.l;g[k].c=c.c;}
    });
    return order.map(function(k){return g[k];});
  }

  // Group by calendar half-year (Jan-Jun, Jul-Dec)
  function byHalf(mo1){
    var g={},order=[];
    mo1.forEach(function(c){
      var m=parseInt(c.date.substring(5,7));
      var k=c.date.substring(0,4)+(m<=6?'-H1':'-H2');
      if(!g[k]){g[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};order.push(k);}
      else{if(c.h>g[k].h)g[k].h=c.h;if(c.l<g[k].l)g[k].l=c.l;g[k].c=c.c;}
    });
    return order.map(function(k){return g[k];});
  }

  // Group by 9-month periods anchored to calendar year (Jan-Sep = P1, Oct-Dec+next = spans year boundary)
  // Approximation: use 3 quarters as one block
  function byNine(mo1){
    var g={},order=[];
    mo1.forEach(function(c){
      var m=parseInt(c.date.substring(5,7));
      var y=c.date.substring(0,4);
      var k=m<=9?(y+'-P1'):(y+'-P2');
      if(!g[k]){g[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};order.push(k);}
      else{if(c.h>g[k].h)g[k].h=c.h;if(c.l<g[k].l)g[k].l=c.l;g[k].c=c.c;}
    });
    return order.map(function(k){return g[k];});
  }

  try{
    var mo1=await yf('1mo','15y');
    var wk1=await yf('1wk','5y');
    var day1=await yf('1d','3y');
    if(mo1.length<24)throw new Error('insufficient monthly data');

    var day2=[];
    for(var i=0;i<day1.length;i+=2){
      var s=day1.slice(i,i+2);
      if(s.length)day2.push({t:s[0].t,date:s[0].date,o:s[0].o,
        h:Math.max(s[0].h,s[1]?s[1].h:s[0].h),
        l:Math.min(s[0].l,s[1]?s[1].l:s[0].l),
        c:s[s.length-1].c});
    }

    // Models: CRT TF candles + TBOS TF candles
    var MODELS=[
      {label:'1M CRT', C:mo1,         T:day2,entryTFs:['1D','4H']},
      {label:'3M CRT', C:byQtr(mo1),  T:mo1, entryTFs:['2D','3D']},
      {label:'6M CRT', C:byHalf(mo1), T:wk1, entryTFs:['2W','1W']},
      {label:'9M CRT', C:byNine(mo1), T:wk1, entryTFs:['2W','1W']},
      {label:'12M CRT',C:byYear(mo1), T:mo1, entryTFs:['3W','2W']},
    ];

    var signals=[];

    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi],C=m.C,T=m.T;
      if(!C||C.length<3||!T||!T.length)continue;

      // Only check the 2 most recent completed CRT candles as potential CRT
      for(var ii=C.length-3;ii<=C.length-2;ii++){
        if(ii<0)continue;
        var crt=C[ii],inner=C[ii+1];
        if(!crt||!inner)continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0)continue;

        // BULLISH setup
        // Rule: inner candle close must be above CRT low (inside or above, but didn't close below)
        // Small tolerance of 0.5% for data discrepancies between brokers
        var tol=crtRange*0.005;
        if(inner.c<crt.l-tol)continue; // closed clearly below CRT low = invalid
        if(inner.c>crt.h+tol)continue; // closed clearly above CRT high = different setup

        var sweepLvl=crt.l;

        // Get TBOS timeframe candles after the CRT candle formed
        var tbos=T.filter(function(x){return x.t>crt.t;});
        if(!tbos.length)continue;

        // Find sweep: wick below CRT low, close back above (with tolerance)
        var purges=0,firstPurgeIdx=-1,lastPurgeIdx=-1,invalidated=false;
        for(var j=0;j<tbos.length;j++){
          var c=tbos[j];
          var wicked=c.l<sweepLvl;
          var closedBelow=c.c<sweepLvl-tol; // closed clearly below = invalidated
          if(closedBelow){invalidated=true;break;}
          if(wicked&&!closedBelow){
            if(firstPurgeIdx<0)firstPurgeIdx=j;
            purges++;lastPurgeIdx=j;
          }
        }
        if(invalidated||purges===0)continue;

        // TBOS level = highest high before first purge
        var tbosLvl=crt.h; // default to CRT high
        for(var j=0;j<firstPurgeIdx;j++){
          if(tbos[j].h>tbosLvl)tbosLvl=tbos[j].h;
        }

        // Find TBOS candle: close above tbosLvl after last purge
        var tbosC=null,tbosAge=null;
        for(var j=lastPurgeIdx+1;j<tbos.length;j++){
          if(tbos[j].c>tbosLvl){tbosC=tbos[j];tbosAge=tbos.length-1-j;break;}
        }
        var last=tbos[tbos.length-1];
        var sweepingNow=!tbosC&&last.l<sweepLvl&&last.c>=sweepLvl-tol;
        var tbosForming=!tbosC&&!sweepingNow&&last.c>tbosLvl;

        if(!tbosC&&!sweepingNow&&!tbosForming)continue;
        if(tbosC&&tbosAge>3)continue;

        var conf=60;
        if(purges>=2)conf+=10;
        if(tbosForming)conf+=15;
        else if(tbosC&&tbosAge===0)conf+=15;
        else if(tbosC&&tbosAge===1)conf+=10;
        else if(tbosC&&tbosAge===2)conf+=5;
        if(sweepingNow)conf+=5;
        conf=Math.min(conf,85);

        signals.push({
          type:purges>=2?'Double Purge CRT':'Classic CRT',
          model:m.label,direction:'LONG',
          crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
          innerClose:inner.c,innerDate:inner.date,
          tbosLevel:tbosLvl,
          tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
          tbosAge:tbosC?tbosAge:-1,purgeCount:purges,
          sweepDate:tbos[lastPurgeIdx].date,sweepLow:tbos[lastPurgeIdx].l,
          entryTFs:m.entryTFs,baseConfidence:conf,
          sweepingNow:sweepingNow,tbosForming:tbosForming,
        });

        // BEARISH mirror
        if(inner.c<crt.l-tol)continue;
        var sweepLvlB=crt.h;
        var purgesB=0,firstPurgeIdxB=-1,lastPurgeIdxB=-1,invalidatedB=false;
        for(var j=0;j<tbos.length;j++){
          var c=tbos[j];
          var wicked=c.h>sweepLvlB;
          var closedAbove=c.c>sweepLvlB+tol;
          if(closedAbove){invalidatedB=true;break;}
          if(wicked&&!closedAbove){
            if(firstPurgeIdxB<0)firstPurgeIdxB=j;
            purgesB++;lastPurgeIdxB=j;
          }
        }
        if(!invalidatedB&&purgesB>0){
          var tbosLvlB=crt.l;
          for(var j=0;j<firstPurgeIdxB;j++){if(tbos[j].l<tbosLvlB)tbosLvlB=tbos[j].l;}
          var tosCB=null,tosAgeB=null;
          for(var j=lastPurgeIdxB+1;j<tbos.length;j++){if(tbos[j].c<tbosLvlB){tosCB=tbos[j];tosAgeB=tbos.length-1-j;break;}}
          var lastB=tbos[tbos.length-1];
          var sweepingNowB=!tosCB&&lastB.h>sweepLvlB&&lastB.c<=sweepLvlB+tol;
          var tbosFormingB=!tosCB&&!sweepingNowB&&lastB.c<tbosLvlB;
          if((tosCB||sweepingNowB||tbosFormingB)&&(!tosCB||tosAgeB<=3)){
            var confB=60;
            if(purgesB>=2)confB+=10;
            if(tbosFormingB)confB+=15;
            else if(tosCB&&tosAgeB===0)confB+=15;
            else if(tosCB&&tosAgeB===1)confB+=10;
            else if(tosCB&&tosAgeB===2)confB+=5;
            if(sweepingNowB)confB+=5;
            confB=Math.min(confB,85);
            signals.push({
              type:purgesB>=2?'Double Purge CRT':'Classic CRT',
              model:m.label,direction:'SHORT',
              crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
              innerClose:inner.c,innerDate:inner.date,
              tbosLevel:tbosLvlB,
              tbosDate:tosCB?tosCB.date:(tbosFormingB?'Forming now':(sweepingNowB?'Sweep forming':null)),
              tbosAge:tosCB?tosAgeB:-1,purgeCount:purgesB,
              sweepDate:tbos[lastPurgeIdxB].date,sweepHigh:tbos[lastPurgeIdxB].h,
              entryTFs:m.entryTFs,baseConfidence:confB,
              sweepingNow:sweepingNowB,tbosForming:tbosFormingB,
            });
          }
        }
      }
    }

    var price=day1.length?day1[day1.length-1].c:null;
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals,meta:{price,date:day1.length?day1[day1.length-1].date:null}})};
  }catch(err){
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals:[],error:err.message})};
  }
};