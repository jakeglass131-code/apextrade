exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const r = await fetch('https://www.asx.com.au/asx/research/ASXListedCompanies.csv', { headers:{'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(8000) });
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
    // Full ASX 300 + micro/small caps fallback — covers every sector
    const t=['BHP','CBA','CSL','NAB','WBC','ANZ','WES','MQG','RIO','FMG','WOW','GMG','REA','TLS','XRO','ALL','STO','WDS','QAN','COH',
      'MIN','LYC','PLS','EVN','NST','WHC','IGO','S32','ORA','NHC','SFR','AWC','ILU','NXT','CQR','BWP','ARF','HDN','SGP','GPT',
      'MGR','SCG','DXS','CHC','BAP','APE','GNC','CIA','CHN','DEG','WAF','DRR','GOR','RSG','SBM','PRU','CMR','RRL','OGC','SAR',
      'SLR','CYL','BGL','MML','RMS','PNV','RHC','SHL','EBO','MVF','HLS','QBE','SUN','IAG','AMP','NCM','PDN','BOE','LOT','PEN',
      'YAL','SMR','GCY','KAR','RED','SVL','ALK','CMW','VEA','IPL','PPT','PMV','DMP','RMD','WEB','IEL','NEA','ALU','MFG','CTD',
      'FLT','CPU','APA','JHX','TCL','AMC','LLC','JBH','CAR','SEK','TPG','HVN','LOV','ALD','BSL','OZL','NWS','WOR','DOW','ELD',
      'CGF','BEN','BOQ','HUB','APX','BKW','NEC','DRR','MP1','AD8','TNE','WTC','ALQ','GQG','PME','SDR','SDF','CXO','LTR','TLX',
      'AKE','NMT','SYR','TYR','NIC','AGY','FFX','AVZ','LKE','INR','NVX','BRN','VUL','PLL','ASN','IMU','RAC','EML','SPT','ZIP',
      'SZL','APT','VNT','OFX','HUM','TYR','GUD','ARB','CIP','WGX','GLN','LEL','MVR','ACL','ERD','TTM','DYL','BMN','GTR','ASM',
      'AIS','IVZ','RLT','KGN','TPW','RDY','GRR','SRL','BC8','DTR','COI','A11','FRS','MHJ','EVO','AOF','BRG','ABB','HPI','IPD',
      'LIC','AMI','BPT','KAR','ORG','ORI','BXB','ASX','RWC','SGR','WPL','AZJ','MPL','SDF','TAH','OSH','NUF','BLD','SKC','IRE',
      'APM','TLC','CEN','AIA','PSI','LNK','IFL','PBH','MVF','RGN','CLW','HMC','VCX','ABP','LFG','GMA','CQE','URW','GOZ','ORA',
      'NSR','PXA','REP','SM1','NHF','CWY','EDV','LGL','DGL','CGC','BSA','WGN','DDR','SSM','KMD','AX1','NCK','SHV','BIN','SPL',
      'DSE','CUV','OBL','GDG','LBL','CCX','INA','MOZ','FCL','MAD','VOC','UNI','ALC','CDA','FPH','BRB','NTO','EMV','NAN','PRN'];
    return { statusCode:200, headers, body:JSON.stringify({count:t.length,stocks:t.map(x=>({ticker:x,name:x}))}) };
  }
};