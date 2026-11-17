// Kandidat D — beli dip setelah drawdown dalam + jual recovery (trailing lebar).
// Pelajaran A/E: sinyal horizon <=60 bar adalah noise (SD 1 menit 0,064%,
// return 24 bar SD ~0,31% > ambang momentum +0,15% -> 17 round-trip rugi).
// D hanya trading kaki besar: drawdown >=1,5% dari high 6 jam (>> biaya
// round-trip ~36 bps dan >> noise), beli HANYA pada cross segar naik
// melewati low-6jam*1,005 (recovery +0,5%), tahan kaki recovery, keluar
// via trailing 0,6% dari peak (~9 SD gerak 1 menit) atau time-stop 12 jam.
//
// Entry: low360 >= 1,5% di bawah high360, DAN close bar ini melintasi naik
//        low360*1,005 (close sebelumnya <= ambang < close ini), DAN close
//        > close 60 bar lalu (recovery sedang berjalan). Ukuran 50%.
// Exit : close < peak - 0,6%*peak (trailing; peak awal = close entry,
//        jadi ini juga stop-loss 0,6% dari entry) ATAU 720 bar di posisi.
//        Jual seluruh qty; cooldown 120 bar.
// Tanpa wall clock, tanpa file luar repo, tanpa Math.random — deterministik
// dari bar yang dikirim harness (hello/batch). Order: buy
// notional_quote_units, sell qty; max_slippage 100 bps.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5; // harga bar di price_scale 5 -> USDC
const LOOKBACK = 360; // 6 jam
const DRAWDOWN_PCT = 0.015; // drawdown minimal dari high lookback
const RECOVERY_PCT = 0.005; // +0,5% di atas low lookback
const TRAIL_PCT = 0.006; // 0,6% dari peak
const MOMENTUM_BARS = 60;
const TIME_STOP_BARS = 720; // 12 jam
const COOLDOWN_BARS = 120;
const SIZE_BPS = 5000; // 50% ekuitas per entry
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const lows: number[] = [];
const highs: number[] = [];
let entrySeq = -1;
let peakClose = 0;
let lastExitSeq = -1;
let trades = 0;

function minLow(): number {
  let m = Infinity;
  for (const v of lows) if (v < m) m = v;
  return m;
}
function maxHigh(): number {
  let m = -Infinity;
  for (const v of highs) if (v > m) m = v;
  return m;
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;
    const high = Number(bar.h) / PRICE_SCALE;
    const low = Number(bar.l) / PRICE_SCALE;

    // Kondisi entry memakai lookback SEBELUM bar ini (low/high 720 bar lalu).
    const prevLow = lows.length >= LOOKBACK ? minLow() : Infinity;
    const prevHigh = highs.length >= LOOKBACK ? maxHigh() : -Infinity;
    const prevClose = closes.length > 0 ? closes[closes.length - 1] : null;
    const close60Ago =
      closes.length > MOMENTUM_BARS ? closes[closes.length - 1 - MOMENTUM_BARS] : null;
    const haveHistory = closes.length >= LOOKBACK;

    closes.push(close);
    lows.push(low);
    highs.push(high);
    if (closes.length > LOOKBACK) {
      closes.shift();
      lows.shift();
      highs.shift();
    }

    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;

    if (qty > 0n) {
      // --- Di posisi: trailing 0,6% dari peak. ---
      if (close > peakClose) peakClose = close;
      const trail = peakClose * (1 - TRAIL_PCT);
      const timeUp = entrySeq >= 0 && state.seq - entrySeq >= TIME_STOP_BARS;
      if (close < trail || timeUp) {
        lastExitSeq = state.seq;
        entrySeq = -1;
        trades += 1;
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Flat: cari cross recovery segar dari dip dalam. ---
    if (!haveHistory || prevClose === null || close60Ago === null) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const deepDip = prevLow < prevHigh * (1 - DRAWDOWN_PCT);
    const threshold = prevLow * (1 + RECOVERY_PCT);
    const freshCross = prevClose <= threshold && close > threshold;
    const recovering = close > close60Ago;
    if (!deepDip || !freshCross || !recovering) return [];

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
    console.error(`kandidat-D selesai: trade yang diputuskan=${trades}`);
  },
});
