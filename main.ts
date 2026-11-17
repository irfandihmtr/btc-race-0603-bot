// Kandidat D5 — beli dip dalam vs EMA-120 + tahan 12 jam (keluarga D).
// Alasan desain (bukan scan parameter): ambang dibentuk dari biaya + noise.
//   Round-trip all-in ~36 bps -> ambang harus >2x biaya: 0,7-0,8%.
//   Noise 1 menit SD 0,064% -> 0,7% = ~11 SD, jauh di atas noise.
//   Maka entry hanya saat harga teregang >=0,8% DI BAWAH EMA-120 (tren 2 jam)
//   — dip yang nyata, bukan wiggle — ditambah konfirmasi 1 bar naik.
//   CATATAN: ambang 0,8% di D3 gagal 0 trade (dev min terukur -0,7985%,
//   selisih 0,0015 pp); 0,7% adalah koreksi di batas yang sama —
//   dilaporkan apa adanya sebagai varian, bukan hasil scan ambang.
//   Exit: D4 membuktikan trailing 0,6% membunuh entry dip — harga retest
//   low (h08 min $63.974, -0,6% dari entry) TEPAT sebelum kaki naik.
//   Maka exit hanya: time-stop 720 bar (12 jam) ATAU close 1,5% di bawah
//   EMA-120 (regime break; di dev tak pernah tersentuh: dev min -0,80%).
//   Ukuran 100%: kaki yang ditarget >=1,5% vs biaya ~0,45%/round-trip.
//   Satu posisi, cooldown 120 bar sesudah exit (boleh entry ulang di dip
//   berikutnya — window ini punya 2 dip dalam).
//
// Tanpa wall clock, tanpa file luar repo, tanpa Math.random — deterministik
// dari bar yang dikirim harness (hello/batch). Order: buy
// notional_quote_units, sell qty; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const EMA_N = 120; // tren 2 jam
const STRETCH_PCT = 0.007; // >=0,7% di bawah EMA-120
const BREAK_PCT = 0.015; // 1,5% di bawah EMA-120 = regime break
const TIME_STOP_BARS = 720; // 12 jam
const COOLDOWN_BARS = 120;
const SIZE_BPS = 10000; // 100% ekuitas
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let ema: number | null = null;
let prevClose: number | null = null;
let entrySeq = -1;
let peakClose = 0;
let lastExitSeq = -1;
let trades = 0;

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;

    const prevEma = ema;
    const uptick = prevClose !== null && close > prevClose;
    const haveHistory = closes.length >= EMA_N && prevEma !== null;

    prevClose = close;
    closes.push(close);
    if (closes.length > EMA_N) closes.shift();
    ema = ema === null ? close : close * (2 / (EMA_N + 1)) + ema * (1 - 2 / (EMA_N + 1));

    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;

    if (qty > 0n) {
      // --- Di posisi: tahan kaki; keluar hanya time-stop / regime break. ---
      if (close > peakClose) peakClose = close;
      const timeUp = entrySeq >= 0 && state.seq - entrySeq >= TIME_STOP_BARS;
      const regimeBreak = prevEma !== null && close < prevEma * (1 - BREAK_PCT);
      if (regimeBreak || timeUp) {
        lastExitSeq = state.seq;
        entrySeq = -1;
        trades += 1;
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Flat: beli dip dalam + konfirmasi naik 1 bar. ---
    if (!haveHistory || prevEma === null) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const stretched = close < prevEma * (1 - STRETCH_PCT);
    if (!stretched || !uptick) return [];

    let notional = (state.equity * BigInt(SIZE_BPS)) / 10000n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < 1_000_000n) return []; // di bawah min 1 USDC
    entrySeq = state.seq;
    peakClose = close;
    trades += 1;
    return [{ side: "buy", symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
  onDone(_state: BarsState) {
    console.error(`kandidat-D3 selesai: trade yang diputuskan=${trades}`);
  },
});
