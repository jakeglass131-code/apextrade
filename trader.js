#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// ApexTrade Local Trader — Fetches signal from API, executes on IG Markets
// ═══════════════════════════════════════════════════════════════════════════════
// Runs locally on your machine (IG blocks cloud IPs, but allows home IPs)
//
// Usage:
//   node trader.js                          — fetch signal + execute trade
//   node trader.js --signal-only            — just show signal, don't trade
//   node trader.js --close                  — close all ASX positions
//
// Setup:
//   Set these environment variables (or edit the CONFIG section below):
//     IG_API_KEY, IG_USERNAME, IG_PASSWORD
//
// Schedule (Windows Task Scheduler or Mac crontab):
//   Runs daily at 9:00am AEST before ASX open
// ═══════════════════════════════════════════════════════════════════════════════

// ── CONFIG — edit these with your IG credentials ──────────────────────────────
const CONFIG = {
  IG_API_KEY:  process.env.IG_API_KEY  || 'PASTE_YOUR_API_KEY_HERE',
  IG_USERNAME: process.env.IG_USERNAME || 'PASTE_YOUR_USERNAME_HERE',
  IG_PASSWORD: process.env.IG_PASSWORD || 'PASTE_YOUR_PASSWORD_HERE',
  IS_DEMO:     false,  // set to true to use demo account
  SIGNAL_URL:  'https://apextrade-proxy.netlify.app/.netlify/functions/auto-trade',
  ASX_EPIC:    'IX.D.ASX.IFM.IP', // ASX 200 Cash CFD on IG
  MAX_DAILY_LOSS_PCT: 5, // auto-stop if account drops 5% in a day
};

const IG_LIVE_URL = 'https://api-live.ig.com/gateway/deal';
const IG_DEMO_URL = 'https://demo-api.ig.com/gateway/deal';

// ═══════════════════════════════════════════════════════════════════════════════
// IG MARKETS API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

class IGClient {
  constructor() {
    this.baseUrl = CONFIG.IS_DEMO ? IG_DEMO_URL : IG_LIVE_URL;
    this.cst = null;
    this.securityToken = null;
    this.oauthToken = null;
    this.accountId = null;
  }

  async login() {
    console.log(`\n🔗 Connecting to IG Markets (${CONFIG.IS_DEMO ? 'DEMO' : 'LIVE'})...`);

    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json; charset=UTF-8',
        'X-IG-API-KEY': CONFIG.IG_API_KEY,
        'VERSION': '3',
      },
      body: JSON.stringify({
        identifier: CONFIG.IG_USERNAME,
        password: CONFIG.IG_PASSWORD,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      // Try v2 if v3 fails
      console.log(`  v3 failed (${res.status}), trying v2...`);
      const res2 = await fetch(`${this.baseUrl}/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json; charset=UTF-8',
          'X-IG-API-KEY': CONFIG.IG_API_KEY,
          'VERSION': '2',
        },
        body: JSON.stringify({
          identifier: CONFIG.IG_USERNAME,
          password: CONFIG.IG_PASSWORD,
        }),
      });
      if (!res2.ok) {
        const err2 = await res2.text();
        throw new Error(`IG login failed: v3=${err}, v2=${err2}`);
      }
      this.cst = res2.headers.get('CST');
      this.securityToken = res2.headers.get('X-SECURITY-TOKEN');
      const data = await res2.json();
      this.accountId = data.currentAccountId;
      console.log(`  ✅ Logged in (v2) — Account: ${this.accountId}`);
      return data;
    }

    const data = await res.json();
    if (data.oauthToken) {
      this.oauthToken = data.oauthToken;
    } else {
      this.cst = res.headers.get('CST');
      this.securityToken = res.headers.get('X-SECURITY-TOKEN');
    }
    this.accountId = data.currentAccountId || data.accountId;
    console.log(`  ✅ Logged in (v3) — Account: ${this.accountId}`);
    return data;
  }

  getHeaders(version = '2') {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json; charset=UTF-8',
      'X-IG-API-KEY': CONFIG.IG_API_KEY,
      'VERSION': version,
    };
    if (this.oauthToken) {
      headers['Authorization'] = `Bearer ${this.oauthToken.access_token}`;
      headers['IG-ACCOUNT-ID'] = this.accountId;
    } else {
      if (this.cst) headers['CST'] = this.cst;
      if (this.securityToken) headers['X-SECURITY-TOKEN'] = this.securityToken;
    }
    return headers;
  }

  async getAccounts() {
    const res = await fetch(`${this.baseUrl}/accounts`, { headers: this.getHeaders('1') });
    if (!res.ok) throw new Error(`IG accounts: ${res.status}`);
    return res.json();
  }

  async getPositions() {
    const res = await fetch(`${this.baseUrl}/positions`, { headers: this.getHeaders('2') });
    if (!res.ok) throw new Error(`IG positions: ${res.status}`);
    return res.json();
  }

  async getMarketInfo(epic = CONFIG.ASX_EPIC) {
    const res = await fetch(`${this.baseUrl}/markets/${epic}`, { headers: this.getHeaders('3') });
    if (!res.ok) throw new Error(`IG market info: ${res.status}`);
    return res.json();
  }

  async closePosition(dealId, direction, size) {
    const res = await fetch(`${this.baseUrl}/positions/otc`, {
      method: 'POST',
      headers: { ...this.getHeaders('1'), '_method': 'DELETE' },
      body: JSON.stringify({
        dealId,
        direction: direction === 'BUY' ? 'SELL' : 'BUY',
        size: size.toString(),
        orderType: 'MARKET',
      }),
    });
    if (!res.ok) throw new Error(`IG close: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async openPosition(direction, size, epic = CONFIG.ASX_EPIC) {
    const res = await fetch(`${this.baseUrl}/positions/otc`, {
      method: 'POST',
      headers: this.getHeaders('2'),
      body: JSON.stringify({
        epic,
        direction,
        size: size.toString(),
        orderType: 'MARKET',
        currencyCode: 'AUD',
        forceOpen: true,
        guaranteedStop: false,
        expiry: 'DFB',
      }),
    });
    if (!res.ok) throw new Error(`IG open: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async confirmDeal(dealReference) {
    const res = await fetch(`${this.baseUrl}/confirms/${dealReference}`, { headers: this.getHeaders('1') });
    if (!res.ok) throw new Error(`IG confirm: ${res.status}`);
    return res.json();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const signalOnly = args.includes('--signal-only');
  const closeAll = args.includes('--close');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' ApexTrade Local Trader');
  console.log(` ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} AEST`);
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Step 1: Fetch signal from Netlify API ─────────────────────────────
  console.log('\n📡 Fetching signal from ApexTrade API...');
  let signal;
  try {
    const res = await fetch(CONFIG.SIGNAL_URL);
    const data = await res.json();
    signal = data.signal;

    if (!signal) {
      console.error('❌ No signal in API response:', JSON.stringify(data).slice(0, 200));
      process.exit(1);
    }

    console.log(`\n  ┌─────────────────────────────────────┐`);
    console.log(`  │  SIGNAL: ${signal.direction.padEnd(8)} Score: ${signal.score.toFixed(4).padStart(7)} │`);
    console.log(`  │  Regime: ${signal.regime.padEnd(16)} Crisis: ${signal.crisis ? 'YES' : 'No '}  │`);
    console.log(`  │  Leverage: ${signal.leverage}x                       │`);
    console.log(`  │  Action: ${(signal.direction === 'BULL' ? 'BUY' : signal.direction === 'BEAR' ? 'SELL' : 'CLOSE').padEnd(28)} │`);
    console.log(`  └─────────────────────────────────────┘`);
  } catch (e) {
    console.error(`❌ Failed to fetch signal: ${e.message}`);
    process.exit(1);
  }

  if (signalOnly) {
    console.log('\n--signal-only flag set. Exiting without trading.');
    process.exit(0);
  }

  // ── Step 2: Connect to IG Markets ─────────────────────────────────────
  if (CONFIG.IG_API_KEY === 'PASTE_YOUR_API_KEY_HERE') {
    console.error('\n❌ You need to edit trader.js and paste your IG credentials in the CONFIG section.');
    console.error('   Or set environment variables: IG_API_KEY, IG_USERNAME, IG_PASSWORD');
    process.exit(1);
  }

  const ig = new IGClient();
  await ig.login();

  // ── Step 3: Get account info ──────────────────────────────────────────
  const accounts = await ig.getAccounts();
  const account = accounts.accounts?.find(a => a.accountId === ig.accountId);
  const balance = account?.balance?.balance || 0;
  const available = account?.balance?.available || 0;
  const todayPnl = account?.balance?.profitLoss || 0;

  console.log(`\n💰 Account Balance: $${balance.toFixed(2)}`);
  console.log(`   Available:       $${available.toFixed(2)}`);
  console.log(`   Today P&L:       $${todayPnl.toFixed(2)}`);

  // Safety check: max daily loss
  const maxLoss = balance * (CONFIG.MAX_DAILY_LOSS_PCT / 100);
  if (todayPnl < -maxLoss) {
    console.error(`\n⛔ DAILY LOSS LIMIT HIT: $${todayPnl.toFixed(2)} (limit: -$${maxLoss.toFixed(2)})`);
    console.error('   Auto-trading disabled for today. Manual override only.');
    process.exit(1);
  }

  // ── Step 4: Check current positions ───────────────────────────────────
  const positions = await ig.getPositions();
  const asxPositions = positions.positions?.filter(p =>
    p.market?.epic === CONFIG.ASX_EPIC || p.market?.instrumentName?.includes('Australia 200')
  ) || [];

  console.log(`\n📊 Current ASX positions: ${asxPositions.length}`);
  for (const pos of asxPositions) {
    console.log(`   ${pos.position.direction} ${pos.position.size} contracts @ ${pos.position.openLevel}`);
  }

  // ── Close all mode ────────────────────────────────────────────────────
  if (closeAll) {
    if (asxPositions.length === 0) {
      console.log('\n  No positions to close.');
      process.exit(0);
    }
    for (const pos of asxPositions) {
      console.log(`\n🔴 Closing ${pos.position.direction} ${pos.position.size} contracts...`);
      const result = await ig.closePosition(pos.position.dealId, pos.position.direction, pos.position.size);
      const confirm = await ig.confirmDeal(result.dealReference);
      console.log(`   ${confirm.dealStatus} — ${confirm.reason || 'OK'}`);
    }
    console.log('\n✅ All positions closed.');
    process.exit(0);
  }

  // ── Step 5: Execute trade ─────────────────────────────────────────────
  const igDirection = signal.direction === 'BULL' ? 'BUY' : signal.direction === 'BEAR' ? 'SELL' : null;

  // Get market info for sizing
  const marketInfo = await ig.getMarketInfo();
  const minSize = marketInfo.dealingRules?.minDealSize?.value || 1;
  const asxPrice = marketInfo.snapshot?.bid || 8000;
  const marginFactor = parseFloat(marketInfo.instrument?.marginFactor || 5) / 100;

  console.log(`\n📈 ASX 200: ${asxPrice} | Min size: ${minSize} | Margin: ${(marginFactor*100).toFixed(1)}%`);

  // Position sizing: max contracts affordable with leverage
  const targetExposure = available * signal.leverage;
  let size = Math.floor(available / (marginFactor * asxPrice));
  size = Math.max(minSize, Math.min(size, Math.floor(targetExposure / (marginFactor * asxPrice))));

  if (signal.direction === 'NEUTRAL') {
    if (asxPositions.length > 0) {
      console.log('\n⚪ NEUTRAL — closing existing positions');
      for (const pos of asxPositions) {
        const result = await ig.closePosition(pos.position.dealId, pos.position.direction, pos.position.size);
        const confirm = await ig.confirmDeal(result.dealReference);
        console.log(`   Closed: ${confirm.dealStatus} (${confirm.reason || 'OK'})`);
      }
    } else {
      console.log('\n⚪ NEUTRAL — no position, sitting out today');
    }
  } else {
    const currentDir = asxPositions.length > 0 ? asxPositions[0].position.direction : null;
    const needsFlip = currentDir && currentDir !== igDirection;
    const needsOpen = !currentDir;

    if (needsFlip) {
      console.log(`\n🔄 Flipping from ${currentDir} to ${igDirection}`);
      for (const pos of asxPositions) {
        const result = await ig.closePosition(pos.position.dealId, pos.position.direction, pos.position.size);
        const confirm = await ig.confirmDeal(result.dealReference);
        console.log(`   Closed old: ${confirm.dealStatus}`);
      }
    }

    if (needsFlip || needsOpen) {
      console.log(`\n📈 Opening ${igDirection} — ${size} contracts (${signal.leverage}x leverage)`);
      const result = await ig.openPosition(igDirection, size);
      const confirm = await ig.confirmDeal(result.dealReference);

      if (confirm.dealStatus === 'ACCEPTED') {
        console.log(`   ✅ FILLED at ${confirm.level}`);
        console.log(`   Deal ID: ${confirm.dealId}`);
      } else {
        console.log(`   ❌ REJECTED: ${confirm.reason}`);
      }
    } else {
      const currentSize = asxPositions.reduce((a, p) => a + p.position.size, 0);
      console.log(`\n  Already ${igDirection} with ${currentSize} contracts — holding position`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' Trade execution complete');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error(`\n❌ FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
