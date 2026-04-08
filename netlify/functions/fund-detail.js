// fund-detail.js — Yahoo Finance quoteSummary proxy for fundamental data
// Returns P/E, P/B, ROE, dividend yield, EPS, balance sheet, sector info
// Usage: GET ?ticker=BHP.AX or POST { tickers: ["BHP.AX","CBA.AX"] } (max 5)

const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=3600',
};

const MODULES = [
  'financialData',
  'defaultKeyStatistics',
  'summaryDetail',
  'earningsTrend',
  'balanceSheetHistory',
  'incomeStatementHistory',
  'cashflowStatementHistory',
  'assetProfile',
  'price',
  'calendarEvents',
  'upgradeDowngradeHistory',
].join(',');

// Simple in-memory cache (survives within a single Lambda instance)
const cache = {};
const CACHE_TTL = 3600000; // 1 hour

// Yahoo Finance now requires a crumb+cookie for v10 endpoints
let yfSession = { crumb: null, cookie: null, ts: 0 };
const SESSION_TTL = 3600000;

async function ensureYfSession() {
  if (yfSession.crumb && Date.now() - yfSession.ts < SESSION_TTL) return yfSession;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  try {
    // Step 1: Get consent cookie from Yahoo
    const homeR = await fetch('https://fc.yahoo.com/v', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
    let cookies = [];
    if (typeof homeR.headers.getSetCookie === 'function') cookies = homeR.headers.getSetCookie();
    else { const raw = homeR.headers.get('set-cookie'); if (raw) cookies = raw.split(/,(?=[^ ;]+?=)/); }
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    // Step 2: Get crumb
    const crumbR = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookieStr },
      signal: AbortSignal.timeout(6000)
    });
    const crumb = await crumbR.text();
    if (crumb && crumb.length < 50 && !crumb.includes('<')) {
      yfSession = { crumb, cookie: cookieStr, ts: Date.now() };
      return yfSession;
    }
  } catch (e) { /* fall through */ }
  return { crumb: null, cookie: null, ts: 0 };
}

// ── Date estimation helpers ──
function nextQuarterEnd() {
  // ASX quarters end Mar 31, Jun 30, Sep 30, Dec 31
  // Appendix 5B due ~1 month after quarter end
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const qEnds = [new Date(y,2,31), new Date(y,5,30), new Date(y,8,30), new Date(y,11,31),
                  new Date(y+1,2,31)];
  // Due date = quarter end + ~31 days
  for (const qe of qEnds) {
    const due = new Date(qe.getTime() + 31*86400000);
    if (due > now) return { qEnd: qe.toISOString().slice(0,10), due: due.toISOString().slice(0,10) };
  }
  return null;
}

function nextEarningsSeason(isBankFY) {
  // Most ASX companies: Jun FY → half-year results Feb, full-year results Aug
  // Banks/some: Dec HY → half-year results Feb, full-year results Aug (similar)
  const now = new Date();
  const y = now.getFullYear();
  // Reporting windows: mid-Feb and mid-Aug
  const windows = [
    { d: new Date(y,1,15), label: 'H1 Results Season' },
    { d: new Date(y,7,15), label: 'FY Results Season' },
    { d: new Date(y+1,1,15), label: 'H1 Results Season' },
  ];
  for (const w of windows) {
    // Reporting season spans ~4 weeks from this date
    const end = new Date(w.d.getTime() + 28*86400000);
    if (end > now) return { date: w.d.toISOString().slice(0,10), end: end.toISOString().slice(0,10), label: w.label };
  }
  return null;
}

function nextRBADates() {
  // 2026 RBA meeting dates (announced by RBA)
  const dates = ['2026-02-18','2026-04-01','2026-05-20','2026-07-08','2026-08-19','2026-10-07','2026-11-25','2026-12-09',
                 '2027-02-02','2027-03-17','2027-05-05','2027-06-30'];
  const now = new Date().toISOString().slice(0,10);
  const upcoming = dates.filter(d => d >= now);
  return upcoming.slice(0, 2); // next 2
}

function estimateCapitalRaise(cashRunwayMonths) {
  if (!cashRunwayMonths) return null;
  // Companies typically raise ~3-6 months before running out
  const raiseInMonths = Math.max(1, cashRunwayMonths - 3);
  const est = new Date();
  est.setMonth(est.getMonth() + raiseInMonths);
  return est.toISOString().slice(0,10);
}

// Infer likely upcoming catalysts with estimated dates and value-unlock scenarios
function inferCatalysts(sector, industry, desc, flags) {
  const s = (sector || '').toLowerCase();
  const i = (industry || '').toLowerCase();
  const d = (desc || '').toLowerCase();
  const cats = [];
  const nq = nextQuarterEnd();
  const ne = nextEarningsSeason();
  const mc = flags.marketCap || 0;
  const shares = flags.sharesOutstanding || 0;
  const sp = flags.price || 0;

  // Helper: compute implied SP from a target MC
  const impliedSP = (targetMC) => shares > 0 ? targetMC / shares : null;
  // Helper: format a currency value compactly
  const fmtV = (v) => !v ? null : v >= 1e9 ? '$'+(v/1e9).toFixed(1)+'B' : v >= 1e6 ? '$'+(v/1e6).toFixed(0)+'M' : '$'+(v/1e3).toFixed(0)+'K';
  const fmtSP = (v) => !v ? null : '$' + (v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4));

  // Mining / Resources
  const isMining = s.includes('basic material') || i.includes('mining') || i.includes('gold') || i.includes('metal') ||
      i.includes('copper') || i.includes('iron') || i.includes('coal') || i.includes('silver') ||
      d.includes('exploration') || d.includes('mining') || d.includes('drill') || d.includes('mineral');
  if (isMining) {
    const reRateMC = mc * 2.5; // Resource upgrade typically 2-3x for explorers
    cats.push({ type: 'Drill Results', icon: '⛏', desc: 'Assay results from current drilling programs', est: 'Ongoing — results released as received from lab', timing: 'ongoing',
      unlock: 'High-grade hits can re-rate MC 50-200%', unlockMC: reRateMC, unlockSP: impliedSP(reRateMC) });
    cats.push({ type: 'Resource Estimate', icon: '📐', desc: 'Updated JORC resource / reserve estimates', est: 'Typically post drill campaign — check ASX announcements', timing: 'variable',
      unlock: 'JORC upgrade de-risks the asset → attracts institutional capital', unlockMC: mc * 3, unlockSP: impliedSP(mc * 3) });
    if (d.includes('feasibility') || d.includes('study') || d.includes('scoping'))
      cats.push({ type: 'Feasibility Study', icon: '📊', desc: 'DFS/PFS/Scoping study results', est: '6-18 months from announcement of study commencement', timing: 'variable',
        unlock: 'Positive DFS signals path to production → unlocks project financing', unlockMC: mc * 2, unlockSP: impliedSP(mc * 2) });
    if (d.includes('production') || d.includes('processing') || d.includes('plant'))
      cats.push({ type: 'Production Update', icon: '🏭', desc: 'Quarterly production & cost report', est: nq ? 'Due by ' + nq.due : 'Next quarter end + 1 month', timing: 'quarterly', date: nq ? nq.due : null });
    cats.push({ type: 'Commodity Price', icon: '📈', desc: 'Underlying commodity price movements', est: 'Continuous — macro-driven', timing: 'ongoing' });
  }

  // Lithium / Battery / Rare Earths
  const isLithium = i.includes('lithium') || i.includes('rare earth') || d.includes('lithium') || d.includes('battery') ||
      d.includes('rare earth') || d.includes('graphite') || d.includes('cobalt') || d.includes('nickel');
  if (isLithium) {
    cats.push({ type: 'Offtake Agreement', icon: '🤝', desc: 'Binding offtake or supply agreements with EV/battery makers', est: 'Typically announced post-DFS or during construction phase', timing: 'variable',
      unlock: 'Binding offtake de-risks revenue → unlocks project debt financing', unlockMC: mc * 2, unlockSP: impliedSP(mc * 2) });
    cats.push({ type: 'EV Demand Data', icon: '🔋', desc: 'Global EV sales data impacting lithium/battery demand', est: 'Monthly — China EV sales released ~10th of each month', timing: 'monthly' });
  }

  // Oil & Gas
  if (i.includes('oil') || i.includes('gas') || i.includes('petroleum') || i.includes('energy') ||
      d.includes('oil') || d.includes('petroleum') || d.includes('natural gas')) {
    cats.push({ type: 'Well Results', icon: '🛢', desc: 'Exploration well results & flow rates', est: 'Released upon completion — check current drilling schedule', timing: 'ongoing',
      unlock: 'Commercial flow rates → booking reserves → production pathway', unlockMC: mc * 3, unlockSP: impliedSP(mc * 3) });
    cats.push({ type: 'Oil/Gas Price', icon: '⛽', desc: 'Brent/WTI crude & LNG price movements', est: 'Continuous — OPEC meetings quarterly', timing: 'ongoing' });
    cats.push({ type: 'Production Report', icon: '📋', desc: 'Quarterly production & reserves update', est: nq ? 'Due by ' + nq.due : 'Next quarter end + 1 month', timing: 'quarterly', date: nq ? nq.due : null });
  }

  // Biotech / Pharma / Healthcare
  const isBiotech = s.includes('healthcare') || i.includes('biotech') || i.includes('pharma') || i.includes('drug') ||
      i.includes('medical') || i.includes('diagnostic') || d.includes('clinical') || d.includes('fda') ||
      d.includes('therapeutic') || d.includes('trial') || d.includes('regulatory');
  if (isBiotech) {
    cats.push({ type: 'Clinical Trial Results', icon: '🧬', desc: 'Phase I/II/III trial data readouts', est: 'Check company pipeline — data typically at medical conferences (ASCO Jun, ASH Dec, AACR Apr)', timing: 'variable',
      unlock: 'Positive Phase II/III → opens path to registration & commercialisation', unlockMC: mc * 3, unlockSP: impliedSP(mc * 3) });
    cats.push({ type: 'FDA/TGA Approval', icon: '✅', desc: 'Regulatory approval or submission milestones', est: 'FDA PDUFA dates published — TGA timelines 6-12 months from submission', timing: 'variable',
      unlock: 'Approval unlocks commercial sales → peak revenue multiples apply', unlockMC: mc * 5, unlockSP: impliedSP(mc * 5) });
    cats.push({ type: 'Partnership Deal', icon: '🤝', desc: 'Licensing, collaboration or distribution agreements', est: 'Often announced at JP Morgan Healthcare Conference (Jan) or ASCO (Jun)', timing: 'variable',
      unlock: 'Big pharma deal validates asset + upfront cash + milestone payments', unlockMC: mc * 2, unlockSP: impliedSP(mc * 2) });
    if (d.includes('device') || d.includes('implant'))
      cats.push({ type: 'Device Approval', icon: '🏥', desc: 'Medical device regulatory clearance (FDA 510k/CE Mark)', est: 'FDA 510k ~3-6 months from submission, PMA ~12 months', timing: 'variable',
        unlock: 'Clearance unlocks US market sales to hospitals & clinics', unlockMC: mc * 2.5, unlockSP: impliedSP(mc * 2.5) });
  }

  // Technology / Software
  const isTech = s.includes('technology') || i.includes('software') || i.includes('saas') || i.includes('internet') ||
      i.includes('cloud') || d.includes('platform') || d.includes('saas') || d.includes('ai ');
  if (isTech) {
    const arrMultiple = mc > 1e9 ? 1.5 : 2; // smaller co gets bigger re-rate from contract wins
    cats.push({ type: 'Contract Win', icon: '📝', desc: 'New enterprise contracts or government deals', est: 'Ongoing — announced as material contracts are signed', timing: 'ongoing',
      unlock: 'Material contract → step change in ARR → SaaS multiple re-rate', unlockMC: mc * arrMultiple, unlockSP: impliedSP(mc * arrMultiple) });
    cats.push({ type: 'ARR/MRR Update', icon: '💰', desc: 'Annual/monthly recurring revenue milestones', est: nq ? 'Quarterly update due ~' + nq.due : 'Quarterly with 4C lodgement', timing: 'quarterly', date: nq ? nq.due : null,
      unlock: 'Accelerating ARR growth → higher EV/Revenue multiple from market' });
    cats.push({ type: 'Product Launch', icon: '🚀', desc: 'New product releases or feature launches', est: 'Check company roadmap — often announced at results or conferences', timing: 'variable',
      unlock: 'New product opens adjacent TAM → cross-sell to existing customers' });
  }

  // Cannabis
  if (i.includes('cannabis') || i.includes('marijuana') || d.includes('cannabis')) {
    cats.push({ type: 'Regulatory Change', icon: '⚖', desc: 'State/federal cannabis regulation updates', est: 'Ongoing — legislative calendar dependent', timing: 'variable',
      unlock: 'Federal rescheduling or new state legalisation → TAM expansion', unlockMC: mc * 3, unlockSP: impliedSP(mc * 3) });
    cats.push({ type: 'License Grant', icon: '📜', desc: 'New cultivation or distribution licenses', est: 'Application-dependent — typically 3-6 month approval process', timing: 'variable',
      unlock: 'New license → expanded production capacity & new market access' });
  }

  // Real Estate / REITs
  if (s.includes('real estate') || i.includes('reit') || d.includes('property') || d.includes('real estate')) {
    cats.push({ type: 'Acquisition', icon: '🏢', desc: 'Property acquisitions or disposals', est: 'Ongoing — announced as transactions settle', timing: 'ongoing',
      unlock: 'Accretive acquisition → higher NTA & distribution per unit' });
    cats.push({ type: 'Occupancy Update', icon: '📊', desc: 'Occupancy rates & rental income updates', est: ne ? ne.label + ' ~' + ne.date : 'With half/full year results', timing: 'half-yearly', date: ne ? ne.date : null,
      unlock: 'Occupancy lift → directly flows to distribution & NAV uplift' });
    cats.push({ type: 'Distribution', icon: '💰', desc: 'Quarterly/half-year distribution announcements', est: ne ? 'With ' + ne.label + ' ~' + ne.date : 'With results', timing: 'half-yearly', date: ne ? ne.date : null });
  }

  // Financial
  if (s.includes('financial') || i.includes('bank') || i.includes('insurance') || i.includes('capital')) {
    const rba = nextRBADates();
    cats.push({ type: 'Rate Decision', icon: '🏦', desc: 'RBA interest rate decision', est: rba.length ? 'Next: ' + rba[0] + (rba[1] ? ', then ' + rba[1] : '') : 'See RBA schedule', timing: 'scheduled', date: rba[0] || null,
      unlock: 'Rate cut → NIM compression but loan demand up. Hold → margins stable' });
    cats.push({ type: 'Loan Book Update', icon: '📈', desc: 'Credit quality & loan growth data', est: ne ? 'With ' + ne.label + ' ~' + ne.date : 'With half/full year results', timing: 'half-yearly', date: ne ? ne.date : null,
      unlock: 'Loan growth + low bad debts → earnings beat → dividend upgrade' });
  }

  // Agriculture
  if (i.includes('agri') || i.includes('farm') || d.includes('agriculture') || d.includes('crop') || d.includes('cattle')) {
    cats.push({ type: 'Harvest Report', icon: '🌾', desc: 'Seasonal crop yield or livestock data', est: 'Seasonal — Australian harvest Oct-Jan, planting Apr-Jun', timing: 'seasonal',
      unlock: 'Bumper harvest + high commodity prices → record revenue year' });
    cats.push({ type: 'Weather Impact', icon: '🌧', desc: 'Drought/flood/weather event impacts on production', est: 'BOM seasonal outlook updated quarterly', timing: 'ongoing' });
  }

  // Universal catalysts
  cats.push({ type: 'Quarterly Report', icon: '📑', desc: 'Appendix 5B quarterly cashflow report', est: nq ? 'Q ending ' + nq.qEnd + ' — due by ' + nq.due : 'Due ~1 month after quarter end', timing: 'quarterly', date: nq ? nq.due : null });

  if (flags.isPreRevenue || flags.isBurningCash) {
    const capDate = estimateCapitalRaise(flags.cashRunwayMonths);
    cats.push({ type: 'Capital Raise', icon: '⚠', desc: 'Potential placement, SPP, or rights issue to fund operations',
      est: flags.cashRunwayMonths ? 'Est ~' + (capDate || 'unknown') + ' (runway ' + flags.cashRunwayMonths + ' months)' : 'Timing depends on cash burn rate — monitor quarterly 5B',
      timing: 'risk', date: capDate,
      unlock: 'Dilution risk — new shares issued at discount. SP typically drops 10-20% on announcement' });
  }

  if (flags.revenue && flags.revenue > 10000000)
    cats.push({ type: 'Earnings Report', icon: '📊', desc: 'Half-year or full-year earnings results', est: ne ? ne.label + ' — ~' + ne.date + ' to ' + ne.end : 'Feb (H1) or Aug (FY) results season', timing: 'half-yearly', date: ne ? ne.date : null,
      unlock: 'Beat → re-rate on upgraded guidance. Miss → sell-off risk' });

  if (flags.dividendYield && flags.dividendYield > 0)
    cats.push({ type: 'Dividend Declaration', icon: '💰', desc: 'Next interim or final dividend announcement', est: ne ? 'With ' + ne.label + ' ~' + ne.date : 'Announced with results — Feb (interim) or Aug (final)', timing: 'half-yearly', date: ne ? ne.date : null,
      unlock: 'Dividend increase → signals confidence, attracts income investors' });

  // Add formatted target values where we have unlock MC/SP
  cats.forEach(c => {
    if (c.unlockMC) c.unlockMCFmt = fmtV(c.unlockMC);
    if (c.unlockSP) c.unlockSPFmt = fmtSP(c.unlockSP);
  });

  // Sort: scheduled dates first, then ongoing, then variable
  const order = { scheduled: 0, quarterly: 1, 'half-yearly': 2, monthly: 3, seasonal: 4, ongoing: 5, variable: 6, risk: 7 };
  cats.sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return (order[a.timing] || 9) - (order[b.timing] || 9);
  });

  return cats.slice(0, 10);
}

async function fetchFundamentals(ticker) {
  const now = Date.now();
  if (cache[ticker] && now - cache[ticker].ts < CACHE_TTL) return cache[ticker].data;

  const sym = ticker.includes('.') ? ticker : ticker + '.AX';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  let lastErr = null;
  // Try: (0) cached crumb, (1) fresh crumb, (2) no crumb at all
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) yfSession = { crumb: null, cookie: null, ts: 0 }; // force refresh

    let session;
    if (attempt < 2) {
      session = await ensureYfSession();
    } else {
      session = { crumb: null, cookie: null, ts: 0 };
    }

    const crumbParam = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
    const base = session.crumb ? 'query2' : 'query1';
    const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${MODULES}${crumbParam}`;

    const hdrs = { 'User-Agent': UA };
    if (session.cookie) hdrs['Cookie'] = session.cookie;

    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
      if (r.status === 401 || r.status === 403) { lastErr = `Yahoo ${r.status}`; continue; }
      if (!r.ok) throw new Error(`Yahoo ${r.status} for ${sym}`);

      const d = await r.json();
      const result = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (!result) throw new Error(`No data for ${sym}`);

  const fd = result.financialData || {};
  const ks = result.defaultKeyStatistics || {};
  const sd = result.summaryDetail || {};
  const et = result.earningsTrend || {};
  const bs = (result.balanceSheetHistory && result.balanceSheetHistory.balanceSheetStatements) || [];
  const is = (result.incomeStatementHistory && result.incomeStatementHistory.incomeStatementHistory) || [];
  const ap = result.assetProfile || {};
  const pr = result.price || {};
  const ce = result.calendarEvents || {};
  const udh = (result.upgradeDowngradeHistory && result.upgradeDowngradeHistory.history) || [];
  const cf = (result.cashflowStatementHistory && result.cashflowStatementHistory.cashflowStatements) || [];

  // Extract raw values (Yahoo wraps numbers in {raw, fmt} objects)
  const raw = (obj) => obj && obj.raw !== undefined ? obj.raw : null;

  // Balance sheet metrics (most recent)
  const latestBS = bs[0] || {};
  const totalAssets = raw(latestBS.totalAssets);
  const totalDebt = raw(latestBS.longTermDebt) || raw(latestBS.totalDebt) || 0;
  const shortTermDebt = raw(latestBS.shortLongTermDebt) || raw(latestBS.shortTermBorrowings) || 0;
  // Cash: try multiple fields — Yahoo is inconsistent
  const totalCash = raw(latestBS.cash) || raw(latestBS.cashAndCashEquivalents) || raw(latestBS.cashAndShortTermInvestments) || raw(fd.totalCash) || 0;
  const totalEquity = raw(latestBS.totalStockholderEquity);
  const currentAssets = raw(latestBS.totalCurrentAssets) || 0;
  const currentLiab = raw(latestBS.totalCurrentLiabilities) || 0;
  const currentRatio = currentLiab > 0 ? currentAssets / currentLiab : null;

  // Income statement
  const latestIS = is[0] || {};
  const revenue = raw(latestIS.totalRevenue);
  const netIncome = raw(latestIS.netIncome);
  const grossProfit = raw(latestIS.grossProfit);

  // Cash flow statement
  const latestCF = cf[0] || {};
  const prevCF = cf[1] || {};
  const operatingCashFlow = raw(latestCF.totalCashFromOperatingActivities);
  const capex = raw(latestCF.capitalExpenditures); // usually negative
  const freeCashFlow = raw(fd.freeCashflow) || (operatingCashFlow != null && capex != null ? operatingCashFlow + capex : null);
  const prevOperatingCF = raw(prevCF.totalCashFromOperatingActivities);

  // Cash burn & runway (for pre-revenue / loss-making companies)
  const isPreRevenue = !revenue || revenue < 1000000; // < $1M revenue
  const isBurningCash = operatingCashFlow != null && operatingCashFlow < 0;
  const quarterlyBurn = isBurningCash ? Math.abs(operatingCashFlow) / 4 : null; // annualized / 4
  const monthlyBurn = isBurningCash ? Math.abs(operatingCashFlow) / 12 : null;
  const cashRunwayMonths = monthlyBurn && totalCash > 0 ? Math.round(totalCash / monthlyBurn) : null;

  // EPS growth from earningsTrend
  let epsGrowth = null;
  if (et.trend && et.trend.length) {
    const current = et.trend.find(t => t.period === '0q' || t.period === '+1q');
    if (current && current.growth) epsGrowth = raw(current.growth);
  }

  // Compute debt-to-equity
  const debtToEquity = totalEquity && totalEquity > 0 ? totalDebt / totalEquity : null;

  // Compute profit margin
  const profitMargin = revenue && revenue > 0 && netIncome ? netIncome / revenue : null;

  // Value score computation
  let valueScore = 0;
  let qualityScore = 0;
  let signals = [];

  // P/E scoring
  const pe = raw(sd.trailingPE);
  if (pe !== null && pe > 0) {
    if (pe < 8) { valueScore += 25; signals.push('Deep value P/E ' + pe.toFixed(1)); }
    else if (pe < 12) { valueScore += 18; signals.push('Low P/E ' + pe.toFixed(1)); }
    else if (pe < 18) { valueScore += 10; }
    else if (pe < 25) { valueScore += 3; }
    else if (pe > 40) { valueScore -= 10; signals.push('High P/E ' + pe.toFixed(1)); }
  }

  // P/B scoring
  const pb = raw(ks.priceToBook);
  if (pb !== null && pb > 0) {
    if (pb < 1.0) { valueScore += 20; signals.push('Below book value P/B ' + pb.toFixed(2)); }
    else if (pb < 1.5) { valueScore += 12; }
    else if (pb < 3.0) { valueScore += 5; }
    else if (pb > 5.0) { valueScore -= 5; }
  }

  // Dividend yield scoring
  const divYield = raw(sd.dividendYield);
  if (divYield !== null && divYield > 0) {
    if (divYield > 0.06) { valueScore += 15; signals.push('High yield ' + (divYield * 100).toFixed(1) + '%'); }
    else if (divYield > 0.04) { valueScore += 10; signals.push('Good yield ' + (divYield * 100).toFixed(1) + '%'); }
    else if (divYield > 0.02) { valueScore += 5; }
  }

  // ROE scoring
  const roe = raw(fd.returnOnEquity);
  if (roe !== null) {
    if (roe > 0.25) { qualityScore += 20; signals.push('Excellent ROE ' + (roe * 100).toFixed(0) + '%'); }
    else if (roe > 0.15) { qualityScore += 14; signals.push('Strong ROE ' + (roe * 100).toFixed(0) + '%'); }
    else if (roe > 0.08) { qualityScore += 7; }
    else if (roe < 0) { qualityScore -= 10; signals.push('Negative ROE'); }
  }

  // EPS growth
  if (epsGrowth !== null) {
    if (epsGrowth > 0.20) { qualityScore += 15; signals.push('Strong EPS growth ' + (epsGrowth * 100).toFixed(0) + '%'); }
    else if (epsGrowth > 0.05) { qualityScore += 8; }
    else if (epsGrowth < -0.10) { qualityScore -= 8; signals.push('EPS declining'); }
  }

  // Debt-to-equity
  if (debtToEquity !== null) {
    if (debtToEquity < 0.3) { qualityScore += 10; signals.push('Low debt D/E ' + debtToEquity.toFixed(2)); }
    else if (debtToEquity < 0.7) { qualityScore += 5; }
    else if (debtToEquity > 1.5) { qualityScore -= 8; signals.push('High debt D/E ' + debtToEquity.toFixed(2)); }
  }

  // Profit margin
  if (profitMargin !== null) {
    if (profitMargin > 0.20) { qualityScore += 10; signals.push('High margin ' + (profitMargin * 100).toFixed(0) + '%'); }
    else if (profitMargin > 0.10) { qualityScore += 5; }
    else if (profitMargin < 0) { qualityScore -= 8; signals.push('Loss-making'); }
  }

  // Cash flow scoring
  if (operatingCashFlow !== null) {
    if (operatingCashFlow > 0) { qualityScore += 8; signals.push('Cash flow positive'); }
    else {
      qualityScore -= 5;
      if (cashRunwayMonths !== null) {
        if (cashRunwayMonths < 6) { qualityScore -= 10; signals.push('⚠ Cash runway < 6 months'); }
        else if (cashRunwayMonths < 12) { qualityScore -= 5; signals.push('Low runway ~' + cashRunwayMonths + ' months'); }
        else { signals.push('Runway ~' + cashRunwayMonths + ' months'); }
      }
    }
  }

  // Pre-revenue penalty/flag
  if (isPreRevenue) { signals.push('Pre-revenue / exploration stage'); }

  const totalScore = valueScore + qualityScore;
  const grade = totalScore >= 60 ? 'A+' : totalScore >= 45 ? 'A' : totalScore >= 30 ? 'B' : totalScore >= 15 ? 'C' : 'D';

  const data = {
    ticker: sym,
    name: pr.shortName || pr.longName || sym,
    sector: ap.sector || 'Unknown',
    industry: ap.industry || 'Unknown',
    price: raw(pr.regularMarketPrice),
    marketCap: raw(sd.marketCap),
    sharesOutstanding: raw(ks.sharesOutstanding),
    enterpriseValue: raw(ks.enterpriseValue),
    // Valuation
    pe: pe,
    forwardPE: raw(ks.forwardPE),
    pb: pb,
    ps: raw(sd.priceToSalesTrailing12Months),
    evToEbitda: raw(ks.enterpriseToEbitda),
    // Returns
    roe: roe,
    roa: raw(fd.returnOnAssets),
    profitMargin: profitMargin,
    // Growth
    epsTrailing: raw(ks.trailingEps),
    epsForward: raw(ks.forwardEps),
    epsGrowth: epsGrowth,
    revenueGrowth: raw(fd.revenueGrowth),
    earningsGrowth: raw(fd.earningsGrowth),
    // Dividends
    dividendYield: divYield,
    dividendRate: raw(sd.dividendRate),
    payoutRatio: raw(sd.payoutRatio),
    // Balance sheet & cash
    totalAssets: totalAssets,
    totalDebt: totalDebt,
    shortTermDebt: shortTermDebt,
    totalCash: totalCash,
    totalEquity: totalEquity,
    debtToEquity: debtToEquity,
    currentRatio: currentRatio,
    revenue: revenue,
    netIncome: netIncome,
    // Cash flow
    operatingCashFlow: operatingCashFlow,
    freeCashFlow: freeCashFlow,
    capex: capex,
    isPreRevenue: isPreRevenue,
    isCashFlowPositive: operatingCashFlow != null ? operatingCashFlow > 0 : null,
    monthlyBurn: monthlyBurn,
    cashRunwayMonths: cashRunwayMonths,
    // Analyst
    targetMeanPrice: raw(fd.targetMeanPrice),
    targetHighPrice: raw(fd.targetHighPrice),
    targetLowPrice: raw(fd.targetLowPrice),
    recommendation: fd.recommendationKey || null,
    numberOfAnalysts: raw(fd.numberOfAnalystOpinions),
    // Catalysts — calendar events
    earningsDate: ce.earnings && ce.earnings.earningsDate && ce.earnings.earningsDate.length
      ? ce.earnings.earningsDate.map(d => raw(d) ? new Date(raw(d) * 1000).toISOString().slice(0, 10) : null).filter(Boolean)
      : [],
    earningsEstimate: ce.earnings ? raw(ce.earnings.earningsAverage) : null,
    revenueEstimate: ce.earnings ? raw(ce.earnings.revenueAverage) : null,
    exDividendDate: raw(ce.exDividendDate) ? new Date(raw(ce.exDividendDate) * 1000).toISOString().slice(0, 10) : null,
    dividendPayDate: raw(ce.dividendDate) ? new Date(raw(ce.dividendDate) * 1000).toISOString().slice(0, 10) : null,
    // Catalysts — recent analyst upgrades/downgrades (last 5)
    analystChanges: udh.slice(0, 5).map(u => ({
      date: u.epochGradeDate ? new Date(u.epochGradeDate * 1000).toISOString().slice(0, 10) : null,
      firm: u.firm || 'Unknown',
      action: u.action || '',
      from: u.fromGrade || '',
      to: u.toGrade || '',
    })),
    // Company profile
    fullTimeEmployees: ap.fullTimeEmployees || null,
    website: ap.website || null,
    longBusinessSummary: ap.longBusinessSummary ? ap.longBusinessSummary.slice(0, 300) : null,
    // Industry-specific upcoming catalysts (inferred from sector/industry)
    likelyCatalysts: inferCatalysts(ap.sector, ap.industry, ap.longBusinessSummary || '', { isPreRevenue, isBurningCash, cashRunwayMonths, revenue, dividendYield: divYield, marketCap: raw(sd.marketCap), sharesOutstanding: raw(ks.sharesOutstanding), price: raw(pr.regularMarketPrice) }),
    // Scores
    valueScore: valueScore,
    qualityScore: qualityScore,
    totalScore: totalScore,
    grade: grade,
    signals: signals.slice(0, 6),
    lastUpdated: new Date().toISOString(),
  };

      cache[ticker] = { data, ts: now };
      return data;
    } catch (e) { lastErr = e.message; continue; }
  }
  throw new Error(lastErr || `Failed to fetch ${sym}`);
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const params = event.queryStringParameters || {};

  // GET mode: single ticker
  if (params.ticker) {
    try {
      const data = await fetchFundamentals(params.ticker);
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    } catch (e) {
      const errH = { ...H, 'Cache-Control': 'no-store' };
      return { statusCode: 200, headers: errH, body: JSON.stringify({ error: e.message, ticker: params.ticker }) };
    }
  }

  // POST mode: batch (max 5)
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const tickers = (body.tickers || []).slice(0, 5);
    if (!tickers.length) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'tickers required' }) };

    const results = [];
    const errors = [];

    for (const ticker of tickers) {
      try {
        results.push(await fetchFundamentals(ticker));
      } catch (e) {
        errors.push({ ticker, error: e.message });
      }
      await new Promise(r => setTimeout(r, 200)); // rate limit pacing
    }

    results.sort((a, b) => b.totalScore - a.totalScore);
    return { statusCode: 200, headers: H, body: JSON.stringify({ results, errors, count: results.length }) };
  }

  return { statusCode: 200, headers: H, body: JSON.stringify({
    status: 'ready',
    usage: 'GET ?ticker=BHP.AX or POST { tickers: ["BHP.AX","CBA.AX"] } (max 5)',
    note: 'Fundamental analysis via Yahoo quoteSummary — P/E, P/B, ROE, dividends, balance sheet',
  })};
};
