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
    return ts.map(function(t,i){return{t:t*1000,date:new Date(t*1000).toISOString().slice(0,10),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i]};}).filter(function(c){return c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null;});
  }
  function groupBy(arr,keyFn){
    var groups={},order=[];
    for(var i=0;i<arr.length;i++){
      var c=arr[i],k=keyFn(c);
      if(!groups[k]){groups[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};order.push(k);}
      else{var g=groups[k];if(c.h>g.h)g.h=c.h;if(c.l<g.l)g.l=c.l;g.c=c.c;}
    }
    return order.map(function(k){return groups[k];});
  }
  function yr(c){return c.date.substring(0,4);}
  function qtr(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+'-Q'+Math.ceil(m/3);}
  function half(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+(m<=6?'-H1':'-H2');}
  function nine(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+(m<=9?'-P1':'-P2');}
  try{
    var mo1=await yf('1mo','15y');
    var wk1=await yf('1wk','5y');
    var day1=await yf('1d','3y');
    if(!mo1.length)throw new Error('no data');
    var day2=[];
    for(var i=0;i<day1.length;i+=2){var s=day1.slice(i,i+2);if(s.length)day2.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max(s[0].h,s[1]?s[1].h:s[0].h),l:Math.min(s[0].l,s[1]?s[1].l:s[0].l),c:s[s.length-1].c});}
    var MODELS=[
      {label:'1M CRT', C:mo1,              T:day2,entryTFs:['1D','4H']},
      {label:'3M CRT', C:groupBy(mo1,qtr), T:mo1, entryTFs:['2D','3D']},
      {label:'6M CRT', C:groupBy(mo1,half),T:wk1, entryTFs:['2W','1W']},
      {label:'9M CRT', C:groupBy(mo1,nine),T:wk1, entryTFs:['2W','1W']},
      {label:'12M CRT',C:groupBy(mo1,yr),  T:mo1, entryTFs:['3W','2W']},
    ];
    var signals=[];
    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi],C=m.C,T=m.T;
      if(!C||C.length<3)continue;
      for(var ii=C.length-3;ii<=C.length-2;ii++){
        if(ii<0)continue;
        var crt=C[ii],inner=C[ii+1];
        if(!crt||!inner)continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0)continue;
        // RULE: inner candle CLOSE must be inside CRT high/low range
        // (wicks can go outside — the sweep wick below is part of the setup)
        if(inner.c>crt.h||inner.c<crt.l)continue;
        for(var dir=0;dir<2;dir++){
          var bull=dir===0;
          var sweepLvl=bull?crt.l:crt.h;
          // Check if inner candle itself swept the level (wick only, close inside)
          var innerSwept=bull?(inner.l<sweepLvl):(inner.h>sweepLvl);
          // Get TBOS candles after the inner candle
          var tbos=T.filter(function(x){return x.t>inner.t;});
          // Count purges: inner candle sweep + any subsequent sweeps on TBOS TF
          var purges=0,lastPurgeT=inner.t,lastPurgeIdx=-1;
          var firstPurgeIdx=-1;
          // Inner candle counts as first purge if it swept
          if(innerSwept){purges++;lastPurgeT=inner.t;firstPurgeIdx=0;}
          var invalidated=false;
          for(var j=0;j<tbos.length;j++){
            var wicked=bull?(tbos[j].l<sweepLvl):(tbos[j].h>sweepLvl);
            var closedPast=bull?(tbos[j].c<sweepLvl):(tbos[j].c>sweepLvl);
            if(closedPast){invalidated=true;break;}
            if(wicked){if(firstPurgeIdx<0)firstPurgeIdx=j+1;purges++;lastPurgeIdx=j;}
          }
          if(invalidated||purges===0)continue;
          // TBOS level = swing high/low that formed after CRT and before first purge
          // Use CRT high/low as fallback
          var tbosLvl=bull?crt.h:crt.l;
          // Check for a swing high/low in TBOS candles before first purge
          for(var j=0;j<Math.max(0,firstPurgeIdx-1);j++){
            if(bull){if(tbos[j].h>tbosLvl)tbosLvl=tbos[j].h;}
            else{if(tbos[j].l<tbosLvl)tbosLvl=tbos[j].l;}
          }
          // Find TBOS candle after last purge
          var tbosC=null,tbosAge=null,startJ=lastPurgeIdx+1;
          if(innerSwept&&lastPurgeIdx<0)startJ=0;
          for(var j=startJ;j<tbos.length;j++){
            var bosed=bull?(tbos[j].c>tbosLvl):(tbos[j].c<tbosLvl);
            if(bosed){tbosC=tbos[j];tbosAge=tbos.length-1-j;break;}
          }
          var last=tbos.length?tbos[tbos.length-1]:null;
          var sweepingNow=last&&(bull?(last.l<sweepLvl&&last.c>=sweepLvl):(last.h>sweepLvl&&last.c<=sweepLvl))&&!tbosC;
          var tbosForming=last&&!tbosC&&!sweepingNow&&(bull?(last.c>tbosLvl):(last.c<tbosLvl));
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
          var sweepRef=lastPurgeIdx>=0?tbos[lastPurgeIdx]:inner;
          signals.push({
            type:purges>=2?'Double Purge CRT':'Classic CRT',
            model:m.label,direction:bull?'LONG':'SHORT',
            crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
            innerClose:inner.c,innerDate:inner.date,
            tbosLevel:tbosLvl,
            tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
            tbosAge:tbosC?tbosAge:-1,purgeCount:purges,
            sweepDate:sweepRef.date,
            sweepLow:bull?sweepRef.l:null,sweepHigh:bull?null:sweepRef.h,
            entryTFs:m.entryTFs,baseConfidence:conf,
            sweepingNow:sweepingNow,tbosForming:tbosForming,
          });
        }
      }
    }
    var price=day1.length?day1[day1.length-1].c:null;
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals,meta:{price,date:day1.length?day1[day1.length-1].date:null}})};
  }catch(err){
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,signals:[],error:err.message})};
  }
};