// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      1.0
// @description  Intercepts TradingView candle data and relays it to your ApexTrade proxy cache
// @match        https://www.tradingview.com/*
// @match        https://tradingview.com/*
// @grant        GM_xmlhttpRequest
// @connect      apextrade-proxy.netlify.app
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CACHE_ENDPOINT = 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';
  const SEND_INTERVAL = 5000; // batch sends every 5 seconds
  const DEBUG = false;

  // Buffer of candle data waiting to be sent
  const pendingData = {};

  function log(...args) {
    if (DEBUG) console.log('[ApexTrade Relay]', ...args);
  }

  // ── Intercept WebSocket to capture candle data ──
  const OrigWebSocket = window.WebSocket;

  window.WebSocket = function (...args) {
    const ws = new OrigWebSocket(...args);
    const url = args[0] || '';

    // Only hook TradingView data WebSockets
    if (url.includes('data.tradingview.com') || url.includes('prodata.tradingview.com') || url.includes('widgetdata.tradingview.com')) {
      log('Hooked WebSocket:', url);

      const origOnMessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');

      ws.addEventListener('message', function (event) {
        try {
          parseWSMessage(event.data);
        } catch (e) {
          // Silently ignore parse errors
        }
      });
    }

    return ws;
  };

  // Copy prototype and static properties
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ── Parse TradingView WebSocket messages ──
  function parseWSMessage(raw) {
    if (typeof raw !== 'string') return;

    // TV WebSocket messages are prefixed with ~m~LENGTH~m~
    const messages = raw.split(/~m~\d+~m~/).filter(Boolean);

    for (const msg of messages) {
      // Skip heartbeats and protocol messages
      if (!msg.startsWith('{') && !msg.startsWith('[')) continue;

      try {
        const parsed = JSON.parse(msg);
        handleTVMessage(parsed);
      } catch {
        // Not JSON, skip
      }
    }
  }

  function handleTVMessage(msg) {
    // TradingView sends candle data in "du" (data update) or "timescale_update" messages
    if (!msg.m) return;

    if (msg.m === 'du' || msg.m === 'timescale_update') {
      extractCandleData(msg.p);
    }
  }

  function extractCandleData(params) {
    if (!Array.isArray(params)) return;

    for (const param of params) {
      if (!param || typeof param !== 'object') continue;

      // Look for series data in the message
      // TV nests candle data under various keys depending on the message type
      const keys = Object.keys(param);
      for (const key of keys) {
        const val = param[key];
        if (!val) continue;

        // "s" arrays contain candle series data
        if (val.s && Array.isArray(val.s)) {
          processSeries(val, key);
        }

        // Also check nested objects
        if (typeof val === 'object' && !Array.isArray(val)) {
          for (const subKey of Object.keys(val)) {
            const subVal = val[subKey];
            if (subVal && subVal.s && Array.isArray(subVal.s)) {
              processSeries(subVal, subKey);
            }
          }
        }
      }
    }
  }

  function processSeries(seriesObj, seriesKey) {
    const series = seriesObj.s;
    if (!series || !series.length) return;

    // Extract symbol info — TV includes it in the "ns" or in series metadata
    const symbolInfo = seriesObj.ns || {};
    let ticker = symbolInfo.short_name || symbolInfo.name || '';
    const exchange = symbolInfo.exchange || symbolInfo.listed_exchange || '';

    // Try to get ticker from the series key if not in metadata
    if (!ticker && seriesKey) {
      // Series keys often contain the symbol
      ticker = seriesKey;
    }

    // Parse each candle bar
    // TV candle format in series: { i: index, v: [timestamp, open, high, low, close, volume] }
    const candles = [];

    for (const bar of series) {
      const v = bar.v;
      if (!v || !Array.isArray(v) || v.length < 5) continue;

      candles.push({
        t: v[0] * 1000, // TV sends seconds, we need ms
        o: v[1],
        h: v[2],
        l: v[3],
        c: v[4],
        v: v[5] || 0,
      });
    }

    if (candles.length === 0) return;

    // Clean ticker — strip exchange prefix if present
    if (ticker.includes(':')) {
      ticker = ticker.split(':').pop();
    }
    // Remove .AX suffix for consistency
    ticker = ticker.replace(/\.AX$/i, '');

    if (!ticker) return;

    log(`Captured ${candles.length} candles for ${ticker}`);

    // Buffer the data — merge with existing
    if (!pendingData[ticker]) {
      pendingData[ticker] = { candles: [], exchange };
    }

    // Merge candles by timestamp (newer data overwrites older)
    const existing = new Map(pendingData[ticker].candles.map(c => [c.t, c]));
    for (const candle of candles) {
      existing.set(candle.t, candle);
    }
    pendingData[ticker].candles = Array.from(existing.values()).sort((a, b) => a.t - b.t);
  }

  // ── Batch send to cache endpoint ──
  setInterval(flushCache, SEND_INTERVAL);

  function flushCache() {
    const tickers = Object.keys(pendingData);
    if (tickers.length === 0) return;

    // Send each ticker's data
    for (const ticker of tickers) {
      const data = pendingData[ticker];
      if (!data.candles.length) continue;

      const payload = {
        ticker,
        exchange: data.exchange,
        candles: data.candles,
        source: 'tradingview',
        timestamp: Date.now(),
      };

      log(`Sending ${data.candles.length} candles for ${ticker}`);

      GM_xmlhttpRequest({
        method: 'POST',
        url: CACHE_ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: function (response) {
          log(`Cache response for ${ticker}:`, response.status);
        },
        onerror: function (err) {
          log(`Cache error for ${ticker}:`, err);
        },
      });
    }

    // Clear buffer after sending
    for (const key of Object.keys(pendingData)) {
      delete pendingData[key];
    }
  }

  // ── Also intercept fetch/XHR for chart data loaded via REST ──
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    if (url.includes('/history') || url.includes('/tradingview.com')) {
      try {
        const clone = response.clone();
        clone.json().then(data => {
          if (data && data.t && Array.isArray(data.t)) {
            // UDF format: { t: [timestamps], o: [opens], h: [highs], l: [lows], c: [closes], v: [volumes] }
            const ticker = extractTickerFromUrl(url);
            if (ticker) {
              const candles = data.t.map((ts, i) => ({
                t: ts * 1000,
                o: data.o?.[i],
                h: data.h?.[i],
                l: data.l?.[i],
                c: data.c?.[i],
                v: data.v?.[i] || 0,
              })).filter(c => c.o != null && c.c != null);

              if (candles.length > 0) {
                const cleanTicker = ticker.replace(/\.AX$/i, '');
                if (!pendingData[cleanTicker]) {
                  pendingData[cleanTicker] = { candles: [], exchange: 'ASX' };
                }
                const existing = new Map(pendingData[cleanTicker].candles.map(c => [c.t, c]));
                for (const candle of candles) {
                  existing.set(candle.t, candle);
                }
                pendingData[cleanTicker].candles = Array.from(existing.values()).sort((a, b) => a.t - b.t);
                log(`REST: Captured ${candles.length} candles for ${cleanTicker}`);
              }
            }
          }
        }).catch(() => {});
      } catch {}
    }

    return response;
  };

  function extractTickerFromUrl(url) {
    // Try to extract symbol from URL query params
    try {
      const u = new URL(url);
      return u.searchParams.get('symbol') || u.searchParams.get('ticker') || '';
    } catch {
      return '';
    }
  }

  // ── Status badge on page ──
  window.addEventListener('load', () => {
    const badge = document.createElement('div');
    badge.id = 'apextrade-relay-badge';
    badge.innerHTML = 'ApexTrade Relay';
    badge.style.cssText = `
      position: fixed; bottom: 10px; left: 10px; z-index: 99999;
      background: #1a1a2e; color: #00d4aa; border: 1px solid #00d4aa;
      padding: 4px 10px; border-radius: 12px; font-size: 11px;
      font-family: -apple-system, sans-serif; cursor: pointer;
      opacity: 0.7; transition: opacity 0.2s;
    `;
    badge.addEventListener('mouseenter', () => badge.style.opacity = '1');
    badge.addEventListener('mouseleave', () => badge.style.opacity = '0.7');
    badge.addEventListener('click', () => {
      const tickers = Object.keys(pendingData);
      const total = tickers.reduce((s, t) => s + pendingData[t].candles.length, 0);
      alert(`ApexTrade Relay\n\nBuffered: ${tickers.length} tickers, ${total} candles\nEndpoint: ${CACHE_ENDPOINT}\nSend interval: ${SEND_INTERVAL / 1000}s`);
    });
    document.body.appendChild(badge);
  });

  log('ApexTrade TV Relay loaded');
})();
