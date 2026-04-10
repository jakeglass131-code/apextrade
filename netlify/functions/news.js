const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes — aggressive, financial news moves fast
let cache = { data: null, timestamp: 0 };

// ---------------------------------------------------------------------------
// RSS Sources — finance only, ranked by priority
// ---------------------------------------------------------------------------
// Each source gets a weight; higher-weight sources' items are kept even when
// the dedupe/keyword filter is unsure, and they contribute more to the final
// ordering for equal-timestamp items.
const SOURCES = [
  { name: "MarketWatch Top",     url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", weight: 10 },
  { name: "MarketWatch Pulse",   url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse", weight: 10 },
  { name: "MarketWatch RealTime",url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines", weight: 10 },
  { name: "Yahoo Finance",       url: "https://finance.yahoo.com/news/rssindex", weight: 10 },
  { name: "CNBC Top",            url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", weight: 9 },
  { name: "CNBC Markets",        url: "https://www.cnbc.com/id/15839069/device/rss/rss.html", weight: 10 },
  { name: "CNBC Economy",        url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", weight: 8 },
  { name: "Investing.com",       url: "https://www.investing.com/rss/news.rss", weight: 9 },
  { name: "Investing Econ",      url: "https://www.investing.com/rss/news_95.rss", weight: 9 },
  { name: "Investing Forex",     url: "https://www.investing.com/rss/news_1.rss", weight: 8 },
  { name: "Seeking Alpha",       url: "https://seekingalpha.com/market_currents.xml", weight: 9 },
  { name: "FT Markets",          url: "https://www.ft.com/markets?format=rss", weight: 10 },
  { name: "FT Companies",        url: "https://www.ft.com/companies?format=rss", weight: 9 },
  { name: "Reuters Business",    url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best", weight: 10 },
  { name: "AFR Markets",         url: "https://www.afr.com/rss/markets", weight: 9 },
  { name: "AFR Companies",       url: "https://www.afr.com/rss/companies", weight: 8 },
  { name: "Yahoo Finance AU",    url: "https://au.finance.yahoo.com/rss/topstories", weight: 8 },
  { name: "ABC Business AU",     url: "https://www.abc.net.au/news/feed/2811686/rss.xml", weight: 6 },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=180",
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_ITEMS = 40;
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Finance relevance filter
// ---------------------------------------------------------------------------
// Items must contain at least one finance-related term OR come from a weight-10
// source (which is already finance-only and doesn't need filtering).
const FINANCE_KEYWORDS = [
  // Markets / instruments
  "stock", "stocks", "equity", "equities", "share", "shares", "bond", "bonds",
  "yield", "yields", "treasury", "treasuries", "forex", "fx", "currency",
  "currencies", "commodity", "commodities", "crude", "oil", "gold", "silver",
  "copper", "iron ore", "gas", "bitcoin", "crypto", "ether", "ethereum",
  "s&p", "dow", "nasdaq", "nikkei", "hang seng", "ftse", "dax", "asx", "xjo",
  "xec", "xso", "nifty", "sensex",
  // Macro / policy
  "fed", "fomc", "federal reserve", "rate hike", "rate cut", "interest rate",
  "interest rates", "inflation", "cpi", "ppi", "pce", "gdp", "unemployment",
  "jobs report", "jobless", "nfp", "nonfarm", "payroll", "payrolls", "ecb",
  "rba", "boj", "boe", "pboc", "recession", "stagflation", "hawkish", "dovish",
  "tariff", "tariffs", "trade war", "opec",
  // Corporate / M&A
  "earnings", "eps", "revenue", "guidance", "merger", "acquisition", "buyback",
  "dividend", "ipo", "spac", "listing", "delisting", "profit warning",
  "downgrade", "upgrade", "rating", "analyst", "target price",
  // Sectors / companies commonly in finance news (partial list)
  "bank", "banking", "fintech", "tech giant", "ai chip", "chipmaker",
  "semiconductor", "pharma", "biotech", "miner", "mining", "energy",
  "airline", "automaker", "ev ", "tesla", "nvidia", "apple", "microsoft",
  "amazon", "meta", "alphabet", "google", "bhp", "rio tinto", "cba",
  "commonwealth bank", "nab", "westpac", "anz",
  // Trading
  "futures", "options", "derivatives", "volatility", "vix", "bull", "bear",
  "rally", "selloff", "sell-off", "correction", "bubble", "liquidation",
  "margin call", "hedge", "hedge fund", "pension fund", "etf",
  // Currencies
  "dollar", "euro", "yen", "pound", "yuan", "aussie", "loonie", "franc",
  "usd", "eur", "jpy", "gbp", "aud", "nzd", "cad", "chf", "cny",
];
const KEYWORD_REGEX = new RegExp("\\b(" + FINANCE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");

// Blocklist — topics that slip through BBC Business / ABC but aren't finance
const BLOCK_KEYWORDS = [
  "royal family", "buckingham", "fingerprint", "lawsuit over her",
  "perfume", "fashion week", "celebrity", "world cup", "football",
  "cricket", "olympics", "eurovision", "red carpet", "oscars", "grammys",
];
const BLOCK_REGEX = new RegExp("(" + BLOCK_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");

function isRelevant(item, source) {
  if (!item.title) return false;
  const blob = (item.title + " " + (item.description || "")).toLowerCase();
  if (BLOCK_REGEX.test(blob)) return false;
  if (source.weight >= 10) return true; // dedicated finance wires don't need keyword check
  return KEYWORD_REGEX.test(blob);
}

// ---------------------------------------------------------------------------
// Lightweight XML helpers (no external deps)
// ---------------------------------------------------------------------------

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  const raw = (m[1] !== undefined ? m[1] : m[2]) || "";
  return raw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function parseItem(itemXml, source) {
  const title = extractTag(itemXml, "title");
  const link = extractTag(itemXml, "link");
  const pubDateRaw = extractTag(itemXml, "pubDate") || extractTag(itemXml, "dc:date") || extractTag(itemXml, "updated");
  const descriptionRaw = extractTag(itemXml, "description") || extractTag(itemXml, "summary");

  let pubDate;
  try {
    pubDate = new Date(pubDateRaw).toISOString();
    if (isNaN(new Date(pubDate).getTime())) throw new Error("bad date");
  } catch {
    pubDate = new Date().toISOString();
  }

  const description = descriptionRaw.length > 160 ? descriptionRaw.slice(0, 157) + "..." : descriptionRaw;

  return { title, source: source.name, weight: source.weight, pubDate, link, description };
}

function parseRSS(xml, source) {
  const items = [];
  // Handle both <item> (RSS) and <entry> (Atom)
  const parts = xml.split(/<(?:item|entry)[\s>]/i);
  for (let i = 1; i < parts.length; i++) {
    const endMatch = parts[i].search(/<\/(?:item|entry)>/i);
    if (endMatch === -1) continue;
    const block = parts[i].slice(0, endMatch);
    const item = parseItem(block, source);
    if (item.title) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (follows up to 3 redirects, supports http + https)
// ---------------------------------------------------------------------------
function fetchURL(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      {
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ApexTrade-NewsAggregator/2.0; +https://apextrade-proxy.netlify.app)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          return fetchURL(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", reject);
  });
}

async function fetchSource(source) {
  try {
    const xml = await fetchURL(source.url);
    const items = parseRSS(xml, source);
    return items.filter((item) => isRelevant(item, source));
  } catch (err) {
    console.warn(`[news] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate by title similarity
// ---------------------------------------------------------------------------
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function deduplicate(items) {
  // Prefer higher-weight sources' version of duplicated stories
  items.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const seen = [];
  const result = [];
  for (const item of items) {
    const key = normTitle(item.title);
    if (!key) continue;
    let isDupe = false;
    for (const existing of seen) {
      if (existing === key) { isDupe = true; break; }
      const minLen = Math.min(existing.length, key.length, 40);
      if (minLen >= 20 && existing.slice(0, minLen) === key.slice(0, minLen)) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) {
      seen.push(key);
      result.push(item);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main aggregation logic
// ---------------------------------------------------------------------------
async function aggregateNews() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  const results = await Promise.all(SOURCES.map(fetchSource));
  let items = results.flat();

  items = deduplicate(items);

  // Sort by pubDate descending (newest first), tie-break by source weight
  items.sort((a, b) => {
    const t = new Date(b.pubDate) - new Date(a.pubDate);
    if (t !== 0) return t;
    return (b.weight || 0) - (a.weight || 0);
  });

  // Drop anything older than 24h — stale isn't useful
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  items = items.filter((it) => new Date(it.pubDate).getTime() >= cutoff);

  items = items.slice(0, MAX_ITEMS);

  const payload = {
    count: items.length,
    items,
    lastUpdated: new Date().toISOString(),
  };

  cache = { data: payload, timestamp: Date.now() };
  return payload;
}

// ---------------------------------------------------------------------------
// Netlify function handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    const data = await aggregateNews();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("[news] Aggregation error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to fetch news",
        message: err.message,
      }),
    };
  }
};
