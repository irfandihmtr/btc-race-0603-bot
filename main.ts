// Kandidat B-final — quasi buy-and-hold + filter rezim (versi panel B).
// Satu-satunya keluarga positif terukur di window ini adalah beli-sekali +
// tahan-sampai-akhir (buy-and-hold +$1,07; momentum +$2,45; keduanya 1 trade).
// Semua strategi aktif (A/E/D) kalah oleh mean-reversion + biaya ~36 bps.
// Maka B: SATU entry awal, lalu tahan sampai akhir (harness flatten).
//
// Entry fase 1 (bar 120-480): beli dip — close pernah >=0,5% di bawah high
//   120 bar terakhir (dipArmed), lalu close kembali di atas EMA-20 (recovery).
// Entry fase 2 (bar 480-960, bila masih flat): close > EMA-60 (tren naik).
// Ukuran 100% ekuitas: satu trade saja, dan hitungan biaya menunjukkan
//   50% tak bisa mencapai target +$3 di window ini (penyimpangan sadar
//   dari panduan 30-50% brief, dicatat di laporan).
// Exit: tidak ada — tahan sampai akhir window.
// Tanpa wall clock, tanpa file luar repo, tanpa Math.random — deterministik
// dari bar yang dikirim harness (hello/batch). Order: buy
// notional_quote_units; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const HIGH_N = 120;
const EMA_FAST = 20;
const EMA_SLOW = 60;
const DIP_PCT = 0.005; // >=0,5% di bawah high 120 bar
const PHASE1_END = 480; // 8 jam
const PHASE2_END = 960; // 16 jam
const SIZE_BPS = 10000; // 100% ekuitas, satu entry
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const highs: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let dipArmed = false;
let bought = false;
let trades = 0;

function high120(): number {
  let m = -Infinity;
  for (const h of highs) if (h > m) m = h;
  return m;
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;
    const high = Number(bar.h) / PRICE_SCALE;

    const prevHigh = highs.length >= HIGH_N ? high120() : -Infinity;
    const prevFast = emaFast;
    const prevSlow = emaSlow;

    closes.push(close);
    highs.push(high);
    if (closes.length > HIGH_N) {
      closes.shift();
      highs.shift();
    }
    emaFast = emaFast === null ? close : close * (2 / (EMA_FAST + 1)) + emaFast * (1 - 2 / (EMA_FAST + 1));
    emaSlow = emaSlow === null ? close : close * (2 / (EMA_SLOW + 1)) + emaSlow * (1 - 2 / (EMA_SLOW + 1));

    if (state.warmingUp) return [];
    if (bought) return [];
    const pos = state.positions.get(SYMBOL);
    if ((pos?.qty ?? 0n) > 0n) {
      bought = true;
      return [];
    }
    if (closes.length < HIGH_N || prevFast === null || prevSlow === null) return [];

    // Tandai dip: close >=0,5% di bawah high 120 bar.
    if (close < prevHigh * (1 - DIP_PCT)) dipArmed = true;

    let signal = false;
    if (state.seq <= PHASE1_END) {
      signal = dipArmed && close > prevFast;
    } else if (state.seq <= PHASE2_END) {
      signal = close > prevSlow;
    }
    if (!signal) return [];

    let notional = (state.equity * BigInt(SIZE_BPS)) / 10000n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < 1_000_000n) return []; // di bawah min 1 USDC
    bought = true;
    trades += 1;
    return [{ side: "buy", symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
  onDone(_state: BarsState) {
    console.error(`kandidat-B-final selesai: trade yang diputuskan=${trades}`);
  },
});
