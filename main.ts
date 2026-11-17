// Kandidat A2 — Donchian breakout + filter EMA lambat + trailing ATR.
// Revisi A1: A1 rugi -$7,74 (16 trade, win rate 0) karena trailing 2.5*ATR
// memakai ATR dari (high-low) bar — di pool ini bar sering flat, ATR ~$31,
// trailing ~$78 = 0,12% < noise 1 menit (SD 0,064% = ~$41) -> exit kena noise.
// Perbaikan: True Range (memakai close sebelumnya), trailing 0,6% harga
// (~9 SD gerak 1 menit), syarat breakout +0,15% di atas Donchian high,
// konfirmasi momentum 60 bar (+0,2%), cooldown 120 bar. Ukuran 50%.
//
// Long-only, turnover rendah. Entry: close menembus high 120 bar terakhir
// (Donchian 2 jam) + close di atas EMA-120. Exit: trailing stop lebar,
// close di bawah EMA-120, atau time-stop 480 bar. Tanpa wall clock,
// tanpa file luar repo, tanpa Math.random — deterministik dari bar
// yang dikirim harness (hello/batch). Order: buy notional_quote_units,
// sell qty; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const DONCHIAN_N = 120; // 2 jam
const EMA_N = 120; // filter rezim lambat
const ATR_N = 60; // True Range
const TRAIL_PCT = 0.006; // 0,6% dari peak
const TRAIL_ATR_MULT = 8;
const BREAKOUT_PCT = 0.0015; // 0,15% di atas Donchian high
const MOMENTUM_BARS = 60;
const MOMENTUM_PCT = 0.002; // +0,2% dalam 60 bar
const TIME_STOP_BARS = 480; // 8 jam
const COOLDOWN_BARS = 120;
const SIZE_BPS = 5000; // 50% ekuitas per entry
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const highs: number[] = [];
const trueRanges: number[] = [];
let ema: number | null = null;
let prevClose: number | null = null;
let entrySeq = -1;
let peakClose = 0;
let lastExitSeq = -1;
let trades = 0;

function atr(): number {
  if (trueRanges.length === 0) return 0;
  let s = 0;
  for (const r of trueRanges) s += r;
  return s / trueRanges.length;
}

function donchianHigh(): number {
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
    const low = Number(bar.l) / PRICE_SCALE;

    // Sinyal memakai histori SEBELUM bar ini.
    const prevDonchian = highs.length >= DONCHIAN_N ? donchianHigh() : -Infinity;
    const prevEma = ema;
    const prevAtr = atr();
    const close60Ago =
      closes.length > MOMENTUM_BARS ? closes[closes.length - 1 - MOMENTUM_BARS] : null;
    const haveHistory = closes.length >= EMA_N && prevEma !== null;

    // True Range bar ini (butuh close sebelumnya).
    if (prevClose !== null) {
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
      if (trueRanges.length > ATR_N) trueRanges.shift();
    }
    prevClose = close;
    closes.push(close);
    highs.push(high);
    if (closes.length > DONCHIAN_N) {
      closes.shift();
      highs.shift();
    }
    ema = ema === null ? close : close * (2 / (EMA_N + 1)) + ema * (1 - 2 / (EMA_N + 1));

    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;
    const a = prevAtr;

    if (qty > 0n) {
      // --- Di posisi: trailing stop lebar. ---
      if (close > peakClose) peakClose = close;
      const trail = peakClose - Math.max(TRAIL_PCT * peakClose, TRAIL_ATR_MULT * a);
      const timeUp = entrySeq >= 0 && state.seq - entrySeq >= TIME_STOP_BARS;
      const regimeFlip = prevEma !== null && close < prevEma;
      if (close < trail || timeUp || regimeFlip) {
        lastExitSeq = state.seq;
        entrySeq = -1;
        trades += 1;
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Flat: cari entry breakout. ---
    if (!haveHistory || prevEma === null || close60Ago === null) return [];
    if (a <= 0) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const breakout = close > prevDonchian + BREAKOUT_PCT * close;
    const regimeUp = close > prevEma;
    const momentum = close > close60Ago * (1 + MOMENTUM_PCT);
    if (!breakout || !regimeUp || !momentum) return [];

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
    console.error(`kandidat-A2 selesai: trade yang diputuskan=${trades}`);
  },
});
