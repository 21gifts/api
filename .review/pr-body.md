Since 2026-11-11 gifts correctly store only their payment-time USD amount, so the latest gift day no longer carries a CHF, EUR or PHP proportion, fiat loan shares cannot be priced, and `GET /me/loans` returns null totals for every fiat loan (the app then cannot load any loan of that member).
Not-yet-invoiced fiat share units are now priced in sats from the current spot, the source a forum ask already uses, read once per request.
Open invoices and settled parts keep their stored sats in every sum, the spot is read only for units no invoice covers, and gift rows are not touched. An unavailable required spot leaves the affected `GET /me/loans` sat fields null, while `GET /messages/:id/repayment` and every repayment POST answer 503 `Ask amount is unavailable`.

<details>
<summary>Details</summary>

### Root cause

The release that reached production on 2026-11-11 stopped deriving CHF, EUR and PHP for a payment from a daily close, as `docs/fiat-amounts.md` requires, so every outbound gift since then stores only USD. Fiat loan shares were priced through `goalRateDay` = `loadLatestGoalRateDay` (`src/routes/stats.ts`), which keeps a currency only when every gift of the latest day stored it. That is now never the case, so `sharePricer` (`src/routes/repayment.ts`) returns null for every fiat unit. In production 18 PHP loans are affected (15 funded).

### Change

Reused:
- `FxSpotStore.latest()` (`src/lib/fx-spot-store.ts:32`, Postgres store `:124`), the spot a forum ask already reads.
- `withOneRate` (`src/routes/repayment.ts:397`): the spot is read at most once per request.
- `pricedSum` (`src/routes/repayment.ts:1855`): open parts add their stored `amountSats`, only units no invoice covers are priced.

Changed:
- `sharePricer` (`src/routes/repayment.ts:422`) prices unreserved fiat units with the spot through `fiatToSats` (`src/lib/goal-rate.ts:96`), and the spot is read only when such units exist; a loan whose remaining units are all invoiced keeps returning its stored invoices without a spot.
- Every sum of `GET /me/loans`, `GET/POST /messages/:id/repayment` and `/repayment/due` (due, next, total, payable, waiting, lender waiting, max) adds open parts with their stored sats.
- Wiring: `fxSpotStore` passed to the credit and repayment routes in `src/server.ts:798` and `:1126` (`src/routes/messages.ts:395`).

Removed:
- `loadLatestGoalRateDay` and `bindGoalRateDay` (`src/routes/stats.ts`) with their tests, e2e catalog entries, handbook and CONTRIBUTING boot-surface entries; nothing else used them.
- The unreachable `maxSats === null` branch of the prepay handler: `prepayPlan` already answers `unavailable` when any required unit cannot be priced.

`docs/fiat-amounts.md` ("What may use the rate of now") allows the current spot to turn a fiat amount into sats for a payment about to be created; committed amounts are unchanged.

An earlier version of this pull request recorded CHF/EUR/PHP on Fond payouts and backfilled gift rows; review showed that `docs/fiat-amounts.md` forbids both, so it was replaced by this change.

### Verified

Bun 1.4.4 with vitest under Node 22 (as CI): typecheck, lint, handbook check, e2e check, database change notice test, unit tests (9125 passed, 100% statements/branches/functions/lines), Postgres driver tests on Postgres 16 (140 passed), build, HTTP e2e suite (1065 passed).

</details>
