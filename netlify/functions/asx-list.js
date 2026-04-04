exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const r = await fetch('https://www.asx.com.au/asx/research/ASXListedCompanies.csv', { headers:{'User-Agent':'Mozilla/5.0'} });
    if (!r.ok) throw new Error('fail');
    const csv = await r.text();
    const lines = csv.split('\n').slice(3);
    const stocks = [];
    for (const line of lines) {
      const p = line.split(',');
      const t = p[1]?.trim().replace(/"/g,''), n = p[0]?.trim().replace(/"/g,'');
      if (t && /^[A-Z0-9]{2,6}$/.test(t)) stocks.push({ticker:t,name:n});
    }
    return { statusCode:200, headers, body:JSON.stringify({count:stocks.length,stocks}) };
  } catch(e) {
    const t=['BHP','CBA','CSL','NAB','WBC','ANZ','WES','MQG','RIO','FMG','WOW','GMG','REA','TLS','XRO','ALL','STO','WDS','QAN','COH','MIN','LYC','PLS','EVN','NST','WHC','IGO','S32','ORA','NHC','SFR','AWC','ILU','NXT','CQR','BWP','ARF','HDN','SGP','GPT','MGR','SCG','DXS','CHC','BAP','APE','GNC','CIA','CHN','DEG','WAF','DRR','GOR','RSG','SBM','PRU','CMR','RRL','OGC','SAR','SLR','CYL','BGL','MML','RMS','PNV','RHC','SHL','EBO','MVF','HLS','QBE','SUN','IAG','AMP','NCM','PDN','BOE','LOT','PEN','YAL','SMR','GCY','KAR','RED','SVL','ALK','CMW','VEA','IPL','PPT','PMV','DMP','RMD','WEB','IEL','NEA','ALU','MFG','CTD','FLT','CPU','APA','JHX','TCL','AMC','LLC'];
    return { statusCode:200, headers, body:JSON.stringify({count:t.length,stocks:t.map(x=>({ticker:x,name:x}))}) };
  }
};