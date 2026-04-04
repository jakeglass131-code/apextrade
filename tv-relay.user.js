// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      2.1
// @description  Captures TradingView candle data and auto-cycles through watchlist
// @match        https://www.tradingview.com/*
// @match        https://tradingview.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var CACHE_ENDPOINT = 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';
  var SEND_INTERVAL = 5000;
  var CYCLE_DELAY = 6000; // 6s per ticker when auto-cycling
  var DEBUG = true;
  var pendingData = {};
  var lastKnownSymbol = '';
  var autoCycling = false;
  var cycleCount = 0;
  var totalSent = 0;

  function log(msg) { if (DEBUG) console.log('[ApexTrade Relay] ' + msg); }
  log('Script starting...');

  // ── Intercept WebSocket ──
  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function () {
    var ws = new (Function.prototype.bind.apply(OrigWebSocket, [null].concat(Array.prototype.slice.call(arguments))))();
    var url = arguments[0] || '';
    if (url.indexOf('tradingview.com') !== -1) {
      log('Hooked WebSocket: ' + url);
      ws.addEventListener('message', function (e) { try { parseWSMessage(e.data); } catch(x){} });
    }
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ── Intercept XHR ──
  var origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._tvUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
    if (this._tvUrl.indexOf('/history') !== -1) {
      this.addEventListener('load', function () {
        try {
          var d = JSON.parse(this.responseText);
          if (d && d.t && d.s === 'ok') handleUDF(d, this._tvUrl);
        } catch(e){}
      });
    }
    return origXHROpen.apply(this, arguments);
  };

  // ── Intercept fetch ──
  var origFetch = window.fetch;
  window.fetch = function () {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
    var result = origFetch.apply(this, arguments);
    if (url.indexOf('/history') !== -1) {
      result.then(function (r) { r.clone().json().then(function (d) {
        if (d && d.t && d.s === 'ok') handleUDF(d, url);
      }).catch(function(){}); }).catch(function(){});
    }
    return result;
  };

  function handleUDF(data, url) {
    var ticker = '';
    try { ticker = new URL(url).searchParams.get('symbol') || ''; } catch(e){}
    if (ticker.indexOf(':') !== -1) ticker = ticker.split(':').pop();
    ticker = ticker.replace(/\.AX$/i, '');
    if (!ticker) return;
    var candles = [];
    for (var i = 0; i < data.t.length; i++) {
      if (data.o[i] != null && data.c[i] != null)
        candles.push({ t: data.t[i]*1000, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v?data.v[i]:0 });
    }
    if (candles.length) { bufferCandles(ticker, candles); log('UDF: ' + candles.length + ' candles for ' + ticker); }
  }

  // ── Parse WebSocket ──
  function parseWSMessage(raw) {
    if (typeof raw !== 'string') return;
    var parts = raw.split(/~m~\d+~m~/);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i].charAt(0) !== '{') continue;
      try {
        var p = JSON.parse(parts[i]);
        if (p.m === 'du' || p.m === 'timescale_update') extractFromTV(p.p);
      } catch(e){}
    }
    var symMatch = raw.match(/symbol[=:](?:ASX[:%3A]+)?([A-Z][A-Z0-9]{1,5})/i);
    if (symMatch) { var s = symMatch[1]; if (/^[A-Z0-9]+$/.test(s) && s.length <= 5) lastKnownSymbol = s; }
  }

  function extractFromTV(params) {
    if (!Array.isArray(params)) return;
    for (var i = 0; i < params.length; i++) if (params[i] && typeof params[i] === 'object') searchForSeries(params[i]);
  }

  function searchForSeries(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.s && Array.isArray(obj.s) && obj.s.length && obj.s[0].v && obj.s[0].v.length >= 5) { processSeries(obj); return; }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) { var v = obj[keys[i]]; if (v && typeof v === 'object') searchForSeries(v); }
  }

  function processSeries(seriesObj) {
    var ticker = '';
    if (seriesObj.ns) ticker = seriesObj.ns.short_name || seriesObj.ns.name || '';
    if (!ticker) { var s = JSON.stringify(seriesObj); var m = s.match(/"(?:short_name|name|symbol)"\s*:\s*"([A-Z][A-Z0-9.:]*)"/); if (m) ticker = m[1]; }
    if (!ticker && lastKnownSymbol) ticker = lastKnownSymbol;
    var candles = [];
    for (var i = 0; i < seriesObj.s.length; i++) { var v = seriesObj.s[i].v; if (v && v.length >= 5) candles.push({ t: v[0]*1000, o: v[1], h: v[2], l: v[3], c: v[4], v: v[5]||0 }); }
    if (!candles.length) return;
    if (ticker.indexOf(':') !== -1) ticker = ticker.split(':').pop();
    ticker = ticker.replace(/\.AX$/i, '');
    if (!ticker) return;
    bufferCandles(ticker, candles);
    log('WS: ' + candles.length + ' candles for ' + ticker);
  }

  function bufferCandles(ticker, candles) {
    if (!pendingData[ticker]) pendingData[ticker] = { candles: [] };
    var map = {};
    var e = pendingData[ticker].candles;
    for (var i = 0; i < e.length; i++) map[e[i].t] = e[i];
    for (var j = 0; j < candles.length; j++) map[candles[j].t] = candles[j];
    var merged = [];
    for (var k in map) merged.push(map[k]);
    merged.sort(function (a, b) { return a.t - b.t; });
    pendingData[ticker] = { candles: merged };
  }

  // ── Send to cache ──
  setInterval(flushCache, SEND_INTERVAL);

  function flushCache() {
    var tickers = Object.keys(pendingData);
    if (!tickers.length) return;
    for (var i = 0; i < tickers.length; i++) {
      var t = tickers[i], d = pendingData[t];
      if (!d.candles.length) continue;
      log('Sending ' + d.candles.length + ' candles for ' + t);
      totalSent++;
      origFetch(CACHE_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t, exchange: 'ASX', candles: d.candles, source: 'tradingview', timestamp: Date.now() }),
        mode: 'cors',
      }).then(function(r){ log('Sent OK: ' + r.status); }).catch(function(e){ log('Send error: ' + e.message); });
    }
    for (var key in pendingData) delete pendingData[key];
    updateBadge();
  }

  // ── AUTO-CYCLE via keyboard shortcut (Alt+Down = next watchlist item) ──
  function nextWatchlistItem() {
    // Simulate Alt+Down Arrow — TV's shortcut for next symbol in watchlist
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, altKey: true, bubbles: true }));
    // Also try on the chart container
    var chart = document.querySelector('.chart-markup-table') || document.querySelector('.chart-container') || document.body;
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, altKey: true, bubbles: true }));
    cycleCount++;
    updateBadge();
  }

  var cycleTimer = null;
  function startCycle() {
    if (autoCycling) return;
    autoCycling = true;
    cycleCount = 0;
    log('Auto-cycle started — pressing Alt+Down every ' + (CYCLE_DELAY/1000) + 's');
    cycleTimer = setInterval(nextWatchlistItem, CYCLE_DELAY);
    updateBadge();
  }
  function stopCycle() {
    autoCycling = false;
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = null;
    log('Auto-cycle stopped after ' + cycleCount + ' tickers');
    updateBadge();
  }

  // ── Badge ──
  function addBadge() {
    if (document.getElementById('apextrade-relay-badge')) return;
    var b = document.createElement('div');
    b.id = 'apextrade-relay-badge';
    b.textContent = 'ApexTrade Relay';
    b.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;background:#1a1a2e;color:#00d4aa;border:1px solid #00d4aa;padding:6px 12px;border-radius:12px;font-size:12px;font-family:-apple-system,sans-serif;cursor:pointer;opacity:0.8;';
    b.onclick = function () {
      if (autoCycling) { stopCycle(); }
      else if (confirm('Start auto-cycling through your watchlist?\n\nUses Alt+Down to move through watchlist items.\nCaptures candle data for each ticker.\n\nMake sure a watchlist with ASX tickers is selected.\nSent so far: ' + totalSent + ' tickers')) { startCycle(); }
    };
    document.body.appendChild(b);
  }
  function updateBadge() {
    var b = document.getElementById('apextrade-relay-badge');
    if (!b) return;
    if (autoCycling) { b.textContent = 'Cycling: ' + cycleCount + ' | Sent: ' + totalSent; b.style.color = '#ffaa00'; b.style.borderColor = '#ffaa00'; }
    else { b.textContent = 'Relay (sent: ' + totalSent + ')'; b.style.color = '#00d4aa'; b.style.borderColor = '#00d4aa'; }
  }

  // Track symbol from DOM
  setInterval(function () {
    try {
      var el = document.querySelector('[data-symbol-short]');
      if (el) { var s = (el.getAttribute('data-symbol-short') || el.textContent.trim()).replace(/.*:/, '').replace(/\.AX$/i, ''); if (s && /^[A-Z0-9]+$/.test(s)) lastKnownSymbol = s; }
    } catch(e){}
  }, 2000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
  else addBadge();
  setTimeout(addBadge, 3000);

  log('ApexTrade TV Relay v2.1 loaded — click badge to auto-cycle watchlist');
})();
