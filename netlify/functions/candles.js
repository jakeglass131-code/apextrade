exports.handler = async (event) => {
  const H = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:H,body:''};
  const {ticker,interval,range} = event.queryStringParameters||{};
  if(!ticker)return{statusCode:400,headers:H,body:JSON.stringify({error:'ticker required'})};
  const sym = ticker.includes('.')?ticker:ticker+'.AX';
  const iv = interval||'1d';
  const rg = range||'2y';
  try{
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+iv+'&range='+rg,{headers:{'User-Agent':'Mozilla/5.0'}});
    if(!r.ok)throw new Error('Yahoo '+r.status);
    const d = await r.json();
    const res = d.chart&&d.chart.result&&d.chart.result[0];
    if(!res)throw new Error('no data');
    const ts=res.timestamp||[],q=res.indicators&&res.indicators.quote&&res.indicators.quote[0]||{};
    const candles=ts.map((t,i)=>({t:t*1000,date:new Date(t*1000).toISOString().slice(0,10),o:q.open&&q.open[i],h:q.high&&q.high[i],l:q.low&&q.low[i],c:q.close&&q.close[i],v:q.volume&&q.volume[i]||0})).filter(c=>c.o!=null&&c.c!=null);
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,interval:iv,range:rg,count:candles.length,candles})};
  }catch(e){
    return{statusCode:200,headers:H,body:JSON.stringify({ticker,error:e.message,candles:[]})};
  }
};