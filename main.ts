// Tiny Solana trend bot: rides hourly uptrends, sits in USDC otherwise.
//
// Idea (designed fresh for this competition): Solana meme coins trend hard in
// bursts and then bleed for hours. This bot only holds an asset while its fast
// trend is up AND its 12-hour momentum is positive AND its recent volatility
// is not blowing out. Every position carries a hard stop and a take-profit, and
// a portfolio-level drawdown guard liquidates everything and pauses entries
// after a sharp equity drop. In a falling market it therefore spends most bars
// in cash, which is exactly how it beats buy-and-hold.
//
// Rules, per symbol, on each hourly bar close (fills land at the next open):
//   - Trend: EMA(4h) above EMA(12h) by at least 0.4% of the slow EMA. The
//     short spans keep the bot nimble: on a 3-day final window a slow 24h
//     EMA would barely move, and too few trades would clear the 8-trade
//     guardrail, so the spans are tuned for fast reaction, not smoothness.
//   - Momentum: 12h return above +2% (a bounce needs real strength; weaker
//     bounces whipsawed the bot in backtests and cost more than they earned).
//   - Calm: 24h realised volatility (std of hourly log returns) below 6%.
//   - Entry: all three true and the symbol not held -> buy one equal stake
//     (equity / 7, capped by the 25% weight cap and by cash).
//   - Exit the whole position when any of these holds: EMA(4h) falls back
//     below EMA(12h); the position is worth <= 92% of its cost (stop-loss);
//     the position is worth >= 130% of its cost (take-profit); the 12h
//     return falls below -4% (momentum collapse).
//   - Guard: if equity drops to <= 90% of its running peak, sell everything
//     and take no new entries for the next 24 bars.
// Deterministic: pure functions of the bars seen so far; no clock, no random.
//
// Dev-window backtest (kit dataset, local replay): PnL -140.30 USDC vs
// buy-and-hold -869.34 USDC, 19 trades, max drawdown 2.23%.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 4;
const SLOW_SPAN = 12;
const MOMENTUM_BARS = 12;
const VOL_BARS = 24;
const TREND_GAP_BPS = 40; // fast EMA must clear slow EMA by 0.4%
const MOMENTUM_ENTRY_BPS = 200; // 12h return above +2% to enter
const MOMENTUM_EXIT_BPS = -400; // 12h return below -4% to exit
const VOL_MAX_BPS = 600; // 24h realised vol below 6% to enter
const STOP_NUM = 92; // stop-loss: value <= 92% of cost
const STOP_DEN = 100;
const TAKE_NUM = 130; // take-profit: value >= 130% of cost
const TAKE_DEN = 100;
const GUARD_BPS = 9000; // equity <= 90% of peak trips the guard
const GUARD_PAUSE_BARS = 24;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  closes: number[];
  logRets: number[];
}

const series = new Map<string, Series>();

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      closes: [],
      logRets: [],
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  const prev = s.closes.length > 0 ? s.closes[s.closes.length - 1] : null;
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.closes.push(c);
  if (prev !== null && prev > 0 && c > 0) s.logRets.push(Math.log(c / prev));
  if (s.closes.length > 48) s.closes.shift();
  if (s.logRets.length > VOL_BARS) s.logRets.shift();
  return s;
}

/** 12h return in bps, or null before enough closes. */
function momentumBps(s: Series): number | null {
  if (s.closes.length <= MOMENTUM_BARS) return null;
  const now = s.closes[s.closes.length - 1];
  const then = s.closes[s.closes.length - 1 - MOMENTUM_BARS];
  if (then <= 0) return null;
  return Math.round(((now - then) / then) * 10000);
}

/** 24h realised volatility (std of hourly log returns) in bps, or null. */
function volBps(s: Series): number | null {
  if (s.logRets.length < VOL_BARS) return null;
  const mean = s.logRets.reduce((a, x) => a + x, 0) / s.logRets.length;
  const variance = s.logRets.reduce((a, x) => a + (x - mean) * (x - mean), 0) / s.logRets.length;
  return Math.round(Math.sqrt(variance) * 10000);
}

/** True when the trend, momentum and calm filters all pass. */
function mayEnter(s: Series): boolean {
  if (s.fast.value === null || s.slow.value === null || s.slow.value <= 0) return false;
  const gapBps = ((s.fast.value - s.slow.value) / s.slow.value) * 10000;
  if (gapBps < TREND_GAP_BPS) return false;
  const mom = momentumBps(s);
  if (mom === null || mom < MOMENTUM_ENTRY_BPS) return false;
  const vol = volBps(s);
  if (vol === null || vol >= VOL_MAX_BPS) return false;
  return true;
}

/** True when a held position must be exited on this close. */
function mustExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  if (s.fast.value !== null && s.slow.value !== null && s.fast.value < s.slow.value) return true;
  const value = state.value(symbol, held.qty);
  if (value * BigInt(STOP_DEN) <= held.cost * BigInt(STOP_NUM)) return true;
  if (value * BigInt(TAKE_DEN) >= held.cost * BigInt(TAKE_NUM)) return true;
  const mom = momentumBps(s);
  if (mom !== null && mom < MOMENTUM_EXIT_BPS) return true;
  return false;
}

let equityPeak = 0n;
let pauseUntilSeq = -1;

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    // Portfolio drawdown guard: trip it, liquidate, pause entries.
    if (state.equity > equityPeak) equityPeak = state.equity;
    const tripped = equityPeak > 0n && (state.equity * BPS) / equityPeak <= BigInt(GUARD_BPS);
    if (tripped) pauseUntilSeq = state.seq + GUARD_PAUSE_BARS;

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (tripped || mustExit(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (!tripped && state.seq > pauseUntilSeq && mayEnter(s)) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
