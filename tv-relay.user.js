// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      1.3
// @description  Intercepts TradingView candle data and relays it to your ApexTrade proxy cache
// @match        https://www.tradingview.com/*
// @match        https://tradingview.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// @grant none = runs in PAGE context (not isolated), can intercept WebSocket/fetch

(function () {
  'use strict';

  var CACHE_ENDPOINT = 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';
  var SEND_INTERVAL = 5000;
  var DEBUG = true;
  var pendingData = {};
  var lastKnownSymbol = ''; // Track currently viewed symbol

  function log() {
    if (DEBUG) console.log.apply(console, ['[ApexTrade Relay]'].concat(Array.prototype.slice.call(arguments)));
  }

  log('Script starting in page context...');

  // ── Intercept WebSocket ──
  var OrigWebSocket = window.WebSocket;

  window.WebSocket = function () {
    var ws = new (Function.prototype.bind.apply(OrigWebSocket, [null].concat(Array.prototype.slice.call(arguments))))();
    var url = arguments[0] || '';

    if (url.indexOf('tradingview.com') !== -1) {
      log('Hooked WebSocket:', url);
      ws.addEventListener('message', function (event) {
        try { parseWSMessage(event.data); } catch (e) {}
      });
    }
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  log('WebSocket interceptor installed');

  // ── Intercept XMLHttpRequest ──
  var origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._tvUrl = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
    if (this._tvUrl && this._tvUrl.indexOf('/history') !== -1) {
      log('XHR intercepted:', url);
      this.addEventListener('load', function () {
        try {
          var data = JSON.parse(this.responseText);
          if (data && data.t && data.s === 'ok') handleUDFData(data, this._tvUrl);
        } catch (e) {}
      });
    }
    return origXHROpen.apply(this, arguments);
  };
  log('XHR interceptor installed');

  // ── Intercept fetch ──
  var origFetch = window.fetch;
  window.fetch = function () {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
    var result = origFetch.apply(this, arguments);

    if (url.indexOf('/history') !== -1) {
      log('Fetch intercepted:', url);
      result.then(function (response) {
        var clone = response.clone();
        clone.json().then(function (data) {
          if (data && data.t && data.s === 'ok') handleUDFData(data, url);
        }).catch(function () {});
      }).catch(function () {});
    }
    return result;
  };
  log('Fetch interceptor installed');

  // ── Handle UDF format ──
  function handleUDFData(data, url) {
    var ticker = '';
    try {
      var u = new URL(url);
      ticker = u.searchParams.get('symbol') || '';
    } catch (e) {}
    if (!ticker) return;
    if (ticker.indexOf(':') !== -1) ticker = ticker.split(':').pop();
    ticker = ticker.replace(/\.AX$/i, '');
    if (!ticker) return;

    var candles = [];
    for (var i = 0; i < data.t.length; i++) {
      if (data.o[i] != null && data.c[i] != null) {
        candles.push({ t: data.t[i] * 1000, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v ? data.v[i] : 0 });
      }
    }
    if (candles.length > 0) {
      bufferCandles(ticker, candles);
      log('UDF: ' + candles.length + ' candles for ' + ticker);
    }
  }

  // ── Parse WebSocket messages ──
  function parseWSMessage(raw) {
    if (typeof raw !== 'string') return;
    var parts = raw.split(/~m~\d+~m~/);
    for (var i = 0; i < parts.length; i++) {
      var msg = parts[i];
      if (!msg || msg.charAt(0) !== '{') continue;
      try {
        var parsed = JSON.parse(msg);
        if (parsed.m === 'du' || parsed.m === 'timescale_update') {
          extractFromTV(parsed.p);
        }
        // Track symbol from resolve_symbol and series_loading messages
        if (parsed.m === 'symbol_resolved' || parsed.m === 'series_completed') {
          extractSymbolName(parsed.p);
        }
      } catch (e) {}
    }
    // Also look for symbol= patterns in the raw message for tracking
    var symMatch = raw.match(/symbol=([A-Z]+:[A-Z0-9.]+)/);
    if (symMatch) {
      var sym = symMatch[1];
      if (sym.indexOf(':') !== -1) sym = sym.split(':').pop();
      sym = sym.replace(/\.AX$/i, '');
      if (sym) lastKnownSymbol = sym;
    }
  }

  function extractSymbolName(params) {
    if (!Array.isArray(params)) return;
    for (var i = 0; i < params.length; i++) {
      var p = params[i];
      if (!p) continue;
      if (typeof p === 'string' && p.indexOf(':') !== -1) {
        var sym = p.split(':').pop().replace(/\.AX$/i, '');
        if (sym && /^[A-Z0-9]+$/.test(sym)) { lastKnownSymbol = sym; log('Symbol tracked: ' + sym); }
      }
      if (typeof p === 'object') {
        var name = p.short_name || p.name || p.symbol || '';
        if (name) {
          if (name.indexOf(':') !== -1) name = name.split(':').pop();
          name = name.replace(/\.AX$/i, '');
          if (name && /^[A-Z0-9]+$/.test(name)) { lastKnownSymbol = name; log('Symbol tracked: ' + name); }
        }
      }
    }
  }

  function extractFromTV(params) {
    if (!Array.isArray(params)) return;
    for (var i = 0; i < params.length; i++) {
      if (params[i] && typeof params[i] === 'object') searchForSeries(params[i]);
    }
  }

  function searchForSeries(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.s && Array.isArray(obj.s) && obj.s.length > 0 && obj.s[0].v && obj.s[0].v.length >= 5) {
      processTVSeries(obj);
      return;
    }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var val = obj[keys[i]];
      if (val && typeof val === 'object') searchForSeries(val);
    }
  }

  function processTVSeries(seriesObj) {
    var ticker = '';

    // Try multiple locations for the symbol name
    if (seriesObj.ns) {
      ticker = seriesObj.ns.short_name || seriesObj.ns.name || seriesObj.ns.description || '';
    }
    if (!ticker && seriesObj.v && seriesObj.v.short_name) ticker = seriesObj.v.short_name;

    // Search the whole object for symbol-like strings
    if (!ticker) {
      var str = JSON.stringify(seriesObj);
      var m = str.match(/"(?:short_name|name|symbol)"\s*:\s*"([A-Z][A-Z0-9.:]*)"/);
      if (m) ticker = m[1];
    }

    // Fall back to last known symbol from the page
    if (!ticker && lastKnownSymbol) {
      ticker = lastKnownSymbol;
      log('Using lastKnownSymbol: ' + ticker);
    }

    var candles = [];
    for (var i = 0; i < seriesObj.s.length; i++) {
      var v = seriesObj.s[i].v;
      if (!v || v.length < 5) continue;
      candles.push({ t: v[0] * 1000, o: v[1], h: v[2], l: v[3], c: v[4], v: v[5] || 0 });
    }
    if (!candles.length) return;

    if (ticker.indexOf(':') !== -1) ticker = ticker.split(':').pop();
    ticker = ticker.replace(/\.AX$/i, '');

    if (!ticker) { log('WS: ' + candles.length + ' candles but no ticker'); return; }

    bufferCandles(ticker, candles);
    log('WS: ' + candles.length + ' candles for ' + ticker);
  }

  // ── Buffer ──
  function bufferCandles(ticker, candles) {
    if (!pendingData[ticker]) pendingData[ticker] = { candles: [] };
    var map = {};
    var existing = pendingData[ticker].candles;
    for (var i = 0; i < existing.length; i++) map[existing[i].t] = existing[i];
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
      var ticker = tickers[i];
      var data = pendingData[ticker];
      if (!data.candles.length) continue;
      log('Sending ' + data.candles.length + ' candles for ' + ticker);
      origFetch(CACHE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker, exchange: 'ASX', candles: data.candles, source: 'tradingview', timestamp: Date.now() }),
        mode: 'cors',
      }).then(function (r) { log('Sent OK: ' + r.status); }).catch(function (e) { log('Send error: ' + e.message); });
    }
    for (var key in pendingData) delete pendingData[key];
  }

  // ── Badge ──
  function addBadge() {
    if (document.getElementById('apextrade-relay-badge')) return;
    var b = document.createElement('div');
    b.id = 'apextrade-relay-badge';
    b.textContent = 'ApexTrade Relay';
    b.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;background:#1a1a2e;color:#00d4aa;border:1px solid #00d4aa;padding:4px 10px;border-radius:12px;font-size:11px;font-family:-apple-system,sans-serif;cursor:pointer;opacity:0.7;';
    b.onclick = function () {
      var t = Object.keys(pendingData), total = 0;
      for (var i = 0; i < t.length; i++) total += pendingData[t[i]].candles.length;
      alert('ApexTrade Relay v1.1\n\nBuffered: ' + t.length + ' tickers, ' + total + ' candles\nEndpoint: ' + CACHE_ENDPOINT);
    };
    document.body.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBadge);
  else addBadge();
  setTimeout(addBadge, 3000);

  // ── Track symbol from page DOM ──
  setInterval(function () {
    try {
      // TV shows the symbol in the header
      var el = document.querySelector('[data-symbol-short]');
      if (el) {
        var s = el.getAttribute('data-symbol-short') || el.textContent.trim();
        if (s && s.indexOf(':') !== -1) s = s.split(':').pop();
        s = s.replace(/\.AX$/i, '');
        if (s && /^[A-Z0-9]+$/.test(s)) lastKnownSymbol = s;
      }
      // Also try the chart header text
      if (!lastKnownSymbol) {
        var hdr = document.querySelector('.chart-controls-bar .apply-common-tooltip');
        if (hdr) {
          var txt = hdr.textContent.trim().split(/[\s·]/)[0];
          if (txt.indexOf(':') !== -1) txt = txt.split(':').pop();
          txt = txt.replace(/\.AX$/i, '');
          if (txt && /^[A-Z0-9]+$/.test(txt)) lastKnownSymbol = txt;
        }
      }
    } catch (e) {}
  }, 2000);

  // ── AUTO-CYCLE: automatically rotate through ASX tickers ──
  var autoCycleEnabled = false;
  var autoCycleIndex = 0;
  var autoCycleList = [];
  var autoCycleInterval = null;
  var CYCLE_DELAY = 8000; // 8 seconds per ticker (enough for WS data to load)
  var ASX_LIST_URL = 'https://apextrade-proxy.netlify.app/.netlify/functions/asx-list';

  function changeSymbol(ticker) {
    // Use TradingView's internal widget API to change the chart symbol
    try {
      // Method 1: TV's internal navigation
      var symbolInput = document.querySelector('#header-toolbar-symbol-search');
      if (symbolInput) {
        symbolInput.click();
        setTimeout(function () {
          var input = document.querySelector('input[data-role="search"]') || document.querySelector('.search-ZXzPWcCf input') || document.querySelector('input[type="text"]');
          if (input) {
            input.value = '';
            input.focus();
            // Simulate typing
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, 'ASX:' + ticker);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Wait for search results then press Enter
            setTimeout(function () {
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            }, 1500);
          }
        }, 500);
        return;
      }

      // Method 2: URL navigation (simpler fallback)
      var currentUrl = window.location.href;
      if (currentUrl.indexOf('/chart/') !== -1) {
        // Change symbol via URL param
        var base = currentUrl.split('?')[0];
        window.location.href = base + '?symbol=ASX%3A' + ticker;
      }
    } catch (e) {
      log('Symbol change failed: ' + e.message);
    }
  }

  function startAutoCycle() {
    if (autoCycleEnabled) return;
    autoCycleEnabled = true;
    log('Auto-cycle: fetching ASX ticker list...');

    origFetch(ASX_LIST_URL).then(function (r) { return r.json(); }).then(function (data) {
      if (data.tickers && Array.isArray(data.tickers)) {
        autoCycleList = data.tickers.map(function (t) { return t.ticker || t; });
      } else if (Array.isArray(data)) {
        autoCycleList = data.map(function (t) { return t.ticker || t; });
      }
      log('Auto-cycle: loaded ' + autoCycleList.length + ' tickers');
      updateBadge();

      autoCycleInterval = setInterval(function () {
        if (autoCycleIndex >= autoCycleList.length) {
          log('Auto-cycle: completed all ' + autoCycleList.length + ' tickers!');
          stopAutoCycle();
          return;
        }
        var ticker = autoCycleList[autoCycleIndex];
        log('Auto-cycle: [' + (autoCycleIndex + 1) + '/' + autoCycleList.length + '] ' + ticker);
        changeSymbol(ticker);
        autoCycleIndex++;
        updateBadge();
      }, CYCLE_DELAY);
    }).catch(function (e) {
      log('Auto-cycle: failed to load tickers: ' + e.message);
      autoCycleEnabled = false;
    });
  }

  function stopAutoCycle() {
    autoCycleEnabled = false;
    if (autoCycleInterval) clearInterval(autoCycleInterval);
    autoCycleInterval = null;
    updateBadge();
    log('Auto-cycle stopped at index ' + autoCycleIndex);
  }

  function updateBadge() {
    var b = document.getElementById('apextrade-relay-badge');
    if (!b) return;
    if (autoCycleEnabled) {
      b.textContent = 'Relay: Cycling ' + autoCycleIndex + '/' + autoCycleList.length;
      b.style.color = '#ffaa00';
      b.style.borderColor = '#ffaa00';
    } else {
      b.textContent = 'ApexTrade Relay';
      b.style.color = '#00d4aa';
      b.style.borderColor = '#00d4aa';
    }
  }

  // Override badge click to toggle auto-cycle
  function addBadgeV2() {
    var b = document.getElementById('apextrade-relay-badge');
    if (!b) { setTimeout(addBadgeV2, 1000); return; }
    b.onclick = function () {
      if (autoCycleEnabled) {
        stopAutoCycle();
        alert('Auto-cycle stopped at ticker ' + autoCycleIndex + '/' + autoCycleList.length);
      } else {
        var t = Object.keys(pendingData), total = 0;
        for (var i = 0; i < t.length; i++) total += pendingData[t[i]].candles.length;
        if (confirm('ApexTrade Relay v1.3\n\nBuffered: ' + t.length + ' tickers, ' + total + ' candles\n\nStart AUTO-CYCLE through all ASX tickers?\n(Click OK to start, Cancel to dismiss)')) {
          startAutoCycle();
        }
      }
    };
  }
  setTimeout(addBadgeV2, 4000);

  log('ApexTrade TV Relay v1.3 loaded — click badge to start auto-cycle');
})();
