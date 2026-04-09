// Yahoo Finance ASX candle proxy — with TV cache priority
const CACHE_URL = process.env.URL ? process.env.URL + '/.netlify/functions/cache' : 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';

exports.handler = async (event) => {
  const H = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json','Cache-Control':'public, max-age=30'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:H,body:''};
  const {ticker,interval,range} = event.queryStringParameters||{};
  
  // Batch mode: ?tickers=BHP,CBA,CSL — fetch multiple tickers in one call
  if((event.queryStringParameters||{}).tickers){
    const tickers=(event.queryStringParameters.tickers||'').split(',').map(t=>t.trim()).filter(Boolean).slice(0,30);
    const results={};
    await Promise.all(tickers.map(async t=>{
      const sym=t.startsWith('^')?t:t.includes('.')||t.includes('=')||t.includes('-')?t:t+'.AX';
      const iv=interval||'1d';const rg=range||'2y';
      try{
        const r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+iv+'&range='+rg,{headers:{'User-Agent':'Mozilla/5.0'}});
        if(!r.ok)return;const d=await r.json();
        const res=d.chart&&d.chart.result&&d.chart.result[0];if(!res)return;
        const ts=res.timestamp||[],q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
        results[t]=ts.map((tm,i)=>({t:tm*1000,date:new Date(tm*1000).toLocaleDateString('en-CA',{timeZone:'Australia/Sydney'}),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i],v:q.volume&&q.volume[i]||0})).filter(c=>c.o!=null&&c.c!=null);
      }catch(e){}
    }));
    return{statusCode:200,headers:H,body:JSON.stringify(results)};
  }

  if(!ticker)return{statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};

  // Step 1: Try TV cache
  try {
    const cr = await fetch(CACHE_URL + '?ticker=' + encodeURIComponent(ticker));
    if (cr.ok) {
      const cd = await cr.json();
      if(cd.hit && !cd.stale && cd.candles && cd.candles.length >= 20) {
        return{statusCode:200,headers:H,body:JSON.stringify({ticker,interval:interval||'1d',range:range||'2y',count:cd.candles.length,candles:cd.candles,source:'tradingview'})};
      }
    }
  } catch(e){}

  // Step 2: Fall back to Yahoo
  const sym = ticker.startsWith('^')?ticker:ticker.includes('.')||ticker.includes('=')||ticker.includes('-')?ticker:ticker+'.AX';
  const iv = interval||'1d';
  const rg = range||'2y';
  try{
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+iv+'&range='+rg,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status);
    const d = await r.json();
    const res = d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    const ts=res.timestamp||[],q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
    const candles=ts.map((t,i)=>({t:t*1000,date:new Date(t*1000).toLocaleDateString('en-CA',{timeZone:'Australia/Sydney'}),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i],v:q.volume&&q.volume[i]||0})).filter(c=>c.o!=null&&c.c!=null);
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,interval:iv,range:rg,count:candles.length,candles,source:'yahoo'})};
  }catch(e){
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,error:e.message,candles:[]})};
  }
};
