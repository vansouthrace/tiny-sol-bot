# Tiny Sol Bot

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/vansouthrace/tiny-sol-bot/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/vansouthrace/tiny-sol-bot/reward.svg)](https://make.fun)

A tiny paper-trading bot for the make.fun competition "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana". It reads hourly bars for 7 Solana tokens (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF) and decides when to hold each one versus USDC, starting from 10,000 USDC.

## Strategy

Solana meme coins trend hard in bursts and then bleed for hours, so the bot only holds an asset while three filters agree:

- **Trend:** EMA(4h) above EMA(12h) by at least 0.4%. The short spans keep the bot nimble on a 3-day window: a slow 24h EMA would barely move and would leave too few trades to clear the 8-trade guardrail.
- **Momentum:** 12-hour return above +2% (a bounce needs real strength; weaker bounces whipsawed the bot in backtests and cost more than they earned).
- **Calm:** 24-hour realised volatility below 6% (no buying into a blow-off spike).

A position is entered with one equal stake (equity / 7, capped at the 25% weight limit) and exited in full when any of these holds: the fast EMA falls back below the slow EMA, the position drops to 92% of its cost (stop-loss), it reaches 130% of its cost (take-profit), or the 12-hour return collapses below -4%. A portfolio drawdown guard liquidates everything and pauses new entries for 24 bars if equity falls to 90% of its running peak.

In a falling market the bot therefore spends most bars in cash, which is how it beats buy-and-hold; in a rising market it rides the uptrends with a hard stop underneath. Decisions are pure functions of the bars seen so far: no clock, no randomness, fully deterministic.

## Dev-window backtest

Replayed locally against the kit's dev dataset (136 hourly bars, same fill model as the harness: 10 bps fee, 5 bps slippage, constant-product impact, fills at the next open):

| Bot | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| Tiny Sol Bot | -140.30 USDC | 19 | 2.23% |
| Buy-and-hold baseline | -869.34 USDC | 7 | 10.91% |

The bot beats buy-and-hold by about 729 USDC on the dev window, clears the 8-trade minimum, and stays far inside the 25% drawdown limit. Two runs of the bot produce byte-identical action logs.

## How to run

Requires Node 22.18+ (TypeScript runs as-is):

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout via the vendored SDK in `vendor/makefun-bars.ts`.

## Grade locally

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver docker
```

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK, vendored as-is.
- `LICENSE` — MIT.
- `.makefun/owner.json` — claim file naming the payout wallet.
