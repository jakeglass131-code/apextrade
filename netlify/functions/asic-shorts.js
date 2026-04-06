// ASIC Short Position Data — Official institutional short selling data
// Fetches the latest ASIC daily aggregate short position CSV
// Short selling is overwhelmingly institutional (hedge funds, IBs)
// Returns: { date, positions: { BHP: { short: 12345678, total: 3000000000, pct: 0.41 }, ... } }
exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };

  try {
    // Step 1: Get the latest available date from ASIC's index
    const indexR = await fetch('https://download.asic.gov.au/short-selling/short-selling-data.json', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!indexR.ok) throw new Error('ASIC index fetch failed: ' + indexR.status);
    const index = await indexR.json();

    // Get most recent entry (array is sorted newest first)
    if (!index || !index.length) throw new Error('No ASIC data available');
    const latest = index[0];
    const dateStr = String(latest.date);
    const version = latest.version || '001';

    // Step 2: Fetch the CSV for that date
    const csvUrl = 'https://download.asic.gov.au/short-selling/RR' + dateStr + '-' + version + '-SSDailyAggShortPos.csv';
    const csvR = await fetch(csvUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    if (!csvR.ok) throw new Error('ASIC CSV fetch failed: ' + csvR.status);
    const csv = await csvR.text();

    // Step 3: Parse CSV — columns: Product, Product Code, Reported Short Positions, Total Product in Issue, % Short
    const lines = csv.split('\n').slice(1); // skip header
    const positions = {};
    for (const line of lines) {
      // Handle CSV with possible commas in product names
      const parts = line.split(',');
      if (parts.length < 5) continue;
      // Work backwards from end: pct, total, short, code, name
      const pct = parseFloat(parts[parts.length - 1]);
      const total = parseInt(parts[parts.length - 2], 10);
      const short = parseInt(parts[parts.length - 3], 10);
      const code = (parts[parts.length - 4] || '').trim();
      if (!code || isNaN(short)) continue;
      positions[code] = { short, total: total || 0, pct: isNaN(pct) ? 0 : +pct.toFixed(4) };
    }

    // Filter to only tickers the client needs (if specified)
    const params = event.queryStringParameters || {};
    let result = positions;
    if (params.tickers) {
      const wanted = params.tickers.split(',').map(t => t.trim().toUpperCase());
      result = {};
      for (const t of wanted) {
        if (positions[t]) result[t] = positions[t];
      }
    }

    const formattedDate = dateStr.substring(0, 4) + '-' + dateStr.substring(4, 6) + '-' + dateStr.substring(6, 8);
    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        date: formattedDate,
        rawDate: latest.date,
        count: Object.keys(result).length,
        totalParsed: Object.keys(positions).length,
        positions: result,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
