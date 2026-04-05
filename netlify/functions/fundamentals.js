// fundamentals.js — Netlify serverless function
// Fetches ASX stock fundamentals from Yahoo Finance and scores them for value
// Handles Yahoo's cookie/crumb auth properly in Node.js environment

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

let cachedCrumb = null;
let cachedCookies = '';

async function getYahooCrumb() {
  if (cachedCrumb) return { crumb: cachedCrumb, cookies: cachedCookies };
  
  // Fetch Yahoo Finance homepage to get session cookies
  const homeRes = await fetch('https://finance.yahoo.com', { headers: HEADERS });
  const setCookie = homeRes.headers.get('set-cookie') || '';
  cachedCookies = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
  
  // Get crumb
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...HEADERS, 'Cookie': cachedCookies }
  });
  cachedCrumb = await crumbRes.text();
  return { crumb: cachedCrumb, cookies: cachedCookies };
}

async function fetchFundamentals(tickers) {
  const { crumb, cookies } = await getYahooCrumb();
  
  // Yahoo v10 quoteSummary — batch isn't supported, must do one at a time
  // Use v7 quote which supports batching
  const syms = tickers.map(t => t.includes('.AX') ? t : t + '.AX').join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&crumb=${encodeURIComponent(crumb)}`;
  
  const res = await fetch(url, {
    headers: { ...HEADERS, 'Cookie': cookies }
  });
  
  if (!res.ok) throw new Error(`Yahoo v7 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.quoteResponse?.result || [];
}

// Value scoring algorithm — Piotroski-inspired + quantitative value
function scoreStock(quote) {
  let score = 0;
  const signals = [];
  const warnings = [];
  
  const pe  = quote.trailingPE;
  const fpe = quote.forwardPE;
  const pb  = quote.priceToBook;
  const ps  = quote.priceToSalesTrailingTwelveMonths;
  const eps = quote.epsTrailingTwelveMonths;
  const epsGrowth = (fpe && pe) ? ((pe / fpe) - 1) : null;
  const divYield = quote.dividendYield;
  const mktCap = quote.marketCap;
  const vol = quote.regularMarketVolume;
  const avgVol = quote.averageVolume;
  const price = quote.regularMarketPrice;
  const w52h = quote.fiftyTwoWeekHigh;
  const w52l = quote.fiftyTwoWeekLow;
  const w52pos = w52h && w52l ? (price - w52l) / (w52h - w52l) : null;
  
  // ── Value metrics ──
  if (pe !== undefined && pe > 0 && pe < 15) { score += 20; signals.push(`Low P/E ${pe.toFixed(1)}`); }
  else if (pe > 0 && pe < 25) { score += 10; signals.push(`Fair P/E ${pe.toFixed(1)}`); }
  else if (pe > 40) { score -= 10; warnings.push(`High P/E ${pe.toFixed(1)}`); }
  
  if (pb !== undefined && pb > 0 && pb < 1.5) { score += 20; signals.push(`Below book P/B ${pb.toFixed(2)}`); }
  else if (pb > 0 && pb < 3) { score += 10; signals.push(`Fair P/B ${pb.toFixed(2)}`); }
  else if (pb > 5) { score -= 5; warnings.push(`High P/B ${pb.toFixed(2)}`); }
  
  // ── Growth ──
  if (epsGrowth !== null && epsGrowth > 0.15) { score += 15; signals.push(`EPS growth ${(epsGrowth*100).toFixed(0)}%`); }
  else if (epsGrowth < -0.1) { score -= 10; warnings.push('EPS declining'); }
  
  // ── Dividend yield ──
  if (divYield && divYield > 0.04) { score += 15; signals.push(`Div yield ${(divYield*100).toFixed(1)}%`); }
  else if (divYield && divYield > 0.02) { score += 7; signals.push(`Div ${(divYield*100).toFixed(1)}%`); }
  
  // ── 52-week position (contrarian value) ──
  if (w52pos !== null && w52pos < 0.3) { score += 10; signals.push(`Near 52w low (${(w52pos*100).toFixed(0)}%)`); }
  else if (w52pos !== null && w52pos > 0.9) { score -= 5; warnings.push('Near 52w high'); }
  
  // ── Volume (institutional interest) ──
  if (vol && avgVol && vol > avgVol * 1.5) { score += 5; signals.push('Above-avg volume'); }
  
  // ── EPS positive ──
  if (eps && eps > 0) { score += 10; signals.push('Profitable'); }
  else if (eps !== undefined && eps < 0) { score -= 15; warnings.push('Loss-making'); }
  
  // ── Market cap filter (prefer mid-large) ──
  if (mktCap && mktCap > 1e9) { score += 5; } // $1B+
  
  // Grade
  const grade = score >= 60 ? 'A+' : score >= 45 ? 'A' : score >= 30 ? 'B' : score >= 15 ? 'C' : 'D';
  
  return {
    ticker: quote.symbol,
    name: quote.shortName || quote.longName || quote.symbol,
    price: price,
    change: quote.regularMarketChangePercent,
    marketCap: mktCap,
    pe: pe, forwardPE: fpe, pb: pb, divYield: divYield,
    eps: eps, epsGrowth: epsGrowth,
    w52High: w52h, w52Low: w52l, w52Pos: w52pos,
    volume: vol, avgVolume: avgVol,
    score, grade, signals, warnings,
    sector: quote.sector || 'Unknown',
    industry: quote.industry || '',
    lastUpdated: new Date().toISOString(),
  };
}

// In-memory cache (lasts for life of function instance)
let cache = { results: [], lastRun: null, running: false };

exports.handler = async function(event) {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300', // 5 min browser cache
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  
  const params = event.queryStringParameters || {};
  const action = params.action || 'get';
  const limit  = parseInt(params.limit || '50');
  
  // Return cached results if fresh (< 6 hours old)
  if (action === 'get') {
    if (cache.lastRun && (Date.now() - cache.lastRun) < 6 * 3600 * 1000 && cache.results.length > 0) {
      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({
          status: 'cached',
          lastRun: new Date(cache.lastRun).toISOString(),
          count: cache.results.length,
          results: cache.results.slice(0, limit),
          running: cache.running,
        })
      };
    }
    // No cache — trigger a scan of top ASX stocks
    action === 'get' && !cache.running && triggerScan().catch(console.error);
    return {
      statusCode: 200, headers: H,
      body: JSON.stringify({
        status: cache.running ? 'scanning' : 'stale',
        lastRun: cache.lastRun ? new Date(cache.lastRun).toISOString() : null,
        count: cache.results.length,
        results: cache.results.slice(0, limit),
        running: cache.running,
      })
    };
  }
  
  // action=scan — force a fresh scan
  if (action === 'scan') {
    if (!cache.running) triggerScan().catch(console.error);
    return { statusCode: 202, headers: H, body: JSON.stringify({ status: 'scan_started', running: true }) };
  }
  
  // action=batch — scan specific tickers (POST)
  if (action === 'batch' && event.httpMethod === 'POST') {
    try {
      const { tickers } = JSON.parse(event.body || '{}');
      if (!tickers || !tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };
      const quotes = await fetchFundamentals(tickers.slice(0, 20));
      const scored = quotes.map(scoreStock).sort((a, b) => b.score - a.score);
      return { statusCode: 200, headers: H, body: JSON.stringify({ results: scored }) };
    } catch (e) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
    }
  }
  
  return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Unknown action' }) };
};

// Top 200 ASX stocks by market cap (well-known tickers)
const ASX_TOP_200 = [
  'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX','ANZ.AX','WES.AX','MQG.AX','RIO.AX','WOW.AX',
  'FMG.AX','GMG.AX','TLS.AX','WDS.AX','ALL.AX','COL.AX','TCL.AX','SHL.AX','REA.AX','JBH.AX',
  'IAG.AX','QBE.AX','STO.AX','ORG.AX','APA.AX','MPL.AX','RMD.AX','BXB.AX','ASX.AX','AZJ.AX',
  'TWE.AX','NST.AX','EVN.AX','NHC.AX','WHC.AX','MIN.AX','LTR.AX','PLS.AX','S32.AX','OZL.AX',
  'NXT.AX','ALX.AX','ALD.AX','SUN.AX','HVN.AX','MFT.AX','DXS.AX','GPT.AX','ABP.AX','SCG.AX',
  'VCX.AX','CQR.AX','AGL.AX','AMP.AX','MTS.AX','PPT.AX','PNI.AX','CLW.AX','IRE.AX','WHC.AX',
  'CHC.AX','GQG.AX','360.AX','PME.AX','LNW.AX','XRO.AX','CAR.AX','SEK.AX','CPU.AX','OFX.AX',
  'APX.AX','WTC.AX','ALU.AX','TNE.AX','TYR.AX','PDN.AX','BOQ.AX','BEN.AX','ANN.AX','COH.AX',
  'NVX.AX','PYC.AX','MYX.AX','IMU.AX','PRN.AX','NAN.AX','IMM.AX','IDX.AX','OPT.AX','SDR.AX',
  'DTC.AX','LME.AX','HLS.AX','VHT.AX','AVH.AX','MNB.AX','PNV.AX','SOM.AX','OSH.AX','SGM.AX',
  'NIC.AX','IGO.AX','ORI.AX','IPL.AX','AMC.AX','BLD.AX','ABC.AX','CSR.AX','JHX.AX','RWC.AX',
  'MGR.AX','LGL.AX','GDF.AX','NSR.AX','BWP.AX','ARF.AX','CIP.AX','HDN.AX','ANI.AX','HMC.AX',
  'VRT.AX','RHC.AX','HPI.AX','MVF.AX','AHY.AX','CAJ.AX','EBO.AX','HSN.AX','PTM.AX','MFG.AX',
  'HUB.AX','NWL.AX','GQG.AX','SPK.AX','DTL.AX','RPM.AX','ARB.AX','BAP.AX','ELD.AX','GWA.AX',
  'STO.AX','KAR.AX','VEA.AX','AUB.AX','SPT.AX','PMV.AX','LOV.AX','SWP.AX','BWX.AX','SSM.AX',
  'CAT.AX','HRL.AX','GEM.AX','CWP.AX','KMD.AX','NBI.AX','MCR.AX','AVJ.AX','IRI.AX','MTO.AX',
  'AIA.AX','IPH.AX','PGH.AX','IRE.AX','CLQ.AX','NWH.AX','MMA.AX','DGL.AX','ACL.AX','MCY.AX',
  'OML.AX','REH.AX','FLT.AX','CNU.AX','WEB.AX','CTD.AX','EXP.AX','HLO.AX','AX1.AX','UNI.AX',
  'ALQ.AX','IGO.AX','EMR.AX','DTR.AX','SFR.AX','OBL.AX','LYC.AX','ILU.AX','SBM.AX','RSG.AX',
  'DEG.AX','RMS.AX','WAF.AX','GOR.AX','SKN.AX','NEM.AX','OGC.AX','SLR.AX','SAR.AX','RRL.AX',
];

async function triggerScan() {
  if (cache.running) return;
  cache.running = true;
  const results = [];
  
  // Scan in batches of 20
  for (let i = 0; i < ASX_TOP_200.length; i += 20) {
    const batch = ASX_TOP_200.slice(i, i + 20);
    try {
      const quotes = await fetchFundamentals(batch);
      quotes.forEach(q => {
        const scored = scoreStock(q);
        if (scored.score > 0) results.push(scored);
      });
      if (i + 20 < ASX_TOP_200.length) {
        await new Promise(r => setTimeout(r, 500)); // rate limit
      }
    } catch (e) {
      console.error('Batch error:', e.message);
    }
  }
  
  results.sort((a, b) => b.score - a.score);
  cache.results  = results;
  cache.lastRun  = Date.now();
  cache.running  = false;
  console.log(`Fundamentals scan complete: ${results.length} stocks scored`);
}
