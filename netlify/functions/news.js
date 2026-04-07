const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, timestamp: 0 };

// ---------------------------------------------------------------------------
// RSS Sources (priority order)
// ---------------------------------------------------------------------------
const SOURCES = [
  { name: "AFR Markets", url: "https://www.afr.com/rss/markets" },
  { name: "Yahoo Finance AU", url: "https://au.finance.yahoo.com/rss/topstories" },
  { name: "ABC Business AU", url: "https://www.abc.net.au/news/feed/2811686/rss.xml" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "Reuters Business", url: "http://feeds.reuters.com/reuters/businessNews" },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=300",
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_ITEMS = 20;
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Lightweight XML helpers (no external deps)
// ---------------------------------------------------------------------------

/** Extract the text content of the first occurrence of <tag>...</tag> */
function extractTag(xml, tag) {
  // Handle CDATA sections too
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  const raw = (m[1] !== undefined ? m[1] : m[2]) || "";
  return raw.replace(/<[^>]+>/g, "").trim(); // strip any inner HTML
}

/** Parse a single <item> block into a structured object */
function parseItem(itemXml, sourceName) {
  const title = extractTag(itemXml, "title");
  const link = extractTag(itemXml, "link");
  const pubDateRaw = extractTag(itemXml, "pubDate");
  const descriptionRaw = extractTag(itemXml, "description");

  // Normalise pubDate to ISO string
  let pubDate;
  try {
    pubDate = new Date(pubDateRaw).toISOString();
  } catch {
    pubDate = new Date().toISOString();
  }

  // Truncate description to 120 chars
  const description =
    descriptionRaw.length > 120
      ? descriptionRaw.slice(0, 117) + "..."
      : descriptionRaw;

  return { title, source: sourceName, pubDate, link, description };
}

/** Parse entire RSS XML string and return an array of items */
function parseRSS(xml, sourceName) {
  const items = [];
  // Split on <item> blocks
  const parts = xml.split(/<item[\s>]/i);
  // First element is the channel header, skip it
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf("</item>");
    if (end === -1) continue;
    const block = parts[i].slice(0, end);
    const item = parseItem(block, sourceName);
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
          "User-Agent": "ApexTrade-NewsAggregator/1.0",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      },
      (res) => {
        // Follow redirects
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Fetch + parse a single source (never rejects; returns [] on failure)
// ---------------------------------------------------------------------------
async function fetchSource(source) {
  try {
    const xml = await fetchURL(source.url);
    return parseRSS(xml, source.name);
  } catch (err) {
    console.warn(`[news] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate by title similarity (simple normalised comparison)
// ---------------------------------------------------------------------------
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function deduplicate(items) {
  const seen = new Map();
  const result = [];
  for (const item of items) {
    const key = normTitle(item.title);
    if (!key) continue;
    // Check for exact or near-duplicate (prefix match)
    let isDupe = false;
    for (const [existing] of seen) {
      if (existing === key) {
        isDupe = true;
        break;
      }
      // If one title is a prefix of the other (first 40 normalised chars match)
      const minLen = Math.min(existing.length, key.length, 40);
      if (minLen >= 20 && existing.slice(0, minLen) === key.slice(0, minLen)) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) {
      seen.set(key, true);
      result.push(item);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main aggregation logic
// ---------------------------------------------------------------------------
async function aggregateNews() {
  // Check in-memory cache
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  // Fetch all sources concurrently
  const results = await Promise.all(SOURCES.map(fetchSource));
  let items = results.flat();

  // Deduplicate
  items = deduplicate(items);

  // Sort by pubDate descending (newest first)
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Limit to MAX_ITEMS
  items = items.slice(0, MAX_ITEMS);

  const payload = {
    count: items.length,
    items,
    lastUpdated: new Date().toISOString(),
  };

  // Update cache
  cache = { data: payload, timestamp: Date.now() };

  return payload;
}

// ---------------------------------------------------------------------------
// Netlify function handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  // Handle CORS preflight
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
