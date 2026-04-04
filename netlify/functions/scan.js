exports.handler = async (event) => {
  var H={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:H,body:''};
  var ticker=(event.queryStringParameters||{}).ticker;
  if(!ticker)return{statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  var sym=ticker.includes('.')?ticker:ticker+'.AX';
  async function yf(iv,rg){
    var r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+iv+'&range='+rg,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status);
    var d=await r.json();
    var res=d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    var ts=res.timestamp||[],q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
    return ts.map(function(t,i){return{t:t*1000,date:new Date(t*1000).toISOString().slice(0,10),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i]};}).filter(function(c){return c.o!=null&&c.c!=null&&c.h!=null&&c.l!=null;});
  }
  function grp(arr,kFn){
    var g={},ord=[];
    arr.forEach(function(c){var k=kFn(c);if(!g[k]){g[k]={t:c.t,date:c.date,o:c.o,h:c.h,l:c.l,c:c.c};ord.push(k);}else{if(c.h>g[k].h)g[k].h=c.h;if(c.l<g[k].l)g[k].l=c.l;g[k].c=c.c;}});
    return ord.map(function(k){return g[k];});
  }
  function ky(c){return c.date.substring(0,4);}
  function kq(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+'-Q'+Math.ceil(m/3);}
  function kh(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+(m<=6?'-H1':'-H2');}
  function k9(c){var m=parseInt(c.date.substring(5,7));return c.date.substring(0,4)+(m<=9?'-P1':'-P2');}
  try{
    var mo1=await yf('1mo','15y');
    var wk1=await yf('1wk','5y');
    var day1=await yf('1d','3y');
    if(mo1.length<24)throw new Error('insufficient data');
    var day2=[];
    for(var i=0;i<day1.length;i+=2){var s=day1.slice(i,i+2);if(s.length)day2.push({t:s[0].t,date:s[0].date,o:s[0].o,h:Math.max(s[0].h,s[1]?s[1].h:s[0].h),l:Math.min(s[0].l,s[1]?s[1].l:s[0].l),c:s[s.length-1].c});}
    var MODELS=[
      {label:'1M CRT', C:mo1,         T:day2,entryTFs:['1D','4H']},
      {label:'3M CRT', C:grp(mo1,kq), T:mo1, entryTFs:['2D','3D']},
      {label:'6M CRT', C:grp(mo1,kh), T:wk1, entryTFs:['2W','1W']},
      {label:'9M CRT', C:grp(mo1,k9), T:wk1, entryTFs:['2W','1W']},
      {label:'12M CRT',C:grp(mo1,ky), T:mo1, entryTFs:['3W','2W']},
    ];
    var signals=[];
    for(var mi=0;mi<MODELS.length;mi++){
      var m=MODELS[mi],C=m.C,T=m.T;
      if(!C||C.length<3||!T||!T.length)continue;
      for(var ii=C.length-3;ii<=C.length-2;ii++){
        if(ii<0)continue;
        var crt=C[ii],inner=C[ii+1];
        if(!crt||!inner)continue;
        var crtRange=crt.h-crt.l;
        if(crtRange<=0)continue;
        // BULLISH: inner must have swept CRT low (wick below) AND closed back above it
        // Close can be anywhere above CRT low — doesn't need to be below CRT high
        if(inner.l<crt.l&&inner.c>crt.l){
          var tbos=T.filter(function(x){return x.t>inner.t;});
          if(tbos.length){
            // Sweep already happened on inner candle itself — now look for TBOS
            // TBOS level = CRT high (the swing high before the sweep)
            var tbosLvl=crt.h;
            // Check if any TBOS candle before inner had a higher high
            var preInner=T.filter(function(x){return x.t>crt.t&&x.t<=inner.t;});
            preInner.forEach(function(x){if(x.h>tbosLvl)tbosLvl=x.h;});
            var tbosC=null,tbosAge=null,invalidated=false;
            var purges=1; // inner candle itself is the first purge
            // Count additional purges on TBOS TF after inner
            var lastPurgeIdx=-1;
            for(var j=0;j<tbos.length;j++){
              var c=tbos[j];
              if(c.c<crt.l){invalidated=true;break;} // closed below CRT low = invalid
              if(c.l<crt.l){purges++;lastPurgeIdx=j;} // additional purge
              if(c.c>tbosLvl&&!tbosC){tbosC=c;tbosAge=tbos.length-1-j;}
            }
            if(!invalidated){
              var last=tbos[tbos.length-1];
              var sweepingNow=!tbosC&&last.l<crt.l&&last.c>=crt.l;
              var tbosForming=!tbosC&&!sweepingNow&&last.c>tbosLvl;
              if(tbosC||sweepingNow||tbosForming){
                if(!tbosC||(tbosAge<=3)){
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
                    innerClose:inner.c,innerDate:inner.date,sweepLow:inner.l,
                    tbosLevel:tbosLvl,
                    tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
                    tbosAge:tbosC?tbosAge:-1,purgeCount:purges,
                    entryTFs:m.entryTFs,baseConfidence:conf,
                    sweepingNow:sweepingNow,tbosForming:tbosForming,
                  });
                }
              }
            }
          }
        }
        // BEARISH: inner swept CRT high (wick above) AND closed back below it
        if(inner.h>crt.h&&inner.c<crt.h){
          var tbos=T.filter(function(x){return x.t>inner.t;});
          if(tbos.length){
            var tbosLvl=crt.l;
            var preInner=T.filter(function(x){return x.t>crt.t&&x.t<=inner.t;});
            preInner.forEach(function(x){if(x.l<tbosLvl)tbosLvl=x.l;});
            var tbosC=null,tbosAge=null,invalidated=false;
            var purges=1;
            for(var j=0;j<tbos.length;j++){
              var c=tbos[j];
              if(c.c>crt.h){invalidated=true;break;}
              if(c.h>crt.h){purges++;}
              if(c.c<tbosLvl&&!tbosC){tbosC=c;tbosAge=tbos.length-1-j;}
            }
            if(!invalidated){
              var last=tbos[tbos.length-1];
              var sweepingNow=!tbosC&&last.h>crt.h&&last.c<=crt.h;
              var tbosForming=!tbosC&&!sweepingNow&&last.c<tbosLvl;
              if((tbosC&&tbosAge<=3)||sweepingNow||tbosForming){
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
                  model:m.label,direction:'SHORT',
                  crtHigh:crt.h,crtLow:crt.l,crtDate:crt.date,
                  innerClose:inner.c,innerDate:inner.date,sweepHigh:inner.h,
                  tbosLevel:tbosLvl,
                  tbosDate:tbosC?tbosC.date:(tbosForming?'Forming now':(sweepingNow?'Sweep forming':null)),
                  tbosAge:tbosC?tbosAge:-1,purgeCount:purges,
                  entryTFs:m.entryTFs,baseConfidence:conf,
                  sweepingNow:sweepingNow,tbosForming:tbosForming,
                });
              }
            }
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