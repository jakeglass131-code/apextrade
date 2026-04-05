// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      3.1
// @description  Captures TradingView candle data and auto-cycles through watchlist
// @match        https://www.tradingview.com/*
// @match        https://tradingview.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/jakeglass131-code/apextrade/main/tv-relay.user.js
// @downloadURL  https://raw.githubusercontent.com/jakeglass131-code/apextrade/main/tv-relay.user.js
// ==/UserScript==

(function () {
  'use strict';

  var CACHE_ENDPOINT = 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';
  var SEND_INTERVAL = 5000;
  var CYCLE_DELAY = 8000; // 8s per ticker
  var DEBUG = true;
  var pendingData = {};
  var lastKnownSymbol = '';
  var autoCycling = false;
  var cycleCount = 0;
  var totalSent = 0;
  var watchlistRows = [];
  var currentRowIndex = 0;

  function log(msg) { if (DEBUG) console.log('[ApexTrade Relay] ' + msg); }
  log('v3.0 starting...');

  // ══════════════════════════════════════════════
  // WEBSOCKET / XHR / FETCH INTERCEPTORS (proven working)
  // ══════════════════════════════════════════════

  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function () {
    var ws = new (Function.prototype.bind.apply(OrigWebSocket, [null].concat(Array.prototype.slice.call(arguments))))();
    var url = arguments[0] || '';
    if (url.indexOf('tradingview.com') !== -1) {
      log('Hooked WebSocket: ' + url.substring(0, 80));
      ws.addEventListener('message', function (e) { try { parseWSMessage(e.data); } catch(x){} });
    }
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  var origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._tvUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
    if (this._tvUrl.indexOf('/history') !== -1) {
      this.addEventListener('load', function () {
        try { var d = JSON.parse(this.responseText); if (d && d.t && d.s === 'ok') handleUDF(d, this._tvUrl); } catch(e){}
      });
    }
    return origXHROpen.apply(this, arguments);
  };

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
    if (!ticker) { var s = JSON.stringify(seriesObj).substring(0, 2000); var m = s.match(/"(?:short_name|name|symbol)"\s*:\s*"([A-Z][A-Z0-9.:]*)"/); if (m) ticker = m[1]; }
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

  // ══════════════════════════════════════════════
  // SEND TO CACHE
  // ══════════════════════════════════════════════

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

  // ══════════════════════════════════════════════
  // AUTO-CYCLE: SMART WATCHLIST ROW DISCOVERY
  // ══════════════════════════════════════════════

  function discoverWatchlistRows() {
    // Use [class*="cell-"] which we confirmed has 348 matches on TV
    var cells = document.querySelectorAll('[class*="cell-"]');
    log('Found ' + cells.length + ' cell elements');

    if (cells.length > 10) {
      // These are individual cells — we need to find the row containers
      // Group cells by their parent elements
      var parents = new Set();
      for (var i = 0; i < cells.length; i++) {
        var p = cells[i].parentElement;
        if (p) parents.add(p);
      }
      var rows = Array.from(parents);
      // Filter to just visible rows in the right panel
      rows = rows.filter(function(el) {
        var r = el.getBoundingClientRect();
        return r.width > 100 && r.height > 10 && r.height < 80;
      });
      if (rows.length > 5) {
        log('Discovered ' + rows.length + ' watchlist rows from cell parents');
        return rows;
      }
    }

    // Fallback: find the scrollable list container in the right panel
    var allEls = document.querySelectorAll('div');
    var listContainer = null;
    for (var j = 0; j < allEls.length; j++) {
      var el = allEls[j];
      var rect = el.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.5 &&
          el.scrollHeight > el.clientHeight + 100 &&
          el.children.length > 10) {
        listContainer = el;
        break;
      }
    }

    if (listContainer) {
      var found = [];
      for (var k = 0; k < listContainer.children.length; k++) {
        var child = listContainer.children[k];
        var cr = child.getBoundingClientRect();
        if (cr.height > 10 && cr.height < 80 && cr.width > 100) {
          found.push(child);
        }
      }
      log('Discovered ' + found.length + ' rows from scrollable container');
      return found;
    }

    log('WARNING: Could not discover watchlist rows');
    return [];
  }

  function nextWatchlistItem() {
    // Re-discover rows periodically (DOM may change as we scroll)
    if (watchlistRows.length === 0 || currentRowIndex >= watchlistRows.length || cycleCount % 20 === 0) {
      watchlistRows = discoverWatchlistRows();
      if (currentRowIndex >= watchlistRows.length) currentRowIndex = 0;
    }

    if (watchlistRows.length === 0) {
      log('ERROR: No watchlist rows found. Make sure a watchlist is visible in the right panel.');
      return;
    }

    // Click the current row — try multiple click targets
    var row = watchlistRows[currentRowIndex];
    try {
      // Find the first cell (ticker name) inside the row — TV listens on these
      var firstCell = row.querySelector('[class*="cell-"]');
      var target = firstCell || row;

      // Simulate a full mouse click sequence at the element's center
      var rect = target.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));

      // Also try clicking the row itself
      if (firstCell) {
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
        row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
      }

      // Also try using document.elementFromPoint to get the REAL element TV renders
      var realEl = document.elementFromPoint(cx, cy);
      if (realEl && realEl !== target && realEl !== row) {
        realEl.dispatchEvent(new MouseEvent('mousedown', opts));
        realEl.dispatchEvent(new MouseEvent('mouseup', opts));
        realEl.dispatchEvent(new MouseEvent('click', opts));
      }

      var rowText = row.textContent.trim().substring(0, 30);
      log('Clicked row ' + currentRowIndex + '/' + watchlistRows.length + ' at (' + Math.round(cx) + ',' + Math.round(cy) + '): "' + rowText + '"');
    } catch(e) {
      log('Click failed: ' + e.message);
    }

    currentRowIndex++;
    cycleCount++;

    // If we've gone through all visible rows, scroll down to reveal more
    if (currentRowIndex >= watchlistRows.length) {
      log('Reached end of visible rows, scrolling watchlist...');
      scrollWatchlist();
      currentRowIndex = 0;
      // Re-discover after scroll
      setTimeout(function() { watchlistRows = discoverWatchlistRows(); }, 1000);
    }

    updateBadge();
  }

  function scrollWatchlist() {
    // Find scrollable container in right panel
    var scrollables = document.querySelectorAll('div');
    for (var i = 0; i < scrollables.length; i++) {
      var el = scrollables[i];
      var rect = el.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.6 &&
          rect.height > 200 &&
          el.scrollHeight > el.clientHeight + 50) {
        el.scrollTop += 500; // Scroll down
        log('Scrolled watchlist container (scrollTop=' + el.scrollTop + '/' + el.scrollHeight + ')');
        return;
      }
    }
    log('No scrollable watchlist container found');
  }

  var cycleTimer = null;
  function startCycle() {
    if (autoCycling) return;
    autoCycling = true;
    cycleCount = parseInt(localStorage.getItem('apextrade_cycle_count') || '0');
    totalSent = parseInt(localStorage.getItem('apextrade_total_sent') || '0');

    // Discover rows first
    watchlistRows = discoverWatchlistRows();

    if (watchlistRows.length === 0) {
      log('No watchlist rows found! Make sure a watchlist panel is visible on the right side.');
      autoCycling = false;
      return;
    }

    log('Auto-cycle started: ' + watchlistRows.length + ' rows found, cycling every ' + (CYCLE_DELAY/1000) + 's');
    localStorage.setItem('apextrade_autocycle', 'true');
    cycleTimer = setInterval(function() {
      nextWatchlistItem();
      // Persist progress
      localStorage.setItem('apextrade_cycle_count', cycleCount);
      localStorage.setItem('apextrade_total_sent', totalSent);
    }, CYCLE_DELAY);
    updateBadge();
  }

  function stopCycle() {
    autoCycling = false;
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = null;
    localStorage.setItem('apextrade_autocycle', 'false');
    log('Auto-cycle stopped. Cycled: ' + cycleCount + ', Sent: ' + totalSent);
    updateBadge();
  }

  // ══════════════════════════════════════════════
  // BADGE UI
  // ══════════════════════════════════════════════

  function addBadge() {
    if (document.getElementById('apextrade-relay-badge')) return;
    var b = document.createElement('div');
    b.id = 'apextrade-relay-badge';
    b.textContent = 'ApexTrade Relay';
    b.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;background:#1a1a2e;color:#00d4aa;border:1px solid #00d4aa;padding:6px 12px;border-radius:12px;font-size:12px;font-family:-apple-system,sans-serif;cursor:pointer;opacity:0.85;';
    b.onclick = function () {
      if (autoCycling) {
        stopCycle();
        alert('Auto-cycle stopped.\n\nCycled: ' + cycleCount + '\nSent: ' + totalSent);
      } else {
        if (confirm('Start auto-cycling through watchlist?\n\nMake sure an ASX watchlist is visible in the right panel.\n\nPrevious progress — Cycled: ' + cycleCount + ', Sent: ' + totalSent)) {
          startCycle();
        }
      }
    };
    document.body.appendChild(b);
  }

  function updateBadge() {
    var b = document.getElementById('apextrade-relay-badge');
    if (!b) return;
    if (autoCycling) {
      b.textContent = 'Cycling: ' + cycleCount + ' | Sent: ' + totalSent + ' | Rows: ' + watchlistRows.length;
      b.style.color = '#ffaa00';
      b.style.borderColor = '#ffaa00';
    } else {
      b.textContent = 'Relay (sent: ' + totalSent + ')';
      b.style.color = '#00d4aa';
      b.style.borderColor = '#00d4aa';
    }
  }

  // Track symbol from DOM
  setInterval(function () {
    try {
      var el = document.querySelector('[data-symbol-short]');
      if (el) { var s = (el.getAttribute('data-symbol-short') || el.textContent.trim()).replace(/.*:/, '').replace(/\.AX$/i, ''); if (s && /^[A-Z0-9]+$/.test(s)) lastKnownSymbol = s; }
    } catch(e){}
  }, 2000);

  // ══════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════

  function init() {
    addBadge();
    totalSent = parseInt(localStorage.getItem('apextrade_total_sent') || '0');
    cycleCount = parseInt(localStorage.getItem('apextrade_cycle_count') || '0');
    updateBadge();

    // Auto-resume if was cycling before
    if (localStorage.getItem('apextrade_autocycle') === 'true') {
      log('Auto-resuming cycle from previous session...');
      setTimeout(startCycle, 5000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 3000); });
  else setTimeout(init, 3000);

  log('ApexTrade TV Relay v3.0 loaded');
})();
