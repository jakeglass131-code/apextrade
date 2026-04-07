const https = require("https");

const FF_CALENDAR_URL =
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/**
 * Fetch JSON from a URL using plain https (no external deps).
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error("Failed to parse calendar JSON"));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Convert a Forex Factory datetime string (US-Eastern) to AWST (UTC+8).
 * FF dates look like "2026-04-07T08:30:00-04:00" or similar.
 * We normalise everything through UTC then shift to AWST.
 */
function toAWST(dateStr) {
  const utc = new Date(dateStr);
  if (isNaN(utc.getTime())) return null;
  // AWST is UTC+8 -- offset in ms
  const awstMs = utc.getTime() + 8 * 60 * 60 * 1000;
  return new Date(awstMs);
}

/**
 * Format a Date (already shifted to AWST epoch) as "HH:MM".
 */
function formatTime(d) {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Format a Date (already shifted to AWST epoch) as "YYYY-MM-DD".
 */
function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Map FF impact strings to our simplified levels.
 * FF uses "High", "Medium", "Low", "Holiday", etc.
 */
function normaliseImpact(raw) {
  if (!raw) return "low";
  const lower = raw.toLowerCase();
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  return "low";
}

/**
 * Netlify function handler.
 */
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    const raw = await fetchJSON(FF_CALENDAR_URL);

    // Determine "today" in AWST
    const nowAWST = toAWST(new Date().toISOString());
    const todayStr = formatDate(nowAWST);

    // Filter and map events
    const events = raw
      .map((ev) => {
        const awstDate = toAWST(ev.date);
        if (!awstDate) return null;
        const evDateStr = formatDate(awstDate);
        if (evDateStr !== todayStr) return null;

        return {
          time: formatTime(awstDate),
          title: ev.title || "",
          impact: normaliseImpact(ev.impact),
          country: ev.country || "",
          forecast: ev.forecast || null,
          previous: ev.previous || null,
          actual: ev.actual || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900",
      },
      body: JSON.stringify({ date: todayStr, events }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Failed to fetch calendar data", detail: err.message }),
    };
  }
};
