// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      1.1
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
    this._tvUrl = url;
    if (url && url.indexOf('/history') !== -1) {
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
      } catch (e) {}
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
    if (seriesObj.ns) ticker = seriesObj.ns.short_name || seriesObj.ns.name || '';

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

  log('ApexTrade TV Relay v1.1 loaded');
})();
