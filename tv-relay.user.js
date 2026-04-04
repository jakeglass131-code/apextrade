// ==UserScript==
// @name         ApexTrade TV Relay
// @namespace    https://apextrade-proxy.netlify.app
// @version      2.0
// @description  Fetches TradingView candle data for all ASX tickers and caches it
// @match        https://www.tradingview.com/*
// @match        https://tradingview.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var CACHE_URL = 'https://apextrade-proxy.netlify.app/.netlify/functions/cache';
  var ASX_URL = 'https://apextrade-proxy.netlify.app/.netlify/functions/asx-list';
  var DELAY = 3000; // 3 seconds between fetches
  var running = false;
  var index = 0;
  var tickers = [];
  var fetched = 0;
  var errors = 0;

  function log(msg) { console.log('[ApexTrade Relay] ' + msg); }

  // Fetch candle data directly from TradingView's UDF API
  function fetchTVCandles(ticker) {
    var sym = 'ASX:' + ticker;
    var from = Math.floor(Date.now() / 1000) - (6 * 365 * 86400); // 6 years
    var to = Math.floor(Date.now() / 1000);
    var url = 'https://data.tradingview.com/history?symbol=' + encodeURIComponent(sym) + '&resolution=D&from=' + from + '&to=' + to;

    return fetch(url, {
      headers: { 'Accept': 'application/json' },
      credentials: 'include' // use TV session cookies
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || data.s !== 'ok' || !data.t || !data.t.length) return null;
      var candles = [];
      for (var i = 0; i < data.t.length; i++) {
        if (data.o[i] != null && data.c[i] != null) {
          candles.push({ t: data.t[i] * 1000, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v ? data.v[i] : 0 });
        }
      }
      return candles;
    });
  }

  function sendToCache(ticker, candles) {
    return fetch(CACHE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: ticker, exchange: 'ASX', candles: candles, source: 'tradingview', timestamp: Date.now() }),
    }).then(function (r) { return r.json(); });
  }

  function processNext() {
    if (!running || index >= tickers.length) {
      running = false;
      updateBadge();
      log('DONE! Fetched ' + fetched + ' tickers, ' + errors + ' errors');
      localStorage.removeItem('apextrade_bg_index');
      return;
    }

    var ticker = tickers[index];
    index++;
    localStorage.setItem('apextrade_bg_index', index);
    updateBadge();

    fetchTVCandles(ticker).then(function (candles) {
      if (candles && candles.length > 0) {
        return sendToCache(ticker, candles).then(function () {
          fetched++;
          log('[' + index + '/' + tickers.length + '] ' + ticker + ': ' + candles.length + ' candles cached');
        });
      } else {
        errors++;
        log('[' + index + '/' + tickers.length + '] ' + ticker + ': no data');
      }
    }).catch(function (e) {
      errors++;
      log('[' + index + '/' + tickers.length + '] ' + ticker + ': ERROR ' + e.message);
    }).finally(function () {
      setTimeout(processNext, DELAY);
    });
  }

  function start() {
    if (running) return;
    running = true;
    log('Fetching ASX ticker list...');

    fetch(ASX_URL).then(function (r) { return r.json(); }).then(function (data) {
      tickers = (data.stocks || data.tickers || data || []).map(function (t) { return t.ticker || t; });
      log('Loaded ' + tickers.length + ' tickers');

      // Resume from saved position
      var saved = parseInt(localStorage.getItem('apextrade_bg_index') || '0');
      if (saved > 0 && saved < tickers.length) {
        index = saved;
        log('Resuming from index ' + index);
      }

      updateBadge();
      processNext();
    }).catch(function (e) {
      log('Failed to load ticker list: ' + e.message);
      running = false;
    });
  }

  function stop() {
    running = false;
    updateBadge();
    log('Stopped at ' + index + '/' + tickers.length);
  }

  // Badge
  function addBadge() {
    var b = document.createElement('div');
    b.id = 'apextrade-relay-badge';
    b.textContent = 'ApexTrade Relay';
    b.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;background:#1a1a2e;color:#00d4aa;border:1px solid #00d4aa;padding:6px 12px;border-radius:12px;font-size:12px;font-family:-apple-system,sans-serif;cursor:pointer;opacity:0.8;';
    b.onclick = function () {
      if (running) {
        stop();
      } else {
        if (confirm('Start background fetch of all ASX tickers?\n\nThis fetches candle data directly from TradingView servers.\nNo need to change charts — runs silently in the background.\n\nProgress: ' + index + '/' + (tickers.length || '?'))) {
          start();
        }
      }
    };
    document.body.appendChild(b);
  }

  function updateBadge() {
    var b = document.getElementById('apextrade-relay-badge');
    if (!b) return;
    if (running) {
      b.textContent = 'Relay: ' + index + '/' + tickers.length + ' (' + fetched + ' ok)';
      b.style.color = '#ffaa00';
      b.style.borderColor = '#ffaa00';
    } else if (index >= tickers.length && tickers.length > 0) {
      b.textContent = 'Relay: DONE (' + fetched + ' tickers)';
      b.style.color = '#00ff88';
      b.style.borderColor = '#00ff88';
    } else {
      b.textContent = 'ApexTrade Relay';
      b.style.color = '#00d4aa';
      b.style.borderColor = '#00d4aa';
    }
  }

  // Auto-start if was running before page reload
  setTimeout(function () {
    addBadge();
    var saved = parseInt(localStorage.getItem('apextrade_bg_index') || '0');
    if (saved > 0) {
      log('Previous session detected at index ' + saved + ', auto-resuming...');
      start();
    }
  }, 3000);

  log('ApexTrade TV Relay v2.0 loaded — click badge to start');
})();
