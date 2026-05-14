'use strict';
/**
 * Crypto Pulse — built-in Horizon plugin.
 * Public CoinGecko API, no key needed. Free tier rate-limit is ~30 req/min
 * which is far above what an interactive AI agent would burn through.
 */
const fetch = require('node-fetch');

const BASE = 'https://api.coingecko.com/api/v3';
const TIMEOUT_MS = 12000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after ' + ms + 'ms')), ms)),
  ]);
}

async function get(pathAndQuery) {
  const url = `${BASE}${pathAndQuery}`;
  const res = await withTimeout(fetch(url, {
    headers: {
      'User-Agent': 'Horizon AI / crypto-pulse plugin',
      'Accept': 'application/json',
    },
  }), TIMEOUT_MS);
  if (!res.ok) throw new Error(`CoinGecko ${res.status} ${res.statusText}`);
  return res.json();
}

function fmtUsd(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return '$' + n.toFixed(4);
  if (n >= 0.01) return '$' + n.toFixed(6);
  return '$' + n.toExponential(3);
}

function fmtPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

module.exports = {
  async execute(tool, args = {}) {
    if (tool === 'price') {
      const coin = String(args.coin || 'bitcoin').toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!coin) return { ok: false, error: 'coin id is required (e.g. "bitcoin")' };
      try {
        const d = await get(`/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
        const entry = d[coin];
        if (!entry || entry.usd == null) return { ok: false, error: `No data for "${coin}". Use a valid CoinGecko id.` };
        return {
          ok: true,
          out: `${coin.toUpperCase()}: ${fmtUsd(entry.usd)} (24h ${fmtPct(entry.usd_24h_change)})  ·  cap ${fmtUsd(entry.usd_market_cap)}`,
          coin,
          usd: entry.usd,
          change_24h_pct: entry.usd_24h_change,
          market_cap: entry.usd_market_cap,
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (tool === 'top_movers') {
      try {
        const d = await get('/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h');
        if (!Array.isArray(d) || !d.length) return { ok: false, error: 'CoinGecko returned no data' };
        const lines = d.map((c, i) =>
          `${String(i + 1).padStart(2)}. ${c.symbol.toUpperCase().padEnd(6)} ${fmtPct(c.price_change_percentage_24h).padStart(8)}  ${fmtUsd(c.current_price)}  (${c.name})`
        );
        return {
          ok: true,
          out: 'Top 10 gainers (24h):\n' + lines.join('\n'),
          movers: d.map(c => ({
            id: c.id,
            symbol: c.symbol,
            name: c.name,
            price_usd: c.current_price,
            change_24h_pct: c.price_change_percentage_24h,
          })),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    if (tool === 'global') {
      try {
        const d = await get('/global');
        const g = d?.data || {};
        const totalCap = g.total_market_cap?.usd ?? 0;
        const totalVol = g.total_volume?.usd ?? 0;
        const btcDom = g.market_cap_percentage?.btc ?? 0;
        const ethDom = g.market_cap_percentage?.eth ?? 0;
        return {
          ok: true,
          out: [
            `Total market cap: ${fmtUsd(totalCap)}`,
            `24h volume:       ${fmtUsd(totalVol)}`,
            `BTC dominance:    ${btcDom.toFixed(2)}%`,
            `ETH dominance:    ${ethDom.toFixed(2)}%`,
            `Active coins:     ${g.active_cryptocurrencies ?? '—'}`,
            `Markets:          ${g.markets ?? '—'}`,
          ].join('\n'),
          stats: {
            market_cap_usd: totalCap,
            volume_24h_usd: totalVol,
            btc_dominance_pct: btcDom,
            eth_dominance_pct: ethDom,
            active_coins: g.active_cryptocurrencies,
            markets: g.markets,
          },
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }

    return { ok: false, error: `Unknown tool: ${tool}` };
  },
};
