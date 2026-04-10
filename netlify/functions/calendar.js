const https = require("https");

const FF_CALENDAR_URL =
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Simple in-memory cache (15 min) — Forex Factory updates once per day anyway
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Fetch JSON from a URL using plain https (no external deps). */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 10000,
        headers: {
          "User-Agent": "ApexTrade-Calendar/1.0",
          Accept: "application/json, */*",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error("Failed to parse calendar JSON"));
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

/**
 * Convert a Forex Factory datetime string (with tz offset) to AWST (UTC+8).
 * Returns a Date that represents the AWST wall-clock time encoded in UTC fields.
 */
function toAWST(dateStr) {
  const utc = new Date(dateStr);
  if (isNaN(utc.getTime())) return null;
  // AWST is UTC+8 -- offset in ms
  const awstMs = utc.getTime() + 8 * 60 * 60 * 1000;
  return new Date(awstMs);
}

function formatTime(d) {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function dayName(d) {
  // Use UTC day — the Date was already shifted to AWST-as-UTC
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names[d.getUTCDay()];
}

function normaliseImpact(raw) {
  if (!raw) return "low";
  const lower = String(raw).toLowerCase();
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  if (lower === "holiday") return "holiday";
  return "low";
}

/**
 * Netlify function handler.
 *
 * Query params:
 *   scope=today | week   (default: week)
 *
 * Returns the full week of events by default so the client can filter by
 * impact + currency + day without re-fetching.
 */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const scope = (event.queryStringParameters && event.queryStringParameters.scope) || "week";

  try {
    // Serve from cache if warm
    let raw;
    if (cache.data && Date.now() - cache.timestamp < CACHE_TTL_MS) {
      raw = cache.data;
    } else {
      raw = await fetchJSON(FF_CALENDAR_URL);
      cache = { data: raw, timestamp: Date.now() };
    }

    const nowAWST = toAWST(new Date().toISOString());
    const todayStr = formatDate(nowAWST);

    const events = raw
      .map((ev) => {
        const awstDate = toAWST(ev.date);
        if (!awstDate) return null;
        const evDateStr = formatDate(awstDate);
        if (scope === "today" && evDateStr !== todayStr) return null;

        return {
          time: formatTime(awstDate),
          date: evDateStr,
          day: dayName(awstDate),
          title: ev.title || "",
          impact: normaliseImpact(ev.impact),
          country: (ev.country || "").toUpperCase(),
          forecast: ev.forecast || null,
          previous: ev.previous || null,
          actual: ev.actual || null,
          isToday: evDateStr === todayStr,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      });

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900",
      },
      body: JSON.stringify({
        today: todayStr,
        scope,
        count: events.length,
        events,
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch calendar data", detail: err.message }),
    };
  }
};
