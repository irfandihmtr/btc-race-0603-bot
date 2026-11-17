// Kandidat B2 — quasi buy-and-hold, horizon 1 jam (varian B-final).
// B-final dev -$0,32 (1 trade, entry bar 120-179 di h02 ~$64,700): selisih
// tipis dari gerbang. Varian ini memendekkan lookback dip ke 60 bar (1 jam)
// supaya sinyal recovery pertama di h00-h01 tidak terlewat menunggu
// histori 120 bar — entry lebih awal di harga lebih rendah adalah inti
// buy-and-hold, bukan tuning per-bar. Sisanya identik B-final: satu entry
// awal, tahan sampai akhir, ukuran 100% ekuitas.
//
// Entry fase 1 (bar 60-480): close pernah >=0,5% di bawah high 60 bar,
//   lalu close kembali di atas EMA-20. Fase 2 (480-960): close > EMA-60.
// Exit: tidak ada — tahan sampai akhir window.
// Tanpa wall clock, tanpa file luar repo, tanpa Math.random — deterministik
// dari bar yang dikirim harness (hello/batch). Order: buy
// notional_quote_units; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const HIGH_N = 60;
const EMA_FAST = 20;
const EMA_SLOW = 60;
const DIP_PCT = 0.005; // >=0,5% di bawah high 60 bar
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

function highN(): number {
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

    const prevHigh = highs.length >= HIGH_N ? highN() : -Infinity;
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

    // Tandai dip: close >=0,5% di bawah high 60 bar.
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
    console.error(`kandidat-B2 selesai: trade yang diputuskan=${trades}`);
  },
});
