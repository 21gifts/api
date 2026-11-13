Since 2026-11-11 gifts correctly store only their payment-time USD amount, so the latest gift day no longer carries a CHF, EUR or PHP proportion, fiat loan shares cannot be priced, and `GET /me/loans` returns null totals for every fiat loan (the app then cannot load any loan of that member).
Not-yet-invoiced fiat share units are now priced in sats from the current spot, the source a forum ask already uses, read once per request.
Stored invoices and settled parts keep their stored sats, gift rows are not touched, and an unavailable spot keeps today's null / 503 behaviour.

<details>
<summary>Details</summary>

### Root cause

The release that reached production on 2026-11-11 stopped deriving CHF, EUR and PHP for a payment from a daily close, as `docs/fiat-amounts.md` requires, so every outbound gift since then stores only USD. Fiat loan shares were priced through `goalRateDay` = `loadLatestGoalRateDay` (`src/routes/stats.ts`), which keeps a currency only when every gift of the latest day stored it. That is now never the case, so `sharePricer` (`src/routes/repayment.ts`) returns null for every fiat unit. In production 18 PHP loans are affected (15 funded).

### Change

- `sharePricer` (`src/routes/repayment.ts`) and the credit routes in `src/routes/messages.ts` price fiat units with the stored `FxSpotQuote` (`FxSpotStore.latest()`), wired in `src/server.ts` where `goalRateDay` was bound; `withOneRate` still reads it once per request.
- `fiatToSats` (`src/lib/goal-rate.ts`) takes the spot quote.
- `loadLatestGoalRateDay` and `bindGoalRateDay` are removed with their tests, catalog, handbook and CONTRIBUTING entries; nothing else used them.
- `docs/fiat-amounts.md` ("What may use the rate of now") already allows the current spot to turn a fiat amount into sats for a payment about to be created; committed amounts are unchanged.

An earlier version of this pull request recorded CHF/EUR/PHP on Fond payouts and backfilled gift rows; review showed that `docs/fiat-amounts.md` forbids both, so it was replaced by this change.

### Verified

Bun 1.4.4 with vitest under Node 22 (as CI): typecheck, lint, handbook check, e2e check, database change notice test, unit tests (9123 passed, 100% statements/branches/functions/lines), Postgres driver tests on Postgres 16 (140 passed), build, HTTP e2e suite (1065 passed).

</details>
