// Kandidat E — momentum 24-bar + reversal exit (pembanding baseline +$2,45).
// Keluarga momentum murni: beli saat momentum 24 bar positif dan rezim naik,
// tahan selama momentum bertahan, keluar saat momentum berbalik. TANPA
// trailing stop — A1/A2 membuktikan trailing ketat/bahkan 0,6% mengunci
// rugi di window choppy ini; exit hanya oleh pembalikan momentum, flip
// rezim EMA-120, atau time-stop 720 bar.
//
// Entry: close > close 24 bar lalu * 1,0015 (momentum +0,15%) DAN close
//        di atas EMA-120. Ukuran 50% ekuitas.
// Exit : close < close 24 bar lalu (momentum <= 0) ATAU close < EMA-120
//        ATAU 720 bar di posisi. Jual seluruh qty; cooldown 30 bar.
// Tanpa wall clock, tanpa file luar repo, tanpa Math.random — deterministik
// dari bar yang dikirim harness (hello/batch). Order: buy
// notional_quote_units, sell qty; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const MOM_N = 24;
const MOM_ENTRY = 0.0015; // +0,15% dalam 24 bar
const EMA_N = 120; // filter rezim lambat
const TIME_STOP_BARS = 720; // 12 jam
const COOLDOWN_BARS = 30;
const SIZE_BPS = 5000; // 50% ekuitas per entry
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let ema: number | null = null;
let entrySeq = -1;
let lastExitSeq = -1;
let trades = 0;

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;

    // Momentum memakai close 24 bar SEBELUM bar ini.
    const close24Ago =
      closes.length > MOM_N ? closes[closes.length - 1 - MOM_N] : null;
    const prevEma = ema;
    const haveHistory = closes.length >= EMA_N && prevEma !== null;

    closes.push(close);
    if (closes.length > EMA_N) closes.shift();
    ema = ema === null ? close : close * (2 / (EMA_N + 1)) + ema * (1 - 2 / (EMA_N + 1));

    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;

    if (qty > 0n) {
      // --- Di posisi: keluar hanya saat momentum berbalik / rezim flip. ---
      const reversed = close24Ago !== null && close < close24Ago;
      const regimeFlip = prevEma !== null && close < prevEma;
      const timeUp = entrySeq >= 0 && state.seq - entrySeq >= TIME_STOP_BARS;
      if (reversed || regimeFlip || timeUp) {
        lastExitSeq = state.seq;
        entrySeq = -1;
        trades += 1;
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Flat: cari entry momentum. ---
    if (!haveHistory || prevEma === null || close24Ago === null) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const momentumUp = close > close24Ago * (1 + MOM_ENTRY);
    const regimeUp = close > prevEma;
    if (!momentumUp || !regimeUp) return [];

    let notional = (state.equity * BigInt(SIZE_BPS)) / 10000n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < 1_000_000n) return []; // di bawah min 1 USDC
    entrySeq = state.seq;
    trades += 1;
    return [{ side: "buy", symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
  onDone(_state: BarsState) {
    console.error(`kandidat-E selesai: trade yang diputuskan=${trades}`);
  },
});
