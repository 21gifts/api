# Shop payment in USDT and USDC

Status: **specified, not implemented**. Decided 2026-10-01. Revised
2026-10-14: this text replaces every earlier version of this document,
which was `docs/shop-spark-payment.md`. Nothing here is mounted, and
`SPEC.md` does not list these routes. Nothing here changes runtime
behaviour.

A payer settles a shop payment in USDT or USDC. Orchestra (Flashnet)
takes the stablecoin and pays one BOLT11 for the shop's sats. That
invoice is minted by the mint `POST /pay/:username/invoice` already uses,
on the shop's verified in-app wallet. The shop receives an ordinary
bitcoin payment. The shop never holds USDT or USDC. 21.gifts holds
either coin only when Orchestra refunds a deposit to the 21.gifts refund
address. Gifts, the till, and loans stay in satoshis.

## Requirements

Three requirements are hard. The sections below state how each one is
met.

| Requirement                       | Verified against                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCryptoPay compatible          | The OpenCryptoPay standard: the README of `openCryptoPay/landingPage` at `c840d64e`, which opencryptopay.io links as its documentation. LUD-01, LUD-06, and LUD-16 as well, because the standard is "LNURL backward compatible". |
| Consistent with the DFX reference | DFX.swiss, whose API answers every example in that README. Where this document differs, [Deviations](#deviations) gives the reason.                                                                                              |
| Tether Wallet for Android 1.11.0  | Build 134, read from its compiled OpenCryptoPay client (`services/opencryptopay/api`, `route`, and `pending-proof`) and its wallet worklet. [Tether Wallet 1.11.0](#tether-wallet-1110) lists what that build does.              |

Orchestra facts come from its documentation (`docs.flashnet.xyz`: Quotes,
Pricing, Order status, Errors, API overview, Rate limits), its OpenAPI
document (`https://orchestration.flashnet.xyz/openapi.json`), and its
route list (`/v2/orchestration/routes`), read on 2026-10-14 and
2026-10-15. Facts that only a live run can prove are listed in
[Release checks](#release-checks).

These Orchestra facts shape the design:

- A quote holds its price for 2 minutes. `expiresAt` is 2 minutes after
  creation.
- The payer sends `amountIn` to the quote's deposit address before
  `expiresAt`. With `includeCalldata`, the quote returns the unsigned
  ERC-20 `transaction`, whose `data` encodes
  `transfer(depositAddress, amountIn)`. An exact-out quote also returns
  `requiredAmountIn` and `maxAcceptedAmountIn`. A deposit below the first
  fails with `exact_out_insufficient_input`, and one above the second
  with `exact_out_input_above_max`.
- Orchestra detects the deposit itself and creates the order. Submitting
  the transaction hash is the documented fallback, and repeating the same
  deposit returns the existing order.
- An order that tries to pay a BOLT11 that is already paid fails with
  `duplicate_lightning_invoice`. Errors lists `quote_expired` (409) as
  "Lightning destination invoice expired" without naming the endpoint;
  the api reads it on submit as stated in [Calls](#calls), and release
  check 4 confirms it.
- Handler 4xx answers are cached under their idempotency key. A new
  attempt after such an answer needs a new key. A timeout or a 5xx is
  retried with the same key.
- Order lookups are limited to 120 requests per minute per IP, and one
  order should be polled no faster than every 3 s.

### Refund address

Orchestra's documentation says: "`/quote` requires `refundAddress` for
exact-out and Lightning destinations" (Pricing). The payer's address is
unknown when the quote is created, because the OpenCryptoPay pay request
carries none. Every quote therefore sends `SHOP_REFUND_ADDRESS`, one EVM
address that 21.gifts controls. The same address is valid on every chain
of the method table. A deposit that Orchestra cannot fill comes back to
it. What 21.gifts does with such a refund is outside this document.

## Flow

1. A till charge, or an amount the payer enters on the payment page,
   opens one **shop payment** for a fixed number of sats.
2. The api mints one BOLT11 for those sats and asks Orchestra for one
   exact-out quote per offered chain and asset. Each quote pays that
   BOLT11.
3. For up to five minutes the shop's sticker is pinned to that payment.
   A wallet that scans it receives an OpenCryptoPay pay request with
   Lightning and the stablecoin options.
4. The wallet picks one option and fetches its transaction detail: an
   EIP-681 ERC-20 transfer to Orchestra's deposit address.
5. The wallet pays and sends a proof: the transaction hash (`tx`) or the
   signed raw transaction (`hex`).
6. The api checks the transfer on chain and submits it to Orchestra
   after its receipt succeeded; the api first validates and sends a `hex`
   transaction.
   An Orchestra order for that transfer is **accepted**. The wallet is
   told the payment succeeded, and the sticker is free again. The api
   also finds orders that Orchestra created without a proof.
7. Orchestra pays the BOLT11. The api sees the invoice settle and records
   **paid**. A direct Lightning payment of the same BOLT11 is the same
   confirmation.

## Terms

Each term has exactly one meaning in this document.

- **Sticker**: the one QR printed for a shop,
  `https://<domain>/pl/?lightning=<LNURL>`, with the LNURL in uppercase
  (`src/lib/gifts-address.ts` in 21gifts/app). It never changes.
- **Pay link**: the URL inside that LNURL,
  `<PUBLIC_BASE_URL>/.well-known/lnurlp/<username>`. It is the existing
  route.
- **Payment page**: the web page a phone camera opens from the sticker,
  served by 21gifts/app.
- **Shop payment**: one row of `shop_payment`. It fixes one sat amount
  and stores exactly one BOLT11. `quote.payment` is its id.
- **Window**: the time during which a shop payment may pin the sticker.
  A charge-backed payment uses the charge's `expires_at`. A payer-opened
  payment ends its window five minutes after it is created.
  `shop_payment.window_ends_at` stores the end.
- **Open amount**: the shop payment of an account whose status is `open`
  while `now < window_ends_at`. An account has at most one.
- **Waiting charge**: a pending charge with no shop payment, or whose
  shop payment is `ended`. A pending charge whose shop payment is `open`,
  `accepted`, or `paid` is not a waiting charge, so it does not pin the
  sticker.
- **Quote**: one row of `shop_quote`. It names one set of offers.
  `quote.id` is its id. The **current quote** of a payment is its newest
  quote. The quote before it is the **previous quote**.
- **Offer**: one row of `shop_offer`. It is one committed Orchestra quote
  for one method and one asset of a quote.
- **Detail**: the transaction detail of one offer, the response to a
  callback with `method` and `asset`.
- **Proof**: one deposit to an offer's deposit address, stored as one row
  of `shop_proof`. A wallet's `tx` or `hex` creates it, or the watcher
  creates it when Orchestra reports an order the api did not submit.
- **Order**: the Orchestra order of one proof, stored as
  `shop_proof.provider_order` with its last `order_status`.
- **Accepted**: the one proof of a payment whose order is expected to pay
  the BOLT11 ([States](#states)).
- **Paid**: the payment's BOLT11 has settled.
- **Closed**: the payment's final settlement read, 10 minutes after the
  BOLT11 expired, found it unpaid. A closed payment never changes again.
- **Unresolved**: a proof without an order and without a definitive
  refusal. Only an unresolved proof is submitted.
- **Progressing**: an order whose status is `processing`,
  `confirming`, `awaiting_approval`, `swapping`, `bridging`, or
  `delivering`, the statuses Orchestra lists as in flight towards
  delivery.
- **Held**: a proof that is not `accepted`, with an order that is not final, whose order is not
  progressing (`refunding`, `unfulfilled`, or a status the api does not
  know), whose amount is not known yet or lies outside the bounds in
  [States](#states), or whose payment is already `paid`. A held
  proof is never submitted again; the watcher follows its order.

Every timestamp in a response is ISO 8601 UTC with milliseconds and `Z`,
as `Date.prototype.toISOString` writes it, the same form
`GET /pay/:username` uses for `expiresAt`.

## Methods

The api offers exactly these methods. A method name is the
OpenCryptoPay name, and responses write it exactly as in the table, as
the standard requires: the method "must match exactly the method name
from the `transferAmounts` array". Requests are matched without regard to
case, as DFX matches them.

| Method              | `chainId` | Orchestra `sourceChain` | USDT contract                                | USDC contract                                | Decimals | Tether 1.11.0 pays |
| ------------------- | --------- | ----------------------- | -------------------------------------------- | -------------------------------------------- | -------- | ------------------ |
| `Ethereum`          | 1         | `ethereum`              | `0xdac17f958d2ee523a2206206994597c13d831ec7` | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | 6        | USDT               |
| `Arbitrum`          | 42161     | `arbitrum`              | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | 6        | USDT               |
| `Optimism`          | 10        | `optimism`              | `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58` | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` | 6        | no                 |
| `Polygon`           | 137       | `polygon`               | `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` | 6        | USDT               |
| `Base`              | 8453      | `base`                  | `0xfde4c96c8593536e31f229ea8f37b2ada2699bb2` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | 6        | no                 |
| `BinanceSmartChain` | 56        | `bsc`                   | `0x55d398326f99059ff775485246999027b3197955` | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | 18       | no                 |

The table is the contract. Its contracts and decimals are the values
Orchestra's route list names for those pairs on 2026-10-14. The three
USDT contracts that Tether 1.11.0 pays are also the contracts in that
wallet's own token list.

A pair is offered on one quote only when all of these hold:

- the method and asset are in the table;
- Orchestra's route list names the pair, its `route.exactOutTo` admits
  `lightning:BTC`, its `contractAddress` equals the table value (compared
  in lowercase), and its `decimals` equals the table value;
- `SHOP_EVM_RPC` has an endpoint for that `chainId`;
- the Orchestra quote for that pair commits and passes
  [Offer checks](#offer-checks).

A pair whose route-list values differ from the table is not offered, and
the api logs `shop.route.mismatch`. The route list is fetched with the
server key, because Orchestra filters it per partner, with a 1 s timeout.
It is reused only until its `validForMs` has passed since the request
started, as Orchestra defines it. Route-list fetches have their own
budget of 25
per minute per container, so two containers stay below Orchestra's 60
per address for routes and limits; a 429 pauses them as
[Calls](#calls) states for every endpoint. When a fetch fails or the budget is used up, no stablecoin is offered
until a fetch succeeds.

Pairs are requested in this order, so that a short budget still serves
Tether 1.11.0 first: USDT on `Ethereum`, `Arbitrum`, and `Polygon`, then
the remaining pairs in table order, USDT before USDC.

Not offered, by decision:

- **Tron**: its OpenCryptoPay detail is a `tron:` URI, not EIP-681.
  Tether 1.11.0 lists Tron and never offers it.
- **Solana**: its detail is not EIP-681, and the api has no Solana
  verification.
- **Plasma**: the name is not in the OpenCryptoPay standard.
- **Avalanche, Monad, HyperEVM, Tempo**: they have no OpenCryptoPay
  method name.
- **Spark, Bitcoin, and every other OpenCryptoPay method**: they carry no
  USDT or USDC.

Lightning stays offered as today. It is not an Orchestra pair. Adding a
method is a change to the table and to its tests.

## Lifetimes

| Name               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window             | Five minutes (`POS_CHARGE_TTL_MS`). A charge-backed payment uses the charge's `expires_at`. A payer-opened payment uses `created_at` + 5 min.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Offer expiry       | Orchestra's `expiresAt`, 2 minutes after the Orchestra quote was created.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Funding margin     | 30 s, a design value: a transfer sent at `quote.expiration` has 30 s to reach the chain before Orchestra's `expiresAt`. Release check 4 measures late funding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `quote.expiration` | A quote with offers: the earliest of `window_ends_at` and every offer's `expiresAt` minus the funding margin. A Lightning-only quote: `window_ends_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Replacement        | A fetch replaces the current quote when less than 45 s remain before its `quote.expiration`, at least 45 s remain before `window_ends_at`, and the payment has had fewer than 4 replacements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BOLT11 expiry      | The time the mint was requested plus the invoice's `expiry` tag, or plus 3600 s when the tag is absent, as `invoiceStillOpen` computes it from `inspectBolt11` and `DEFAULT_INVOICE_EXPIRY_MS`, both moved from `src/routes/repayment.ts` to `src/lib/bolt11.ts` ([Implementation](#implementation)). Taking the request time, not the later answer, keeps the stored expiry at or before the real one when the LNURL server's clock is not behind the api's; when it runs behind, the real expiry is earlier by that difference. A difference up to 60 s is tolerated; the rest of the 600 s BOLT11 margin stays for Orchestra to pay the invoice after a deposit made just before `expiresAt`, and release check 3 confirms the staging mint's clock. |
| BOLT11 margin      | An offer commits only when the payment's BOLT11 expires at least 600 s after that offer's `expiresAt`. Over a full window that needs a BOLT11 of 1020 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Settlement watch   | The payment's BOLT11 is watched until its final read, 10 min after its expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Order watch        | An offer with an issued detail is checked for an Orchestra order until 30 min after its `expiresAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unresolved limit   | A proof that has no order and no refusal 24 h after it was stored becomes `stuck`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

A wallet can take longer than the funding margin, for example when the
chain is slow. Orchestra then decides about the late deposit. The api
still records and submits it.

## States

`shop_payment.status` is `open`, `accepted`, `paid`, or `ended`. Every
transition is one conditional `UPDATE … WHERE id = $1 AND status IN (…)`.
The caller checks the affected row count. Zero rows means another step
won, and the caller re-reads. `markPaid` in `pos-store.ts` uses this
pattern.

| From                        | To         | Trigger                                                                                                                                    | Columns                                             |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| (none)                      | `open`     | A charge-backed creation, or `POST /pay/:username/payment`.                                                                                | sets `created_at`, `window_ends_at`                 |
| `open`                      | `ended`    | The window ends; `POST /pos`; a new payer amount; the charge is cancelled; or the charge is paid by an invoice that is not this payment's. | sets `ended_at`, `end_reason`                       |
| `open`, `ended`             | `accepted` | A proof of the payment becomes `accepted` before the payment is closed.                                                                    | sets `accepted_at`; clears `ended_at`, `end_reason` |
| `open`, `ended`, `accepted` | `paid`     | The BOLT11 settles, found by any settlement read up to the final one.                                                                      | sets `paid_at`; clears `ended_at`, `end_reason`     |
| `accepted`                  | `ended`    | The accepted proof leaves `accepted` without another proof taking its place, or the final settlement read finds the BOLT11 unpaid.         | sets `ended_at`, `end_reason`                       |

The final settlement read sets `closed_at` on a payment that is not
`paid`. `paid` is final, and a closed payment is final. Before that,
`ended` can still move to `accepted` or `paid`, because a transfer made
in time can be confirmed after the window. Nothing else changes a
status. `db_change` keeps every earlier value.

The step that moves a charge-backed payment to `paid` takes the account
row lock first, then the `pos_charge` row, then the `shop_payment` row,
the order the charge watch uses, so the two never wait for each other in
opposite order. For a payer's payment, which has no charge, it locks only
the `shop_payment` row. It also runs
`markPaid` for its charge, so the till sees the charge paid even after
the charge's own watch has ended. That watch ends 10 minutes after the
charge expires (`POS_PAID_WATCH_MS` in `src/lib/pos-paid-worker.ts`).

`end_reason` is one of `window`, `superseded` (by `POST /pos`),
`replaced` (by a new payer amount), `cancelled`, `charge_paid`,
`orchestra_refunded`, `orchestra_failed`, `proof_refused`, or `expired_unpaid`. When the accepted proof of an `accepted` payment becomes `refunded`,
`failed`, or `refused`, a `superseded` proof takes its place as the
proof table below states, and the payment stays `accepted`. Only when no
proof takes its place does the payment end with `orchestra_refunded`,
`orchestra_failed`, or `proof_refused`.

`shop_proof.result` is null (unresolved or held), `accepted`, `superseded`,
`late`, `refunded`, `failed`, `refused`, or `stuck`. Each change is a
conditional update on the expected result, in the same database
transaction as the payment change it causes. At most one proof of a
payment is `accepted`.

| From                                                       | To           | Trigger                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| null, `refused`, `stuck`, `superseded`                     | `accepted`   | The proof has a progressing order and a known amount within the bounds below, whichever comes last; the payment is neither `paid` nor closed; and no other proof of the payment is `accepted`, which also lets a `superseded` proof whose order resumed take the place once no proof is `accepted`. Filling in a value or a new order status re-evaluates the proof. |
| null, `refused`, `stuck`                                   | `superseded` | The same, while the payment is neither `paid` nor closed, but another proof of the payment is `accepted`. A unique-index conflict on the accepted proof is this case.                                                                                                                                                                                                |
| `superseded`                                               | `accepted`   | In the transaction in which the payment's accepted proof becomes `refunded`, `failed`, or `refused`, while the payment is neither `paid` nor closed: the oldest `superseded` proof of the payment whose order is progressing and whose amount is known and within the bounds below takes its place.                                                                  |
| `superseded`, `late`, `refused`, `stuck`, null             | `accepted`   | Its order becomes `completed`: it paid the BOLT11. In one transaction that first locks the rows it changes ([Storing and submitting](#storing-and-submitting)), the proof that was `accepted`, if there is one, first moves to `superseded`, then this proof moves to `accepted`.                                                                                    |
| null, `refused`, `stuck`                                   | `late`       | The proof gets a progressing order after the payment closed, or its submit answers `409 quote_expired`. The api logs `shop.alert.late_deposit`.                                                                                                                                                                                                                      |
| `accepted`, `superseded`, `late`, `refused`, `stuck`, null | `refunded`   | The order's status is or becomes `refunded`.                                                                                                                                                                                                                                                                                                                         |
| `accepted`, `superseded`, `late`, `refused`, `stuck`, null | `failed`     | The order's status is or becomes `failed` or `fallback_delivered`. The api logs `shop.alert.order_failed`.                                                                                                                                                                                                                                                           |
| `accepted`, `superseded`, `late`, `stuck`, null            | `refused`    | The order's status is `expired` (no deposit), Orchestra refuses the submit with `400 xchain_deposit_mismatch`, or a `hex` transaction is rejected or reverts. `refusal` stores which of these, or `tx_used` ([Storing and submitting](#storing-and-submitting)).                                                                                                     |
| null                                                       | `stuck`      | An unresolved proof passes `give_up_at`. A held proof is followed by the order-status duty instead.                                                                                                                                                                                                                                                                  |
| `stuck`                                                    | null         | An operator runs `POST /debug/shop-proofs/:id/retry`, which sets `give_up_at` 24 h ahead.                                                                                                                                                                                                                                                                            |

A proof whose payment is already `paid` is held: its order is
expected to fail with `duplicate_lightning_invoice`, so it answers
**503** until the order is final, and only `completed` moves it to
`accepted`, as the row above states.

Orchestra is the authority on deposits: an order for a `refused` or
`stuck` proof moves it as the table states. An order that is already
final when the api first sees it, as a submit replay can return, takes
the row of its final status at once.

The amount bounds are the offer's `requiredAmountIn` (or `amountIn` when
absent) and its `maxAcceptedAmountIn` (or `amountIn` when absent). The
amount is the value of the proof's transfer log. A `hex` proof's amount
is the amount in its verified `data`. A `detected` proof has no known
amount until a receipt read fills in its log, by the repeat path below
or by the receipts duty. The order's `amountIn` is not used, because
Orchestra does not document it as the deposited value. A proof whose
amount is unknown or outside those bounds is held: it answers **503**
until its order is final, and it becomes `accepted` only when its order completes or, once the amount
is known and within the bounds, as the table above states for a
progressing order. A dust transfer to a public deposit address therefore cannot
take acceptance away from the payer.

The first order of a payment within the bounds is `accepted`, because
which order pays the BOLT11 is known only when it completes. When
another order completes instead, acceptance moves to it, and the earlier
order fails with `duplicate_lightning_invoice`. A wallet that already
got **200** for that earlier proof keeps its screen, and the till shows
the truth. An order that pays the BOLT11 is `accepted` even when
Orchestra detected the deposit and paid before the wallet's proof
arrived. Orchestra refunds a deposit whose order cannot pay to the
refund address ([Refund address](#refund-address)).

A shop payment never makes `POST /pos` or `DELETE /pos` answer 409. No
unresolved proof and no `accepted` payment holds the sticker, the till,
or a new payer amount.

## Pay link

`GET /.well-known/lnurlp/:username` is the existing route
(`src/routes/well-known.ts`). It keeps its 120 requests per minute per
client address, its CORS headers, `Cache-Control: no-store`, and every
existing 404, 429, 502, and 503 case. This document adds the cases
below.

### No open amount

When the account has no open amount and the request has no `timeout`
query, the response is the Lightning pay request the route serves today:
a minimum, a maximum, the metadata, and the callback
`<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`. A waiting charge keeps
today's pin (both bounds are the charge amount). A pending charge whose
shop payment is `accepted` or `paid` is not pinned, so the response is
today's unpinned request. Any LNURL wallet can still pay the sticker.

A pending charge with no shop payment first starts or joins the
[Creation procedure](#creation-procedure) and waits for it at most until
8 s after the fetch arrived, a wait as long as the procedure's 8 s
budget, whatever the
creation is still waiting for, lock waits included. A request with
`timeout` that reaches this point only 8 s or more after it arrived, while
it waits as described below, does not wait for the creation and answers
today's pinned Lightning request. The 8 s wait stays below the 10 s a plain
LNURL wallet waits and the 20 s Tether 1.11.0 waits. When the payment
exists by the end of that wait, the fetch answers as for an open amount.
Otherwise it answers today's pinned Lightning request, and the creation
goes on in the background.

When the request carries `timeout`, the api follows the standard's
waiting rule, which DFX implements. `timeout` is a whole number of
seconds. Values above 10 count as 10, and an empty or unparseable value
counts as 0. The api checks every `WAIT_SATS_POLL_MS` (250 ms) until it finds an open amount or a pending charge that has no shop payment or an `open` one, or the time is up. With an open amount it answers
the pay request below. A pending charge with no shop payment or an `open` one answers exactly
as a fetch without `timeout` does, including starting or joining the
creation procedure. A pending charge whose shop payment is `accepted`,
`paid`, or `ended` counts as nothing waiting, because the request with
`timeout` comes from an OpenCryptoPay wallet and no OpenCryptoPay
payment is waiting; LNURL wallets, which never send `timeout`, still get
today's request. With neither it answers **404** with the body of the
standard's example. At most 50 requests per process wait at the same
time; a further request is answered at once.

```json
{
  "id": "<username>",
  "displayName": "<shop name>",
  "standard": "OpenCryptoPay",
  "possibleStandards": ["OpenCryptoPay"],
  "displayQr": false,
  "recipient": { "name": "<shop name>" },
  "statusCode": 404,
  "message": "No pending payment found",
  "error": "Not Found",
  "status": "ERROR",
  "reason": "No pending payment found"
}
```

Tether 1.11.0 reads a 404 as "nothing is waiting" only when the body has
`standard` `OpenCryptoPay` or a `possibleStandards` that contains it.
After its proof is accepted, the wallet polls the pay link with
`timeout=0`, and this 404 tells it that the payment left the sticker.

### Open amount

While the account has an open amount, the response is the pay request
for it, with or without `timeout`. The table is the complete body.
Today's `commentAllowed`, `allowsNostr`, `nostrPubkey`, and `payerData`
are left out, because the shop callback serves no comment and no zap.

| Field               | Value                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                | the username                                                                                         |
| `tag`               | `payRequest`                                                                                         |
| `callback`          | `<PUBLIC_BASE_URL>/lnurlp/cb/<username>`                                                             |
| `minSendable`       | the sat amount times 1000                                                                            |
| `maxSendable`       | the same value                                                                                       |
| `metadata`          | the metadata of today's pay request, unchanged                                                       |
| `displayName`       | the name `GET /pay/:username` returns                                                                |
| `standard`          | `OpenCryptoPay`                                                                                      |
| `possibleStandards` | `["OpenCryptoPay"]`                                                                                  |
| `displayQr`         | `false`                                                                                              |
| `recipient`         | `{ "name": <the same shop name> }`                                                                   |
| `quote`             | `{ "id": <current quote id>, "expiration": <quote.expiration>, "payment": <shop payment id> }`       |
| `requestedAmount`   | `{ "asset": "BTC", "amount": <sats / SATS_PER_BTC> }`                                                |
| `transferAmounts`   | Lightning first, then each offered method in table order. Inside one method, USDT comes before USDC. |

A `transferAmounts` entry is
`{ "method", "minFee", "assets": [{ "asset", "amount" }], "available" }`.

- Lightning: `method` `Lightning`, `minFee` 0, one asset `BTC` whose
  `amount` is the sat count divided by `SATS_PER_BTC`
  (`src/lib/money.ts`), and `available` true.
- A stablecoin method: `minFee` is DFX's recommended gas price in wei,
  computed from the `eth_gasPrice` result `g` at quote creation:
  `floor(g × 12 / 10)`, and on `BinanceSmartChain`
  `floor(floor(g × 12 / 10) × 20 / 12)`. `assets` lists the offered
  assets. Each `amount` is the offer's `amountIn` divided by 10 to the
  power of the decimals. `available` is true.

Every amount string is built from integers. It has no exponent, no
trailing zero after the decimal point, and no point when it is a whole
number (`0.00001`, `1.5`, `12`). That is the canonical form
`canonicalGoalAmount` (`src/lib/goal-rate.ts`) writes; the BTC amount is
`satsToBtcString` (`src/lib/money.ts`), which always writes eight
decimals, put through that form. `canonicalGoalAmount` accepts at most
eight decimals, so the implementing change moves its trimming into a
shared helper that also takes the 6 and 18 decimals of the stablecoin
amounts. `requestedAmount.amount` is a JSON
number written in that same plain notation, never `1e-8`.

A fetch returns the current quote unchanged unless the replacement rule
in [Lifetimes](#lifetimes) applies ([Quotes](#quotes)). A current quote
whose `quote.expiration` has passed, and that the rule does not allow to
replace, gets a Lightning-only quote row instead. That row needs no
Orchestra call and does not count as a replacement, so no response
ever carries a `quote.expiration` in the past. `quote.payment` never
changes for a payment.

### Simplified flow

A pay-link request with `method` and `asset` first applies the rules
above, including `timeout` and quote replacement. With an open amount it
then answers like the callback with the same `method` and `asset` and
the current `quote.id`, as the standard's simplified flow states.
Without one it is the **404** above.

### Route details

- `<PUBLIC_BASE_URL>/lnurlp/*` must reach the api. On 2026-10-14,
  `https://staging.21.gifts/lnurlp/cb/<name>` was answered by the api's
  router. On production, `https://21.gifts/lnurlp/…` was still answered
  by the web app. [Release checks](#release-checks) item 8 covers this.
- The web app proxies `/.well-known/lnurlp/:username` to the api and
  forwards the query string, so `timeout` arrives. The proxy forwards no
  client address. How the api counts those requests depends on how the
  app reaches it, which is today's behaviour.
- Usernames `invoice` and `cb`, and any username that ends in `.`, never
  get stablecoin rows. `invoice` collides with the invoice forward
  `GET /lnurlp/:username/invoice`. Tether 1.11.0 replaces every path
  segment `cb` with `tx` when no `hint` URL is usable, so `/lnurlp/cb/cb`
  would become `/lnurlp/tx/tx`. Tether 1.11.0 cuts trailing punctuation
  off a `hint` URL, which would cut a final `.`. `normalizeUsername`
  refuses a final `.` today, but an older account may still have one.
  These usernames keep today's Lightning pay request.
- `GET /lnurlp/cb/invoice`, `GET /lnurlp/tx/invoice`, and
  `GET /lnurlp/wait/invoice` stay the invoice forward of the usernames
  `cb`, `tx`, and `wait`. The new routes do not match the literal path
  segment `invoice`.

## Opening a payment

### By a till charge

`POST /pos` keeps its body, its checks, its 409 for a second pending
charge, and its response. It does not wait for the in-process creation
lock. It inserts the charge and ends the account's `open` shop payment,
if there is one, in one database transaction that first locks the
account row (`SELECT … FROM account WHERE id = $1 FOR UPDATE`, as
`account-merge.ts` does). The payment ends with `end_reason`
`superseded`, or `window` when its window has already passed.

After `POST /pos` answers, the api starts the creation procedure for the
charge in the background, so that the first scan finds the payment
ready. `DELETE /pos` keeps its behaviour. It cancels the charge and
ends the charge's `open` shop payment with `end_reason` `cancelled` in
one database transaction with the same account row lock.

When the charge watch marks the charge `paid`, it settles the charge's
shop payment in the same transaction, again under the account row lock:
when the settled hash is the shop payment's `payment_hash`, the shop
payment moves to `paid`; when it is the Spark invoice or another BOLT11,
an `open` shop payment ends with `end_reason` `charge_paid`. No moment
exists in which the charge is cancelled or paid while its shop payment
is still `open`.

A charge has at most one shop payment. When that shop payment ended,
for example after a refund, the charge stays payable by Lightning only
until its window ends.

### Account merge

`mergeAccounts` (`src/lib/account-merge.ts`) moves every row that
references the merged account to the surviving one, under both account
row locks. A shop payment's BOLT11 pays the wallet it was minted for, so
the merge handles shop payments first, in the same transaction:

- When the merged account has a shop payment that is neither `paid`
  nor closed, the merge returns
  `{ ok: false, error: 'shop_payment_open' }`, as it returns
  `both_grants`, and changes nothing. Such a payment's BOLT11 can still
  be paid, and it pays the merged account's wallet, which the merge
  does not carry over. The operator route
  `POST /debug/accounts/merge` answers it with **409**
  `{ "error": "A payment is already open" }`, the text `POST /pos`
  uses. A payment is paid or closed after its final settlement read, 10
  minutes after its BOLT11 expired, and the merge can be repeated then.
- The merged account's other shop payments are `paid` or closed and
  never change again; they move with the account like every other row.
- The merge deletes a pending charge of the merged account when the
  surviving account has one. It first locks that charge's row
  (`SELECT … FOR UPDATE`), as it already locks both accounts, then
  deletes the charge's `pos_charge_invoice` rows, whose `charge_id` has
  no cascade, and then the charge. A `recordInvoice` for that charge
  waits on the row lock in its foreign-key check and then fails, which
  the invoice routes log as `pos.invoice.record_failed`, as they do for
  any store error, so no row can appear between the two deletes. Any shop
  payment of that charge is paid or closed by the first rule, and
  `pos_charge_id` is `ON DELETE SET NULL`, so the delete clears its
  link.

### By the payer

`POST /pay/:username/payment` opens a payment for an amount the payer
entered on the payment page. It is a separate route from
`POST /pay/:username/invoice`, whose checks and texts it reuses: that
route mints one invoice for any amount and keeps no state, while this one
opens a shop payment that pins the sticker, carries Orchestra quotes and
their replacements, and is paid at most once. No session. The body is
`{ "amountSats": <integer> }`. CORS is the page's origin list, the same
as for `POST /pay/:username/invoice`. The checks run in this order:

| Order | Condition                                                                                                                                                         | Response                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | Invalid username, unknown account, no verified wallet, or no LNURL server config.                                                                                 | **404** `{ "error": "Not found" }`                                                           |
| 2     | The wallet's pay request cannot be resolved.                                                                                                                      | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 3     | The body is not a positive whole number of sats.                                                                                                                  | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 4     | A till charge is pending.                                                                                                                                         | **409** `{ "error": "A payment is already open", "code": "payment_open" }`                   |
| 5     | The amount is outside that pay request's minimum and maximum.                                                                                                     | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 6     | A username without stablecoin rows (see Route details), or `ORCHESTRA_BASE_URL`, `ORCHESTRA_API_KEY`, `SHOP_EVM_RPC`, or `SHOP_REFUND_ADDRESS` is not configured. | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |
| 7     | This account started 10 creations in the last minute, or the api started 60 in the last minute.                                                                   | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |
| 8     | The mint fails, or the BOLT11 amount differs.                                                                                                                     | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 9     | No pair commits, `findChargeForPayment` fails with an error (step 4), or step 8 finds its request at least 16 s old or its client disconnected.                   | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |

Orders 1, 2, 3, 5, and 8 are the checks and texts of
`POST /pay/:username/invoice`. Order 4 comes before the range check, because a
pending charge pins that range to the charge amount. Orders 4 and 6 run again under the creation lock. Order 7 runs only
there, once per creation, because `IpRateLimiter.allow` records every
call it allows: the api-wide counter is asked first, and the account
counter only when it allows, so a refusal by the account counter leaves
one extra hit on the api-wide counter at most. The counters in order 7 are two `IpRateLimiter` instances, keyed by
the account id as `src/routes/wallet-report.ts` does and by one fixed
key for the whole api; they count started creations in their 60 s
window. Like every `IpRateLimiter`, each container of a deploy keeps its
own: with two containers an account can start up to 20 creations in a
minute and the api up to 120. No money depends on it, and a shared
counter would add a database write before every Orchestra call. They do not depend on the client address, because the web app's
proxy forwards none.

An `open` payer-opened payment is always replaced: it ends with
`end_reason` `replaced`, and the new payment is created. A stranger's
amount therefore stays on the sticker only until the next payer enters
an amount. A payer whose payment was replaced while sending still gets
their transfer confirmed: the proof moves the `ended` payment to
`accepted`, and the Tether settlement poll sees a different
`quote.payment` and reports settled.

Order 7 limits what one stranger can cost. It also means a stranger can
switch off the stablecoin rows of one shop, or of all shops, for a minute. The next payer then pays by Lightning invoice, and a
stranger's amount stays on the sticker until its window ends. This is
an accepted risk.

**Response** `200`
`{ "payment": "<uuid>", "expiresAt": "<window_ends_at>" }`. The page then
fetches the pay link and checks that `quote.payment` is this id.

### Creation procedure

One procedure creates a shop payment, for a charge or for a payer:

1. Take the account's in-process creation lock. A second caller for the
   same account waits for the first and then re-reads.
   `translate-note.ts` keeps in-flight work in a map the same way.
2. Re-check the state under the lock: end a lapsed `open` payment of the
   account with `end_reason` `window`, stop when the payment to create
   already exists, stop for a charge that is no longer pending, and for a
   payer stop with order 4 when a charge is now pending.
3. Read the route list and select the candidate pairs ([Methods](#methods)).
4. Mint one BOLT11 with `requestGiftInvoice`, as
   `POST /pay/:username/invoice` does, with one 4 s deadline for both of its calls, the pay-request
   resolve and the callback. The implementing change adds that deadline
   as a parameter and hands each call the time left until it through
   `lnurlServerFetch`, whose default of 15 s (`LNURL_SERVER_TIMEOUT_MS`)
   stays for other callers. Decode the BOLT11 with `decodeBolt11` and
   check the amount, and compute its expiry as [Lifetimes](#lifetimes)
   states, first. A wrong amount stops the procedure, and nothing is recorded. A
   payment hash that another charge's or a payer's shop payment already
   holds stops it the same way, as a failed mint (order 8), and logs
   `shop.alert.duplicate_invoice`, so that another payment's invoice is
   never recorded against a charge. When the charge's own shop payment
   holds it, the api uses that payment, as step 8 states for a conflict,
   and the procedure ends. Only when no shop payment holds the hash, and
   only for a charge, record the payment hash against that
   charge's id with `posStore.recordInvoice`, when the amount equals the
   charge amount, as the invoice forward does. `recordInvoice` returns
   its outcome from inside its claim transaction, as the
   [Payment hash claim](#payment-hash-claim) states. On `other_payment`
   the procedure stops as after a failed mint (order 8) and logs
   `shop.alert.duplicate_invoice`. On `recorded` or `this_charge` it goes
   on. On `not_open` the charge was no longer open at the issue time, and the procedure ends as step 8 ends for such a charge, without that
   alert. When `recordInvoice` fails with an error, the api logs
   `pos.invoice.record_failed`, as the invoice routes do, and writes nothing; a fetch then answers today's pinned Lightning request.
   A payer creation never records against a charge, also not against one
   that appeared after step 2. It reads instead whether the hash is
   already recorded against a charge, with
   `posStore.findChargeForPayment({ paymentHash })`; a hit stops it as a
   failed mint (order 8) with `shop.alert.duplicate_invoice`, so that one settlement can never confirm both a charge and a payer's payment. When `findChargeForPayment` fails with an error, the payer creation writes nothing and answers order 9. These reads
   run before the insert; the [Payment hash claim](#payment-hash-claim)
   closes the moment between them and the insert, across both
   containers.
5. In parallel, read `eth_gasPrice` for each candidate chain and request
   one Orchestra quote per candidate pair, within 3 s for the whole step;
   a retry runs only while that time lasts. Pairs beyond what the quote share of the Orchestra
   budget allows are skipped, in the order of [Methods](#methods).
6. Keep each quote that commits and passes [Offer checks](#offer-checks).
7. When none is kept, write nothing, and the account's next creation in
   this container waits 60 s; the other container of a deploy keeps its
   own wait, so during a deploy an account can see two creations in 60 s. Until then a fetch answers today's pinned Lightning request, and
   `POST /pay/:username/payment` answers order 9.
8. Insert the payment with its BOLT11, its first quote, and its offers in
   one database transaction that first takes the
   [Payment hash claim](#payment-hash-claim) and then locks the account
   row, as `POST /pos` does. In that transaction:
   - For a charge, the api locks the `pos_charge` row too
     (`SELECT … FOR UPDATE`) and inserts only while the charge is still
     `pending`. A charge that was cancelled, expired, or paid meanwhile
     gets no shop payment, and the sticker keeps today's behaviour.
   - For a payer, a pending charge means nothing is written, and the
     answer is order 4 (**409** `payment_open`). An `open` payer-opened
     payment is ended with `end_reason` `replaced` before the insert,
     after the hash claim found no
     other payment holding the hash, so a `payment_hash` conflict ends
     nothing.

   The implementing change adds this transactional port to the shop
   payment store, the way `MergeDb.begin` wraps `sql.begin` for
   `account-merge.ts`. The row lock serialises the creation with
   `POST /pos`, also across the two containers of a deploy. The unique indexes are the backstop. The insert is
   `INSERT … ON CONFLICT DO NOTHING RETURNING id`, so a conflict never
   aborts the transaction and raises no `23505`: an empty result is the
   only conflict signal of this insert. The api then reads which row
   holds the conflicting value, and the reads and the second insert named
   below run in the same transaction under the same locks. A conflict on `payment_hash`
   reads the payment that holds the hash. When it is this charge's own
   shop payment, the conflict is handled like any other empty result below: the
   api uses that payment. Otherwise the LNURL server returned an invoice
   that another payment already holds: the procedure stops as after a
   failed mint (order 8) and logs `shop.alert.duplicate_invoice`. The hash claim makes this branch a backstop. For a charge it then also deletes
   the `pos_charge_invoice` row for that hash when step 4's
   `recordInvoice` inserted it (returned `recorded`); a row this attempt did
   not insert stays, whichever charge it belongs to. It writes nothing
   else. Any other
   empty result, a conflict on another of the payment's unique indexes
   (offers never conflict, see [Offer checks](#offer-checks)), does not
   insert again blindly: under the same locks the api reads the row that won. When
   that row is the shop payment of this charge, or of this payer
   request, the api uses it, the fetch answers as for an open amount,
   and the background creation from `POST /pos` ends. When it is another
   `open` payment of the account, the rules above apply: a payer request
   ends it with `replaced`, or answers order 4 when a charge is pending,
   and a charge ends it with `superseded`; then the insert runs once
   more. No answer ever carries another payer's amount.

The procedure stays within 8 s: 1 s for the route list, 4 s for the
mint, and 3 s for the quotes. Waits on the creation lock and on the
locks of step 8 come on top, so step 8 also checks, after it holds its
locks, that its request arrived, as the api received it, less than 16 s ago,
and for a payer request that the client has not disconnected (the
request's abort signal is not set); otherwise it writes nothing and
answers order 9. No creation therefore inserts a payment
more than 16 s after its request arrived. Every external call runs outside the
database transaction. A losing caller's BOLT11 stays recorded against the
charge and can still pay the charge. Its Orchestra quotes are never shown
and expire unused.

### Payment hash claim

A payment hash belongs to one payment only, either a charge's
`pos_charge_invoice` row or a `shop_payment`, across both containers.
Both writers of a payment hash claim it the same way:
`posStore.recordInvoice`, which the implementing change turns into an
explicit transaction (`sql.begin`), also when `POST /pay/:username/invoice`
and the invoice forward call it; and the transaction of step 8 of the
creation procedure. The first statement of each transaction is
`SELECT pg_advisory_xact_lock($1, $2)`, the two-key form, as
`admitWithinPlaces` in `src/lib/funding-store.ts` takes its lock in a
transaction: `$1` is a fixed namespace constant for payment hashes, and
`$2` is the first 32 bits of the hash as a signed integer. The two-key
form never meets the one-key lock of `admitWithinPlaces`, and two
hashes that share their first 32 bits only wait for each other. A following
statement reads `pos_charge_invoice` and `shop_payment` for the hash. A
row of another payment stops the writer before it ends or inserts
anything: `recordInvoice` returns `other_payment`, and the creation stops as a
failed mint (order 8) with `shop.alert.duplicate_invoice`. A row of the
same charge or the same shop payment is handled as steps 4 and 8 state.
`recordInvoice` returns one of four outcomes instead of today's
boolean, decided inside its transaction: `recorded` when it inserted the
row; `this_charge` when the hash is already recorded against this charge
or held by this charge's shop payment; `other_payment` when another
charge's `pos_charge_invoice` row or another payment's `shop_payment`
holds it; and `not_open` when the charge was not open at the issue time it is given (`issuedAtMs`, which the invoice routes take before the mint, as today, and step 4 takes as the request time), which today's insert decides: its status is neither `pending` nor `expired`, or its `expires_at` is not after the issue time. A charge that was open at the issue time and has expired since still gives `recorded`.
A memory boot, without `DATABASE_URL`, keeps every row in one process,
as `InMemoryPosStore` does today. There the claim is one in-process map from
payment hash to the charge or shop payment that holds it, which
`InMemoryPosStore.recordInvoice` and `InMemoryShopPaymentStore` share:
each writer reads the map and adds its entry in one synchronous step,
without an `await` in between, so the same rule and the same outcomes
hold without PostgreSQL.
Step 8 takes its locks in this order: the hash claim, the account row,
then the `pos_charge` row; `recordInvoice` takes only the hash claim
before its insert, so two writers of one hash meet at the claim and
never wait for a lock the other took first. When `recordInvoice` returns
`other_payment`, neither the invoice route nor the invoice forward hands
out that BOLT11, and both log `shop.alert.duplicate_invoice`: the
invoice route `POST /pay/:username/invoice` answers as for a failed
mint, **502** `{ "error": "Lightning Address could not be resolved" }`,
and the invoice forward `GET /lnurlp/:username/invoice` answers as when
its upstream fails, **503**
`{ "error": "Lightning address service is unavailable" }`
(`src/routes/lnurl-server.ts`). On every other outcome both hand it out as
today. When `recordInvoice` fails with an error, both still log
`pos.invoice.record_failed` and hand the invoice out, as today, so that a
database error does not stop Lightning payments. Such an invoice
reaches a payer of the charge unchecked only when the LNURL server has
also minted a payment hash that another payment holds. One
settlement can therefore never confirm a charge and another payment, and
no payer of a charge gets another payment's invoice when `recordInvoice`
returns an outcome. Both routes call
`recordInvoice` only for a pending charge, as today, and check nothing
without one. A BOLT11 that a shop payment holds then reaches a plain payer
only when the LNURL server mints the same payment hash twice; paying it
settles that shop payment once, Orchestra's later payment of the same
BOLT11 fails, and a stablecoin deposit for it goes to the refund address,
as for any order that cannot pay ([States](#states)).

## Quotes

A replacement quote is created under the creation lock. A second fetch
in the same container waits for it and returns it. The replacement runs steps 3, 5, and 6 of
the creation procedure for the same sats and the same BOLT11, within
4 s, and inserts one `shop_quote` with the offers that pass in a transaction
under the account row lock. That transaction first increments
`shop_payment.replacements` with a conditional update (`status` is `open`, `replacements` still
has the value read when the replacement started and is below 4, and at
least 45 s remain before `window_ends_at`), and inserts the quote only
when that update changed one row. Otherwise it inserts nothing, re-reads
the payment, and the fetch answers with the quote that is current now, or
as for an ended payment. The in-process lock is per container; this
update makes a replacement in the other container of a deploy win or
lose as a whole, so two containers never use two replacements for one
expiring quote. The losing container's Orchestra quotes are never shown
and expire unused. The payment id stays. A payment never gets a second BOLT11, so the shop can only
be paid once through it.

When no new offer meets the BOLT11 margin or commits, the replacement is
a Lightning-only quote: its `transferAmounts` has only the Lightning
entry, and its `quote.expiration` is `window_ends_at`. A Lightning-only
quote is never replaced.

The previous quote stays valid for a callback until its own
`quote.expiration`, so a wallet that fetched it just before the
replacement can still get its detail. A payment has at most 4
replacements, and none in the last 45 s of its window. A Lightning-only row
made without an Orchestra call is not a replacement.

## Offer checks

An Orchestra quote becomes an offer only when every check holds:

- HTTP 200, `targetAmountOut` equals the sat count, and `amountIn` is a
  positive integer string;
- `amountIn` is at least `requiredAmountIn` and at most
  `maxAcceptedAmountIn`, when those are present;
- `transaction.chainId` equals the table `chainId`;
- `transaction.to` equals the table contract, compared in lowercase;
- `transaction.value` is zero;
- `transaction.data` is exactly 68 bytes: `a9059cbb`, 12 zero bytes, the
  20-byte deposit address, and the 32-byte amount, where the deposit
  address equals `depositAddress` and the amount equals `amountIn`;
- the deposit address appears in no other offer, neither stored nor in
  the same batch, so that one deposit address belongs to one offer; the unique index `shop_offer_deposit_idx` enforces it. Offers are
  inserted with `ON CONFLICT (deposit_address) DO NOTHING`, in the
  creation and in a replacement, so a conflict drops only that offer and
  logs `shop.alert.shared_deposit_address`; it never fails, replaces, or
  deletes the payment or the quote, and the quote's `transferAmounts`
  holds only the offers that were inserted;
- `expiresAt` minus the funding margin is at least 45 s in the future;
- the BOLT11 expires at least 600 s after `expiresAt`;
- the stored spot quote (`FxSpotStore.latest()` in
  `fx-spot-store.ts`, which `startFxSpotWorker` refreshes every
  `FX_SPOT_REFRESH_MS`, 5 min) has a USD rate with an `asOf` younger than 10 minutes, and `amountIn` in USD is at most 5 % above the
  sats' value at that spot. The rate is parsed with
  `parseUsdPerBtc` (`src/lib/money.ts`), which scales USD per BTC by
  10^8, and the check runs in BigInt with no rounding:
  `amountIn × 10^16 × 100 ≤ sats × rate × 10^decimals × 105`.
  `satsToUsdCents` is not used here, because it rounds to whole cents
  and a few sats would round up to a cent. The creation never waits for a spot fetch; without
  a fresh rate no stablecoin pair is offered and the payment stays
  payable by Lightning, because an offer whose price cannot be checked
  could overcharge the payer.

A failed check means the pair is not offered. The api logs
`shop.offer.rejected` with the name of the check. A shared deposit
address also logs `shop.alert.shared_deposit_address`.

## Callback

`GET /lnurlp/cb/:username`. No session. It is a separate route from
`GET /lnurlp/:username/invoice`, whose LUD-06 answer it repeats for the
open amount: OpenCryptoPay needs a details callback that answers
`method` and `asset` per quote, and Tether 1.11.0 derives the proof URL
by replacing the `cb` path segment with `tx`, which the existing path
cannot give. CORS `*`, methods `GET, OPTIONS`,
`Cache-Control: no-store`, 120 requests per minute per client address.
The client address is `readClientRequestMeta(headers).clientIp`
(`src/lib/request-meta.ts`), as the pay link's limiter uses it; the
proof and wait routes key their limits the same way. Over that limit it
answers **503**, reason `Too many requests`, as the
proof route does, because Tether 1.11.0 reads a 400 or 404 here as a
final answer.

### LNURL amount path

A request without `method` is the LUD-06 second step. `amount` is in
millisats. When the account has an open amount and `amount` equals its
sats times 1000, the response is `{ "pr": "<bolt11>", "routes": [] }`
for the payment's BOLT11. Otherwise the response is **400**, reason
`Amount does not match this payment`. This path never mints.

### Detail

A request with `method` is checked in this order:

| Order | Condition                                                                                                                   | Response                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1     | `quote` or `asset` is missing, or a key is repeated.                                                                        | **400**, reason `That payment is not offered` |
| 2     | `quote` is neither the current nor the previous quote of this username's open amount, or its `quote.expiration` has passed. | **404**, reason `Quote expired`               |
| 3     | `method=Lightning` and `asset=BTC`.                                                                                         | **200** `{ "pr": "<bolt11>" }`                |
| 4     | A stablecoin method and asset that the quote offers with `available` true.                                                  | **200** with the stablecoin detail below      |
| 5     | Anything else.                                                                                                              | **400**, reason `That payment is not offered` |

Tether 1.11.0 reads the 404 as `QUOTE_EXPIRED` and the 400 as
`RAIL_UNAVAILABLE`.

The stablecoin detail has the four fields the standard and DFX return
for an EVM chain:

```json
{
  "expiryDate": "<quote.expiration>",
  "blockchain": "<method>",
  "uri": "ethereum:<token>@<chainId>/transfer?address=<deposit address>&uint256=<amountIn>",
  "hint": "Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to <PUBLIC_BASE_URL>/lnurlp/tx/<username>"
}
```

The URI uses the offer's lowercase contract, the decimal `chainId`, the
lowercase deposit address, and `amountIn` in decimal.
`BinanceSmartChain` uses `ethereum:` with chain id 56, as the standard
states. The `hint` ends with the proof URL and no punctuation after it.
The first detail response for an offer sets
`shop_offer.detail_issued_at`. A repeat returns the same detail while
the quote is valid.

## Proof

`GET /lnurlp/tx/:username`. No session. CORS `*`, methods
`GET, OPTIONS`, `Cache-Control: no-store`, 120 requests per minute per
client address. A request over that limit is answered from the stored
row when its proof is already stored. Otherwise it is **503**, reason
`Too many requests`, not 429, because Tether 1.11.0 reads any status
below 500 as a final refusal.

The query carries `quote`, `method`, an optional `asset`, and exactly one
of `tx` or `hex`. Unknown keys are ignored. A repeated `quote`,
`method`, `asset`, `tx`, or `hex` key is **400**, reason
`Payment was not accepted`. `quote` must be a quote of a shop payment of
this username, current or earlier. Otherwise the response is **404**,
reason `Quote expired`.

The whole request stays within 18 s, below Tether's 20 s. Each RPC call
times out after 3 s, and Orchestra gets at most 10 s. When the budget
runs out, the response is **503** and the work continues in the
[Watcher](#watcher).

### Accepted forms

- `tx`: `0x` and 64 hexadecimal characters, or the 64 characters without
  `0x`. After an optional `0x` is removed, `normalizeHex32`
  (`src/lib/proof.ts`) checks and lowercases the 64 characters, and the
  stored form is `0x` plus that result. It is the hash of a
  transaction the wallet already published, or the hash of an ERC-4337
  user operation.
- `hex`: an optional `0x`, then an even number of hexadecimal characters,
  at least 100 and at most 4096. It is a signed EVM transaction that the
  wallet did not publish. Its hash is the Keccak-256 of the signed bytes.

The standard names `hex` for EVM chains. DFX accepts `tx` on EVM as
well, and Tether 1.11.0 sends only `tx`. The api accepts both.

### Repeat

Before any chain read, the api looks for a stored proof of this quote's
offers whose `tx_hash` or `user_op_hash` equals the normalised `tx`, or
whose `tx_hash` equals the hash of `hex`. When one exists, the request is
a repeat and answers from that row; when several exist, which happens
after the orders duty stored a second transfer of the same transaction,
it answers from the `accepted` row, else from the row whose offer's
asset equals `asset`, else from the oldest row (table in
[Storing and submitting](#storing-and-submitting)). Before it answers, the
request brings the row forward within its budget: a row without a log
index reads the receipt once, as in [Verification of `tx`](#verification-of-tx),
and fills in its log and value; an unresolved row with a log index whose
`last_submit_at` is empty or at least 2 s old is resubmitted, at most 5
times per minute for one proof, under the rules of
[Calls](#calls). A held row is not resubmitted. So a wallet whose
deposit Orchestra detected first still gets its **200** within its
quick retries. A hash that only proofs of other quotes hold is
not a repeat: one ERC-4337 bundle can carry the transfers of several
payers, so the request goes on to verification. A second transfer to
another offer of the same quote in the same transaction is not stored by
a repeat; its Orchestra order reaches the api through the orders duty of
the [Watcher](#watcher), which stores it as a `detected` proof.

### Verification of `tx`

1. Read `eth_getTransactionReceipt` on the method's endpoint. When the
   result is null, read `eth_getUserOperationReceipt` with the same hash
   (the ERC-4337 bundler method). From a user-operation receipt the api
   uses that user operation's own `logs` and its
   `receipt.transactionHash`. `user_op_hash` keeps the value the wallet
   sent.
2. Neither receipt is found: store a lookup row (`shop_proof_lookup`) and
   answer **503**, reason `Transfer not found yet`. The wallet retries,
   and the [Watcher](#watcher) keeps looking. A quote holds at most 4
   lookup rows: the count and the insert run in one transaction that first
   locks the quote's `shop_quote` row (`FOR UPDATE`), so two containers
   cannot pass the count together. Past that, the answer is the same **503** without a row;
   the wallet's retries and Orchestra's own detection still apply.
3. The transfer did not succeed: **400**, reason
   `Payment was not accepted`. Nothing is stored. For a transaction
   receipt that is a `status` other than `0x1`. For a user-operation
   receipt it is a `success` other than `true`; the `status` of its
   nested bundle receipt does not decide, because a bundle can succeed
   while one of its user operations fails.
4. Find the ERC-20 `Transfer` logs (topic
   `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`)
   whose emitting address is an offer contract of this quote and method,
   and whose `to` topic is that offer's deposit address. When `asset` is
   present, only the offers of that asset count. A log whose value equals
   the offer's `amountIn` comes first; otherwise the first such log is
   used. It selects the offer.
5. No such log: **400**, reason `Payment was not accepted`. Nothing is
   stored, because no coin reached Orchestra for this offer. When every
   such log is already claimed by a proof of another quote, the reason is
   `Transaction already used`.

One proof is one log, identified by `(chain_id, tx_hash, log_index)`.
The transferred value is stored. A transfer of a different amount is
still submitted, because only Orchestra can fill or refund it.

### Verification of `hex`

1. Decode the signed transaction. Legacy (EIP-155), EIP-2930, and
   EIP-1559 transactions are accepted.
2. Its chain id must equal the method's `chainId`. `to` must be an offer
   contract of this quote and method. `value` must be zero. `data` must
   equal that offer's transfer data byte for byte. When `asset` is
   present, it must equal the offer's asset. Its fee must reach the
   offer's `minFee` the way DFX checks it: the gas price of a legacy or
   EIP-2930 transaction, or for EIP-1559 the lower of `maxFeePerGas` and
   the current recommended gas price (the `minFee` formula applied to the
   current `eth_gasPrice`) plus `maxPriorityFeePerGas`.
3. A failed check: **400**, reason `Payment was not accepted`. Nothing is
   stored and nothing is broadcast.
4. The api stores the proof with `raw_hex`, then sends
   `eth_sendRawTransaction`. A JSON-RPC error whose message contains
   `already known` or `nonce too low` counts as sent when
   `eth_getTransactionByHash` then finds the hash. An error whose message
   contains `insufficient funds`, `invalid`, or `intrinsic gas` records
   the proof `refused` and answers **400**. Any other error and any
   transport error answer **503**, and the watcher sends the transaction
   again.
5. The proof is submitted once its receipt with status `0x1` is found,
   so that Orchestra can see the deposit. A receipt with a
   status other than `0x1` records the proof `refused`. A transaction
   that is still unknown keeps the proof unresolved: the receipts duty
   sends and reads it until `give_up_at`, so a transaction mined late is still
   submitted, and after `give_up_at` the proof becomes `stuck` like any
   unresolved proof.
   An Orchestra order found later still moves it, as [States](#states)
   states.

The api broadcasts only transactions that passed step 2, so its
endpoints are not an open relay.

### Storing and submitting

Every path that stores a proof uses the same step: the route, the lookup
duty, and the order duty.

1. Look for a stored proof of the same offer and transaction. A row
   without `log_index` (a `detected` or `hex` proof) takes the log index
   and value; a row with that log index is a repeat. A found row without
   `user_op_hash` takes the request's, so that a repeat by that hash finds
   it. A row without an
   order takes the order that the order duty found for the same
   transaction and offer. Otherwise insert the
   `shop_proof` row with `give_up_at` 24 h ahead. A lost insert (`23505`)
   re-reads the winning row and answers from it.
2. Submit it to Orchestra ([Calls](#calls)) while it is unresolved, once
   it has a log index; a row that already holds an order, such as a
   `detected` row, is not submitted. A
   `hex` proof without a receipt yet is submitted by the submits duty
   after the receipts duty fills its log index. When the request's budget
   is used up before the submit, the watcher submits it.
3. When the submit returns an `orderId` that another row already holds,
   the two rows are one deposit. When that row belongs to the same offer,
   the rows are merged as in step 4. When it belongs to another offer,
   Orchestra counted the deposit there, and the newer row is recorded
   `refused` with `refusal` `tx_used`.
4. A `23505` on `shop_proof_log_idx` or `shop_proof_order_idx` while a
   row is filled in means both rows are one deposit. The api reads the
   row that holds the value. When it belongs to another offer, the row
   being filled in is recorded `refused` with `refusal` `tx_used`, as in
   step 3, and nothing is deleted. When it belongs to the same offer, in
   one transaction
   the api keeps the row that holds an order, or else the older row,
   reads the other row's log index, value, order, and `user_op_hash`,
   keeps any value the kept row already has, deletes the other
   row, then writes those values onto the kept row, because the unique
   indexes are not deferrable. It answers from the kept row.

Every transaction that changes a proof's `result`, and step 4, first
locks the payment's `shop_payment` row (`SELECT … FOR UPDATE`), then
reads the payment's status and which proof is `accepted`, then locks every proof row it changes
with one `SELECT … FOR UPDATE` ordered by id. Two decisions about one
payment therefore never run at the same time, also across the two
containers. The payment row comes before the proof rows everywhere, and
the settlement step, which locks the account, `pos_charge` and
`shop_payment` rows, locks no proof row, so no two of these wait for
each other in opposite order.

A row without a log index gets it from the repeat path or from the
receipts duty of the [Watcher](#watcher).

Every unresolved verified proof is submitted once it has a log index, including when the payment is
`ended`, `paid`, or already `accepted`, and after its quote expired.
Orchestra holds the coin, and the submit lets it fill or refund the
deposit when its own detection missed it.

| Stored result                | Response                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `accepted`                   | **200** `{ "txId": "<tx_hash>" }`                                                                            |
| `superseded`                 | **400**, reason `Another transfer is paying this payment`                                                    |
| `late`                       | **400**, reason `Invoice expired`                                                                            |
| `refunded`                   | **400**, reason `The transfer was refunded`                                                                  |
| `failed`                     | **400**, reason `The transfer was not completed`                                                             |
| `refused`                    | **400**, reason `Transaction already used` when `refusal` is `tx_used`, otherwise `Payment was not accepted` |
| unresolved, held, or `stuck` | **503**, reason `Payment is being confirmed`                                                                 |

`txId` is the transaction hash, as DFX returns it. Orchestra's `orderId`
is stored as `provider_order` and is not sent to the wallet. A repeat of
an accepted proof is **200** with the same body and never creates a
second payment.

When a proof becomes `accepted`, the payment moves as [States](#states)
states, and in the same step it stops being the open amount. The next
pay-link poll with `timeout` is therefore the 404 above.

## Wait

`GET /lnurlp/wait/:payment` serves the payment page. No session. CORS
`*`, `Cache-Control: no-store`, 120 requests per minute per client
address; over that limit it answers **429** with the body in
[Error bodies](#error-bodies) and the text `Too many requests`, the
pay link's text. `:payment`
must be a shop payment id. Otherwise the response is
**404**, reason `Not found`, the text `POST /pay/:username/invoice` uses
for an id this service does not have.

The response is
`{ "status": <DFX status>, "paymentStatus": <status>, "invoiceExpiresAt": <BOLT11 expiry> }`.
It answers at once when `status` is not `Pending`, and at once when
the request has no `since` query. With `?since=<paymentStatus>`, the
last `paymentStatus` the page saw, it waits while the stored
`paymentStatus` still equals that value, as `GET /messages/:id?sinceSats=`
waits while the sats have not passed the client's value: up to `WAIT_SATS_TIMEOUT_MS` (25 s) and checking every
`WAIT_SATS_POLL_MS` (250 ms), both in `src/routes/messages.ts`. Then it
answers with the state on hand.

| `paymentStatus`              | `status` (DFX `PaymentLinkPaymentStatus`)                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `paid`                       | `Completed`                                                                                    |
| `ended` with `closed_at` set | `Cancelled` when `end_reason` is `superseded`, `replaced`, or `cancelled`; otherwise `Expired` |
| any other                    | `Pending`                                                                                      |

As at DFX, every status except `Pending` is final: only a paid or a
closed payment leaves `Pending`, and neither changes again. A client that
shows "on its way" reads `paymentStatus`.

## Error bodies

Every error on the callback, the proof, and the wait route, and every
new error on the pay link, uses one body that LUD-06 wallets, DFX-built
wallets, Tether 1.11.0, and this repository's own clients can all read:

```json
{
  "statusCode": 400,
  "message": "<text>",
  "error": "<text>",
  "status": "ERROR",
  "reason": "<text>"
}
```

LUD-06 reads `status` and `reason`. The DFX app reads `statusCode` and
`message`. Tether 1.11.0 shows `message`. This repository's clients read
`error`, which carries the text here, while DFX puts the HTTP reason
phrase there. The existing pay-link errors keep their text and gain the
other fields. The 404 for no pending payment is the standard's example
body above. `POST /pay/:username/payment` uses the repository's
`{ "error", "code" }` form, because only the payment page calls it.

## Orchestra

### Configuration

| Variable              | Kind   | Rule                                                                                                                                                 |
| --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCHESTRA_BASE_URL`  | config | Absolute `https` origin without a path. The documented origin is `https://orchestration.flashnet.xyz`.                                               |
| `ORCHESTRA_API_KEY`   | secret | The server key (`fn_…`). A client key (`fnp_…`) is refused. Never logged.                                                                            |
| `SHOP_EVM_RPC`        | secret | A JSON object from decimal `chainId` to an absolute `https` JSON-RPC URL. A URL may hold a provider key, so the whole value is secret. Never logged. |
| `SHOP_REFUND_ADDRESS` | config | One EVM address, `0x` and 40 hexadecimal characters, that 21.gifts controls. It is sent as `refundAddress` on every quote.                           |

`resolveShopPaymentConfig` in `config.ts` reads them, following
`resolveLnurlServerConfig`: an invalid value turns the feature off, and
the process still boots. Secrets go to the secret store and config goes
to the deployment environment, as for the existing variables. The
endpoint of a chain must answer `eth_getTransactionReceipt`,
`eth_getTransactionByHash`, `eth_gasPrice`, `eth_sendRawTransaction`,
and `eth_getUserOperationReceipt`.

### Calls

Every call with a body sends `Content-Type: application/json`,
`Authorization: Bearer <ORCHESTRA_API_KEY>`, and `X-Idempotency-Key`
(1 to 255 printable ASCII characters). The error body is
`{ "error": { "code", "message" } }`. The wallet never sees `message`.

Key rule, from Orchestra's idempotency rules: a timeout, a 5xx, HTTP 429,
and HTTP 409 `idempotency_in_progress` are retried with the same key and
body. After any other answer a new attempt uses a new key. The api never
changes the body under a key.

Budget: each endpoint has its own in-process budget per minute, so one
kind of call never crowds out another. The budget is its own counter,
not an `IpRateLimiter`: it reserves submit slots for the watcher and
orders waiting calls by priority, which a single limit per key cannot
express. Status and history reads share
50, which keeps two containers during a deploy below Orchestra's 120
order lookups per IP. Submits: 30, of which proof requests may use at
most 20 and the watcher always keeps 10. Within those 20, the first
submit of a new proof goes before a repeat's resubmit. A submit claims
its slot with a conditional update of `last_submit_at`, so two requests
do not submit one proof within the same 2 s; a later repeat reuses the
key and gets Orchestra's stored answer or `409 idempotency_in_progress`.
Route-list fetches: 25 ([Methods](#methods)).
Quotes: 240, where a creation or replacement that finds the budget used
up requests fewer pairs, in the order of [Methods](#methods), or none. A
proof request that gets no submit call answers **503** and leaves the
submit to the watcher. A watcher duty that gets no call waits for the
next tick. Release check 7 confirms these numbers with the staging key,
history included. A 429 pauses calls to that endpoint until its
`Retry-After` in seconds, or else until its `X-RateLimit-Reset`, an
absolute time in milliseconds.

- **Routes**: `GET {base}/v2/orchestration/routes` with the server key.
- **Quote**: `POST {base}/v1/orchestration/quote` with `sourceChain`
  (table), `sourceAsset` (`USDT` or `USDC`), `destinationChain`
  `lightning`, `destinationAsset` `BTC`, `amount` (the sat count as an
  integer string), `amountMode` `exact_out`, `recipientAddress` (the
  payment's BOLT11), `tag` (the shop payment id), and `includeCalldata`
  true. The body sends no `slippageBps`, so the route's default applies;
  the sat count is fixed by `exact_out` and checked through
  `targetAmountOut`. `refundAddress` is `SHOP_REFUND_ADDRESS`
  ([Refund address](#refund-address)). A transport timeout, HTTP 429, HTTP 409 `idempotency_in_progress`,
  HTTP 503, or another 5xx is retried once with the same key and body
  inside the step's budget, as the key rule states. Any other answer
  means the pair is not offered.
- **Submit**: `POST {base}/v1/orchestration/submit` with
  `{ "quoteId": <provider_ref>, "txHash": <tx_hash> }`. The body sends no
  `sourceAddress`: it is optional for a deposit address of one quote, and
  for an ERC-4337 payer the transfer's `from` is not the transaction's
  sender, which Orchestra may treat as a mismatch.
  Orchestra requires `sourceAddress` only on a shared deposit address;
  the api offers no deposit address it has seen on another offer
  ([Offer checks](#offer-checks)), and release check 11 confirms for every offered pair that
  Orchestra's EVM deposit addresses belong to one quote. Should Orchestra
  still return a shared address the api has not seen, the submit stays
  without `sourceAddress` and the deposit depends on Orchestra's own
  detection; this is an accepted residual risk.
  - HTTP 200 with `orderId`: the proof gets that order, and the returned
    `status` is stored as its `order_status`.
  - HTTP 400 with `error.code` `xchain_deposit_mismatch` (a transaction
    without a positive matching deposit): refused. A
    `hex` proof is submitted only after its receipt is found
    ([Verification of `hex`](#verification-of-hex)), so a mismatch is
    definitive for it too.
  - HTTP 409 with `error.code` `quote_expired` (the Lightning invoice
    expired): the proof is `late`, and the api stops submitting it.
  - Everything else leaves the proof unresolved: a timeout, HTTP 503
    `xchain_deposit_pending` or `xchain_deposit_verification_unavailable`,
    another HTTP 409, HTTP 429, HTTP 200 without `orderId`, any other 4xx
    or 5xx. HTTP 401, 403, and any other 400 also log
    `shop.alert.orchestra_request`, because they point at a key or request
    problem, not at the deposit.
- **History**: `GET {base}/v1/orchestration/history?address=<BOLT11>`
  with the server key, `limit=200`, and `offset` paging, one page per
  read, lists the orders for that recipient address. It finds every
  order of every quote of a payment, including a second order on one
  deposit address. The api matches each order to its offer by `quoteId`.
  HTTP 400, 401, and 403 change nothing and log
  `shop.alert.orchestra_request`; other errors and timeouts change
  nothing.
- **Status**: `GET {base}/v1/orchestration/status` with `id=<orderId>`
  and the server key, for a known order; Orchestra answers status only
  to an authenticated caller. HTTP 404 `not_found` means no order. The
  api stores `order.status` as `order_status`. Final statuses are
  `completed`, `refunded`, `failed`, `fallback_delivered`, and `expired`;
  [States](#states) states what each does to the proof. `unfulfilled` can resume and is watched like a status in progress. When
  `supersededByOperationId` is set, the api does not move the proof to
  that order: the orders duty stores the successor order, which carries
  its own `sourceTxHash`, as its own proof, so every row keeps its own
  transaction and order, and the proof table decides which proof is
  `accepted`. The proof of the replaced deposit keeps its `unfulfilled` order: it
  is held like any proof with that status, or, when it was already
  `accepted`, stays `accepted` until another proof's order completes or
  the final settlement read ends the payment. Orchestra leaves such an
  order `unfulfilled` for good, so the order-status duty stops for it
  (`next_status_at` is cleared) and logs no `shop.alert.order_stuck`,
  because the successor's own proof is watched. In the same step it
  stores the successor's id as the proof's `superseded_by_order`, sets the
  payment's `successor_wait_until` to 24 h ahead when it is empty or
  earlier, and sets its `next_history_at` to now when it is empty, so the
  orders duty reads the history again and stores the successor even after
  the payment's order watch has ended. A replaced proof that was
  never `accepted` stays held and answers a repeat with **503**, while the
  till and the payment page show the payment's state.
  A progressing status can make a proof `accepted`, as [States](#states)
  states. `refunding`, `unfulfilled`, and an unknown status hold a proof that is
  not `accepted`: it answers **503** and is not accepted until [States](#states) accepts
  it or its order is final. A proof that is already
  `accepted` keeps that state through them, and the till keeps showing
  "on its way", because Orchestra can still complete the order; only a
  final status moves it, as [States](#states) states. HTTP 400, 401, and 403 change nothing and log
  `shop.alert.orchestra_request`, as for history. A timeout and every
  other HTTP error change nothing. An unknown status is logged once per
  order.

The api registers no webhook and does not call
`/v1/orchestration/estimate`.

## Watcher

`startPosPaidWorker` starts a second tick for these duties, every 2 s
and without overlap, separate from the charge watch's tick, so that a
slow shop call never delays a till confirmation. The duties run in this
order. Each duty has its own budget of
external calls per tick, separate from the charge watch, and each call
times out after 5 s. Each duty takes its rows in order of its own
next-try column, oldest first, and what is left waits for the next tick.
A cadence below is the earliest next try, not a promise. Orchestra calls
also count against the budget in [Calls](#calls).

| Order | Duty               | Calls          | Rows                                                                                                     | Cadence                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------ | -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | End lapsed windows | 0              | `open` payments whose `window_ends_at` has passed                                                        | Every tick, one conditional update.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2     | Settlement         | 8, in parallel | Payments that are not `paid` and not closed; `accepted` and charge-backed payments first                 | Every 5 s for 15 min after creation, then every 30 s, and a final read 10 min after the BOLT11 expiry. Only a successful read that reports the invoice unpaid closes a payment; a failed final read is retried at the same cadence. Closing an `accepted` payment ends it with `expired_unpaid` and logs `shop.alert.accepted_unpaid`. The LUD-21 `/verify` read the charge watch uses.                                                                        |
| 3     | Orders             | 1, odd ticks   | Payments with `next_history_at` due, oldest first, paid and closed ones included                         | History by the payment's BOLT11 every 10 s, one page per read. An order whose id no proof holds as `provider_order` is stored through [Storing and submitting](#storing-and-submitting) as a `detected` proof, and duty 8 takes it over. An order whose `recoveredFromOperationId` a proof holds is stored the same way, as its own proof, as the status read in [Calls](#calls) states. An order without `sourceTxHash` yet stores nothing and is read again. |
| 4     | Lookups            | 4              | `shop_proof_lookup` rows that are not done                                                               | After 10 s, 30 s, and 60 s, then every 2 min for one hour. A found receipt runs the `tx` verification; a verified transfer is stored through the same step, and a refusal (steps 3 and 5 of [Verification of `tx`](#verification-of-tx)) stores nothing. Either way the duty sets `done_at`. After one hour it sets `done_at` and logs `shop.proof.lookup_expired`; Orchestra's own detection still applies. A failed read leaves the row open.                |
| 5     | Receipts           | 4              | `hex` proofs whose transaction is not found or has no receipt, and `detected` proofs without a log index | Read the receipt, or send a `hex` transaction again, after 30 s, then every 2 min: a `hex` proof while it is unresolved and before its `give_up_at`, a `detected` proof for at most 24 h. A receipt fills the log index and value, or refuses as [Verification of `hex`](#verification-of-hex) states. A `detected` proof whose receipt has no matching transfer log stays held, stops being read, and logs `shop.alert.detected_mismatch`.                    |
| 6     | Submits            | 1              | Unresolved proofs that may still be submitted and have a log index                                       | Submit after 10 s, 30 s, and 60 s, then every 5 min, under the key rule and the submit budget in [Calls](#calls).                                                                                                                                                                                                                                                                                                                                              |
| 7     | Stuck proofs       | 0              | Unresolved proofs past `give_up_at`; held proofs are not touched                                         | Mark `stuck` and log `shop.alert.proof_stuck`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8     | Order status       | 1, even ticks  | Proofs with an order whose `order_status` is not final                                                   | Status by `id` every 10 s for 10 min, then every 60 s, until a final status, an `unfulfilled` status with `supersededByOperationId` ([Calls](#calls)), or 24 h after the order was found. Only the 24 h end logs `shop.alert.order_stuck`.                                                                                                                                                                                                                     |

Duties 3 and 8 take turns: duty 3 reads on odd ticks and duty 8 on even
ticks, one read each, so neither can starve the other. That is at most 30 reads per minute, within the status budget, and in
one container no payment or order is read faster than every 10 s. The
two containers of a deploy each run their own ticks, so during a deploy
a row can be read by both; their budgets together stay below
Orchestra's limit, as [Calls](#calls) states. One order can then be read
by both containers less than 3 s apart, against Orchestra's guidance that
one order should be polled no faster than every 3 s; the api accepts
that for the overlap of a deploy, because the per-IP limit still holds. `next_history_at` is set when the first
detail of a payment is issued and cleared when the order watch of its
last offer ends, except while some proof of the payment has a
`superseded_by_order` that no proof holds as `provider_order` and
`successor_wait_until` has not passed ([Calls](#calls)). When that time
passes first, the duty logs `shop.alert.successor_missing` and clears
`next_history_at` and `successor_wait_until` together. One read is one page; `history_offset` keeps the next
offset, and a short page starts the next read at offset 0 again. Duty 3
reads one payment until the order watch of its last offer with an issued
detail ends, also after the payment is paid or closed, because a later
deposit still makes an order that Orchestra must fill or refund.

The BOLT11 settling marks the payment `paid` and runs `markPaid` for its
charge. When the payment's BOLT11 settles after its charge was already paid by
another invoice, the api logs `shop.alert.double_settled`: the shop then
received the charge twice and refunds the payer directly. When it
settles after its charge was cancelled, the api logs
`shop.alert.cancelled_settled`: the shop received a payment for a
cancelled charge and refunds the payer or hands over the goods. The
charge stays `cancelled`; the watcher does not reopen it.

## Rows

The implementing change adds these tables in
`docs/schema/shop_payment.sql`, with the idempotent DDL in
`shop-payment-store.ts` (`InMemoryShopPaymentStore` and
`PostgresShopPaymentStore`). `migrateShopPaymentSchema` runs in
`boot-stores.ts` before `migrateDbChangeSchema`, so `db_change` records
every write. No column holds a secret, so `db_change_redact` is
unchanged.

```sql
CREATE TABLE IF NOT EXISTS shop_payment (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES account (id),
  amount_sats        bigint NOT NULL CHECK (amount_sats > 0),
  pos_charge_id      uuid UNIQUE REFERENCES pos_charge (id) ON DELETE SET NULL,
  bolt11             text NOT NULL,
  payment_hash       text NOT NULL UNIQUE,
  bolt11_expires_at  timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('open', 'accepted', 'paid', 'ended')),
  end_reason         text CHECK (end_reason IN ('window', 'superseded', 'replaced', 'cancelled',
                       'charge_paid', 'orchestra_refunded', 'orchestra_failed', 'proof_refused',
                       'expired_unpaid')),
  window_ends_at     timestamptz NOT NULL,
  replacements       integer NOT NULL DEFAULT 0 CHECK (replacements BETWEEN 0 AND 4),
  next_settle_at     timestamptz,
  next_history_at    timestamptz,
  history_offset     integer NOT NULL DEFAULT 0,
  successor_wait_until timestamptz,
  created_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  paid_at            timestamptz,
  ended_at           timestamptz,
  closed_at          timestamptz,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (closed_at IS NULL OR status = 'ended')
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_payment_account_open_idx
  ON shop_payment (account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS shop_payment_history_idx
  ON shop_payment (next_history_at) WHERE next_history_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_payment_settle_idx
  ON shop_payment (next_settle_at) WHERE status <> 'paid' AND closed_at IS NULL;

CREATE TABLE IF NOT EXISTS shop_quote (
  id                uuid PRIMARY KEY,
  payment_id        uuid NOT NULL REFERENCES shop_payment (id),
  expires_at        timestamptz NOT NULL,
  transfer_amounts  jsonb NOT NULL,
  created_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_quote_payment_idx ON shop_quote (payment_id, created_at);

CREATE TABLE IF NOT EXISTS shop_offer (
  id                uuid PRIMARY KEY,
  quote_id          uuid NOT NULL REFERENCES shop_quote (id),
  method            text NOT NULL,
  chain_id          integer NOT NULL,
  asset             text NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  token_address     text NOT NULL,
  deposit_address   text NOT NULL,
  amount_in         numeric(78, 0) NOT NULL CHECK (amount_in > 0),
  required_amount_in     numeric(78, 0),
  max_accepted_amount_in numeric(78, 0),
  decimals          smallint NOT NULL,
  min_fee           numeric(78, 0) NOT NULL,
  provider_ref      text NOT NULL,
  idempotency_key   text NOT NULL,
  expires_at        timestamptz NOT NULL,
  detail_issued_at  timestamptz,
  created_at        timestamptz NOT NULL,
  UNIQUE (quote_id, method, asset)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_offer_deposit_idx ON shop_offer (deposit_address);

CREATE TABLE IF NOT EXISTS shop_proof (
  id                 uuid PRIMARY KEY,
  offer_id           uuid NOT NULL REFERENCES shop_offer (id),
  payment_id         uuid NOT NULL REFERENCES shop_payment (id),
  source             text NOT NULL CHECK (source IN ('tx', 'hex', 'detected')),
  chain_id           integer NOT NULL,
  tx_hash            text NOT NULL,
  log_index          integer,
  user_op_hash       text,
  raw_hex            text,
  transfer_amount    numeric(78, 0),
  idempotency_key    text NOT NULL,
  result             text CHECK (result IN ('accepted', 'superseded', 'late', 'refunded', 'failed',
                       'refused', 'stuck')),
  provider_order     text,
  superseded_by_order text,
  order_status       text,
  order_found_at     timestamptz,
  refusal            text CHECK (refusal IN ('mismatch', 'expired_order', 'hex_rejected', 'tx_used')),
  submit_stopped     boolean NOT NULL DEFAULT false, -- set when a submit answered 409 quote_expired
  sent_at            timestamptz,
  last_submit_at     timestamptz,
  give_up_at         timestamptz NOT NULL,
  next_submit_at     timestamptz,
  next_receipt_at    timestamptz,
  next_status_at     timestamptz,
  tries              integer NOT NULL DEFAULT 0,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL,
  CHECK (source <> 'tx' OR (log_index IS NOT NULL AND transfer_amount IS NOT NULL)),
  CHECK (source <> 'hex' OR raw_hex IS NOT NULL),
  CHECK (result NOT IN ('accepted', 'superseded', 'refunded', 'failed') OR provider_order IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_log_idx
  ON shop_proof (chain_id, tx_hash, log_index) WHERE log_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_unlogged_idx
  ON shop_proof (chain_id, tx_hash, offer_id) WHERE log_index IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_order_idx
  ON shop_proof (provider_order) WHERE provider_order IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_payment_accepted_idx
  ON shop_proof (payment_id) WHERE result = 'accepted';
CREATE INDEX IF NOT EXISTS shop_proof_user_op_idx
  ON shop_proof (chain_id, user_op_hash) WHERE user_op_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_proof_submit_idx ON shop_proof (next_submit_at);
CREATE INDEX IF NOT EXISTS shop_proof_receipt_idx ON shop_proof (next_receipt_at);
CREATE INDEX IF NOT EXISTS shop_proof_status_idx ON shop_proof (next_status_at);

CREATE TABLE IF NOT EXISTS shop_proof_lookup (
  id           uuid PRIMARY KEY,
  quote_id     uuid NOT NULL REFERENCES shop_quote (id),
  method       text NOT NULL,
  asset        text,
  chain_id     integer NOT NULL,
  hash         text NOT NULL,
  next_try_at  timestamptz NOT NULL,
  tries        integer NOT NULL DEFAULT 0,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (chain_id, hash, quote_id)
);
CREATE INDEX IF NOT EXISTS shop_proof_lookup_due_idx
  ON shop_proof_lookup (next_try_at) WHERE done_at IS NULL;
```

A `detected` proof stores the order's `sourceTxHash` with `log_index`
null until the receipts duty, or a wallet's `tx` for the same deposit,
fills it in. A `late` proof may lack an order when its submit answered
`409 quote_expired`. A lost insert on `shop_proof_lookup` re-reads the
winning row.

Ids come from `crypto.randomUUID()`, the same form as `pos_charge.id`:
lowercase, eight-four-four-four-twelve. A `quote` or `:payment` value that is not that form is unknown; the
shape check is the `UUID` pattern of `src/lib/pos-store.ts`, moved to a
shared helper, and a matching value is lowercased before the lookup. Addresses and
hashes are stored in lowercase with `0x`. `shop_quote.transfer_amounts`
is the exact array that quote served, so a later price cannot rewrite
it.

## Till

- `POST /pos` and `DELETE /pos` change only as
  [By a till charge](#by-a-till-charge) states.
- `GET /pos` adds `shopPayment` to `charge`:
  `{ "id": <uuid>, "status": <status> }`, or `null`. The till shows
  `accepted` as "on its way". It shows the charge as paid only when the
  charge is `paid`. The response is otherwise unchanged.
- The charge watch keeps finding a charge paid when the Spark invoice
  or any BOLT11 recorded against it settles. Orchestra paying the shop
  payment's BOLT11 is one of those, because step 4 of the creation
  procedure records that BOLT11 against the charge. The charge watch's
  `markPaid` now also settles the charge's shop payment in the same
  transaction under the account row lock, as
  [By a till charge](#by-a-till-charge) states. When the BOLT11 settles
  after the charge watch ended, the shop payment's `paid` step runs
  `markPaid`.

A cashier hands over goods only when the till shows the charge paid,
never because a payer shows a success screen. The wallet reports success
at `accepted`, before the sats arrive.

## Payment page

21gifts/app makes these changes. This repository does not serve the
page.

- It keeps today's flow: a charge's amount is locked, and otherwise the
  payer enters sats or fiat with the page's existing conversion rule.
- With a charge, it fetches the pay link. When the response is an
  OpenCryptoPay pay request, with or without stablecoin entries, the page
  uses its `quote.payment` as the payment id and shows that payment's
  BOLT11 from the callback's Lightning detail. It never mints a second
  invoice then. Only when the response is the plain Lightning request
  does the page keep today's flow and mint with
  `POST /pay/:username/invoice`.
- With an entered amount it calls `POST /pay/:username/payment` instead
  of `POST /pay/:username/invoice`. On **409** `payment_open` it reloads
  and shows the till charge. When the first call answers
  **503** `stablecoin_unavailable` or another 4xx, it falls back to
  `POST /pay/:username/invoice`, which is today's Lightning-only path.
  When the first call ends in a timeout, a transport error, or another
  5xx, the page does not know whether a payment was opened, because an
  open payment it cannot see could be paid next to a second invoice.
  It repeats the same call once. A new payer
  amount replaces any payment the lost answer opened, so at most one
  stays open. Replacing
  it is safe: the page never received that payment's invoice or quote,
  so this payer cannot pay it, and like any replaced payer amount it
  can only be paid by a wallet that fetched it before, which
  [States](#states) handles; a page-side retry identifier is not
  added, because the pay link already shows which payment is open and
  replacement keeps one. From then on, until a call returns a payment,
  it handles every answer of `POST /pay/:username/payment`, the repeat
  and every "Try again" press included, for any amount as follows:
  - A payment ends this state and is shown.
  - A **409** `payment_open` reloads and shows the till charge, as on
    the first call.
  - A **503** `stablecoin_unavailable` or another 4xx makes the page
    fetch the pay link, once at least 20 s have passed since the most
    recent call that ended in a timeout, a transport error, or another
    5xx: a creation inserts no payment more than 16 s after its request
    arrived ([Creation procedure](#creation-procedure)), so by then every
    creation the page started has inserted its payment or written
    nothing. When it shows no open payer amount, the page
    falls back to `POST /pay/:username/invoice`. When it shows one, or
    the fetch fails, the page shows "This payment could not be started.
    Try again." with a button that repeats the call.
  - A timeout, a transport error, or another 5xx shows the same text
    and button.

  After a success it fetches the pay link and checks that
  `quote.payment` is the payment it opened. When it is not, another
  payer replaced the amount, and the page shows "Another payer entered
  an amount first. Enter yours again." and the amount field.

- It fetches the pay link on its own origin, without `timeout`. It shows
  one line per method and asset from `transferAmounts`, with the quote's
  expiry, and fetches again when the quote expires.
- The Wallet of Satoshi button and the desktop invoice QR stay as they
  are today and use the BOLT11 the page shows.
- It tells the payer to scan the sticker with Tether Wallet or another
  OpenCryptoPay wallet. Tether
  1.11.0 opens only `https://…?lightning=` links, so the page shows no
  `lightning:` stablecoin deeplink.
- It polls `GET /lnurlp/wait/:payment` with its payment id, the first
  time without `since` and then with the last `paymentStatus` it saw, and follows
  `paymentStatus`: "waiting" (`open`), "on its way" (`accepted`),
  "paid", or "ended" (`ended`). On `accepted` and on `ended` it hides
  the invoice and the Wallet of Satoshi button at once, so the invoice is
  not paid a second time by Lightning, and it keeps polling, because a transfer made in time can still move the
  payment to `accepted` or `paid` until `status` is final.
- The app adds a proxy route for `POST /pay/[username]/payment`, like the
  existing `POST /pay/[username]/invoice` route. `/lnurlp/*` reaches the
  api without an app route.

The page never calls Orchestra, never holds a key, and never records
paid.

## Tether Wallet 1.11.0

These facts are read from Tether Wallet for Android 1.11.0 (134). A
later build counts only after it has been read the same way.

**Scan.** A QR or link is OpenCryptoPay when it is an `http` or `https`
URL with a query parameter `lightning` (key compared without case) that
holds a valid LNURL. A bare LNURL or a `lightning:` link goes to the
plain LNURL path and never shows a stablecoin. The Android manifest
registers only the `https` and `tetherwallet` schemes.

**Pay request.** The wallet decodes the LNURL and sends a GET without a
query. It waits 20 s. The response is OpenCryptoPay when `standard` is
`OpenCryptoPay` or `possibleStandards` contains it. Otherwise the wallet
uses the plain LNURL path, with a 10 s timeout: a fixed amount when
`minSendable` equals `maxSendable`, and otherwise an amount entry that
shows `send.LNURL_AMOUNT_RANGE` for an amount outside the bounds. A 404
with an OpenCryptoPay body means no pending payment. Any other 404 means
an invalid link.

**Rails.** The wallet compares its own fixed list with
`transferAmounts`:

| Rail          | `method`    | `asset` | Proof   | Offered by the wallet |
| ------------- | ----------- | ------- | ------- | --------------------- |
| Lightning     | `Lightning` | `BTC`   | invoice | yes                   |
| Spark         | `Spark`     | `BTC`   | `tx`    | yes                   |
| Polygon USDT  | `Polygon`   | `USDT`  | `tx`    | yes                   |
| Arbitrum USDT | `Arbitrum`  | `USDT`  | `tx`    | yes                   |
| Ethereum USDT | `Ethereum`  | `USDT`  | `tx`    | yes                   |
| Tron USDT     | `Tron`      | `USDT`  | `tx`    | no (withheld)         |

The match is exact. An entry needs `available` true and an asset of that
name. The wallet has no USDC token. It asks for a detail only when its
balance covers the amount and the fee.

**Detail.** It needs `callback` and `quote.id`. It sends `callback`, then
`?` (or `&` when the callback has a query), then `quote`, `method`, and
`asset`. HTTP 400 is "rejected" (`RAIL_UNAVAILABLE`), HTTP 404 is
"expired" (`QUOTE_EXPIRED`), and any other error is thrown. It reads
`pr` for Lightning and otherwise `uri`, `hint`, and `expiryDate`. The URI
must be a complete EIP-681 transfer on the rail's chain, and its token
must be the wallet's USDT contract for that chain. The send deadline is
the earlier of `quote.expiration` and `expiryDate`; a value that
`Date.parse` cannot read is skipped.

**Send.** Before sending, the wallet checks locally that the amount
still matches the URI (`AMOUNT_CHANGED`) and that the deadline has not
passed (`QUOTE_EXPIRED`). It does not fetch a new quote then; the payer
scans again. It pays from an ERC-4337 account through a bundler, then
waits up to 180 s for the on-chain hash. The hash it sends is the hash of
the bundle transaction. It sends the user-operation hash only when the
receipt has neither `hash` nor `transactionHash`.

**Proof.** A `hint` that holds an `http` or `https` URL on the same host
with a path segment `tx` gives the proof URL; trailing punctuation is cut
off. Without such a hint, the proof URL is `callback` with every path
segment `cb` replaced by `tx`. The query is kept. The wallet sends
`quote`, `method`, `asset`, and `tx`. It makes up to 3 attempts, after
pauses of 1 s and 3 s, retrying only when the request throws (HTTP 5xx
or no response). Any status below 500 is a final refusal. Success is a
2xx with a non-empty string `txId`. A background run retries a thrown
proof up to 3 times, 60 s apart, and may wait for the hash again, up to
15 minutes after the detail was fetched.

**Settlement.** Only after a 2xx on one of the three attempts does the
wallet poll the URL it first fetched, adding `timeout=0`, every 3 s for
30 s. It reports settled when an answer is a 404 with an OpenCryptoPay
body, or names a different `quote.payment`. Otherwise it reports
unconfirmed. A proof that succeeds only in a background run shows
`send.OPEN_CRYPTO_PAY_NOT_SETTLED` on screen, even when the shop is
paid. The till, not the wallet screen, decides.

**Results.** At the end the wallet shows `send.OPEN_CRYPTO_PAY_SETTLED`,
`send.OPEN_CRYPTO_PAY_UNCONFIRMED`, or `send.OPEN_CRYPTO_PAY_NOT_SETTLED`.
While scanning it can show `home.OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT`,
`home.OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE`,
`home.OPEN_CRYPTO_PAY_QUOTE_EXPIRED`,
`home.OPEN_CRYPTO_PAY_RAIL_SHORTFALL`, and
`home.OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS`. While sending it can show
`send.OPEN_CRYPTO_PAY_AMOUNT_CHANGED` and
`send.OPEN_CRYPTO_PAY_CONFIRMING`. The wallet does not read `minFee` or
`displayQr`.

### How this document meets it

| Wallet behaviour                                  | Rule here                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Opens only `https://…?lightning=`                 | The sticker has that form. The page shows no `lightning:` stablecoin deeplink.                                                |
| Exact method and asset names                      | [Methods](#methods) uses `Ethereum`, `Polygon`, `Arbitrum`, and `USDT`, and requests those pairs first.                       |
| Sends `tx` and `asset` on EVM                     | [Proof](#proof) accepts `tx` and an optional `asset`.                                                                         |
| Pays from an ERC-4337 bundle                      | A proof is one transfer log, a hash held only by other quotes is no repeat, and a user-operation hash works.                  |
| Retries a proof after a 5xx                       | [Repeat](#repeat) answers from the stored row before verification, fills in a missing log, and resubmits an unresolved one.   |
| 400 and 404 on the callback mean different things | An expired quote is 404, and a pair that is not offered is 400.                                                               |
| A proof status below 500 is final                 | Pending, unresolved, and rate-limited proofs answer 503, never 429.                                                           |
| 20 s request timeout                              | A fetch waits at most 8 s for a creation and 4 s for a replacement; a proof request stays within 18 s.                        |
| Refuses to send close to the deadline             | A fetch replaces a quote with less than 45 s left, except in the window's last 45 s, and the previous quote keeps its detail. |
| Sends until `quote.expiration`                    | `quote.expiration` is 30 s before Orchestra's own deadline for the deposit.                                                   |
| Hint URL first, then the `cb` segment rewrite     | The hint names the proof URL with no punctuation after it. Username `cb` and a final `.` are excluded.                        |
| Settled only on 404 or a new `quote.payment`      | Acceptance frees the sticker in the same step, and the `timeout` poll answers 404.                                            |
| Token must be the wallet's USDT contract          | [Offer checks](#offer-checks) require the table contract.                                                                     |
| Unreadable dates are skipped                      | Every timestamp is `toISOString` output.                                                                                      |

## Deviations

| Topic                 | DFX or the standard                                                                                                    | Here                                                                                                                                            | Reason                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No pending payment    | Waits 10 s by default, `timeout` without an upper bound, then 404.                                                     | Without `timeout`: the Lightning pay request. With `timeout`: at most 10 s, then 404.                                                           | The sticker must stay payable by every LNURL wallet, and those never send `timeout`. The cap bounds held requests.                                                                                                                        |
| Expired quote         | DFX: 400 `Quote is expired` until its job marks the quote expired, then 404 `No matching actual quote found`.          | Always 404 `Quote expired`.                                                                                                                     | Tether 1.11.0 reads only 404 as an expired quote. The standard names no code.                                                                                                                                                             |
| Opening by the payer  | DFX: `POST /lnurlp/:id` with a fiat amount, answered with the pay request.                                             | `POST /pay/:username/payment` with sats, answered with the payment id.                                                                          | The repository's page routes live under `/pay`, a shop payment has no fiat price, and the page reads the pay link.                                                                                                                        |
| `requestedAmount`     | The fiat price.                                                                                                        | BTC.                                                                                                                                            | A shop payment is a sat amount, and no fiat price exists.                                                                                                                                                                                 |
| Ids                   | `plq_…`, `plp_…`.                                                                                                      | UUIDs.                                                                                                                                          | Repository convention (`pos_charge.id`). The standard fixes no id form.                                                                                                                                                                   |
| Statuses              | `Pending`, `Completed`, `Cancelled`, `Expired`.                                                                        | `open`, `accepted`, `paid`, `ended`.                                                                                                            | Accepted and paid differ here. `/lnurlp/wait` returns the DFX name next to the state.                                                                                                                                                     |
| Wait                  | DFX: 404 for a payment that is not pending, a hold of up to 60 s, and `Cancelled` at once when a payment is cancelled. | 200 with the state, a hold of up to 25 s, and `Cancelled` or `Expired` only when the payment closes, 10 minutes after its BOLT11 expired.       | The page needs `accepted`, `paid`, and `ended` apart, and reads `paymentStatus` for the moment a payment ends. A payment stays open to a late confirmation until its BOLT11 can no longer settle. 25 s stays below common proxy timeouts. |
| Proof success         | DFX: 200 `{ txId }` after its own broadcast of `hex`, or after the first confirmation of `tx`.                         | 200 `{ txId }` once the proof is `accepted`; 503 while it is unresolved or held; 400 when it is superseded, late, refunded, failed, or refused. | Orchestra, not 21.gifts, takes the coin, so only its order, for an amount within the bounds, means the payment was taken.                                                                                                                 |
| Late proof            | DFX: 404 once the quote is no longer actual.                                                                           | Verified and submitted to Orchestra.                                                                                                            | Orchestra holds the coin, and a submit lets it fill or refund the deposit.                                                                                                                                                                |
| Proof not found yet   | DFX: 400.                                                                                                              | 503 and a lookup row.                                                                                                                           | Tether 1.11.0 retries only on 5xx, and a 400 would end its proof attempt.                                                                                                                                                                 |
| Proof rate limit      | DFX: 429.                                                                                                              | 503.                                                                                                                                            | Tether 1.11.0 reads 429 as a final refusal.                                                                                                                                                                                               |
| Different amount      | DFX: refuses an underpayment.                                                                                          | Submitted to Orchestra.                                                                                                                         | Orchestra holds the coin and decides whether to fill or refund it.                                                                                                                                                                        |
| User-operation hash   | Not part of DFX or the standard.                                                                                       | Accepted as `tx`.                                                                                                                               | Tether 1.11.0 pays from an ERC-4337 account.                                                                                                                                                                                              |
| URL tweaking (path B) | DFX serves `GET /pl` on its API.                                                                                       | Not served.                                                                                                                                     | The site has no `app` host to swap for `api`. The standard recommends path A.                                                                                                                                                             |
| Sticker path          | DFX: `/pl?lightning=`.                                                                                                 | `/pl/?lightning=`.                                                                                                                              | Printed stickers carry this form. The web app redirects `/pl/` to `/pl` and keeps the query.                                                                                                                                              |
| Error body            | DFX: `{ statusCode, message, error }` with the HTTP reason phrase in `error`.                                          | Those fields plus `status` and `reason`, with the text in `error`.                                                                              | One body for LUD-06, DFX-built wallets, Tether 1.11.0, and this repository's clients.                                                                                                                                                     |
| Quote per fetch       | DFX creates a quote on every fetch.                                                                                    | One quote until less than 45 s remain, at most 4 replacements.                                                                                  | Each quote costs one Orchestra call per pair, and reuse keeps the amounts stable for a wallet that fetches twice.                                                                                                                         |
| `displayQr`           | Controls DFX's link QR.                                                                                                | Always `false`.                                                                                                                                 | The page shows the BOLT11 QR, not a link QR.                                                                                                                                                                                              |
| Extra fields          | `externalId`, `mode`, `route`, and in the 404 also `transferAmounts` and `currency`.                                   | Omitted.                                                                                                                                        | They have no meaning for a shop payment, and the standard does not require them.                                                                                                                                                          |

## Logging

Each event is one `logEvent` line with `paymentId`, and with `quoteId`,
`offerId`, `proofId`, `providerRef`, or `orderId` where it applies. The
api never logs a key, an RPC URL, raw `hex`, or a BOLT11.

- `shop.payment.opened`, `.accepted`, `.paid`, `.ended`, `.closed`
- `shop.offer.rejected`, `shop.route.mismatch`
- `shop.proof.stored`, `.detected`, `.submitted`, `.accepted`,
  `.superseded`, `.late`, `.refunded`, `.failed`, `.refused`,
  `.unresolved`, `.lookup_expired`, `.retried`
- `shop.orchestra.error`, `shop.orchestra.rate_limited`,
  `shop.orchestra.budget_exhausted`
- `shop.alert.orchestra_request`, `shop.alert.order_failed`,
  `shop.alert.order_stuck`, `shop.alert.late_deposit`,
  `shop.alert.proof_stuck`, `shop.alert.detected_mismatch`,
  `shop.alert.accepted_unpaid`,
  `shop.alert.double_settled`, `shop.alert.cancelled_settled`,
  `shop.alert.duplicate_invoice`, `shop.alert.successor_missing`,
  `shop.alert.shared_deposit_address`, and
  `shop.alert.accepted_long` (a payment `accepted` for more than one
  hour)

The operator alerts on `shop.alert.*` and reads the five tables through
`GET /debug/db`, as for other tables. `POST /debug/shop-proofs/:id/retry`
uses the existing debug authorization. It moves a `stuck` proof back to
unresolved, sets `give_up_at` 24 h ahead, sets `next_receipt_at` to now
for a `hex` proof without a log index, so the receipts duty reads and
sends its transaction again, and logs `shop.proof.retried`.

## Implementation

The implementing change adds:

- `src/lib/shop-payment-store.ts` and `docs/schema/shop_payment.sql`;
- `src/lib/orchestra.ts` (the client), `src/lib/evm-rpc.ts` (the five
  RPC calls), and `src/lib/shop-payment.ts` (creation, quotes, and proof
  verification);
- the routes `POST /pay/:username/payment`, `GET /lnurlp/cb/:username`,
  `GET /lnurlp/tx/:username`, `GET /lnurlp/wait/:payment`, and
  `POST /debug/shop-proofs/:id/retry`, plus the new cases of
  `GET /.well-known/lnurlp/:username`, `POST /pos`, `DELETE /pos`, and
  `GET /pos`;
- `resolveShopPaymentConfig`, and the four variables in CONTRIBUTING's
  environment table and in its `webServer.env` pin list;
- the [Payment hash claim](#payment-hash-claim) in `recordInvoice`, as an
  explicit transaction, and in step 8 of the creation procedure, and the
  four outcomes `recordInvoice` returns instead of a boolean, and the
  failed-mint answer of the invoice route and the invoice forward on
  `other_payment`, and the in-process hash map that the two in-memory
  stores share on a memory boot;
- the shop payment check in `mergeAccounts` with its `shop_payment_open`
  result, and the lock (`SELECT … FOR UPDATE`) and delete of a deleted
  charge's row and its `pos_charge_invoice` rows;
- the trimming of `canonicalGoalAmount` moved to a shared helper for
  the canonical decimal form, with the decimals as a parameter;
- the `UUID` pattern of `src/lib/pos-store.ts` moved to a shared helper
  that the shop payment routes use too;
- a deadline parameter on `requestGiftInvoice` that covers both of its
  calls;
- `invoiceStillOpen` and `DEFAULT_INVOICE_EXPIRY_MS` moved from
  `src/routes/repayment.ts` to `src/lib/bolt11.ts`, with an expiry
  function both use, so repayment and the shop payment compute an
  invoice's expiry one way;
- the shop payment step in the charge watch's `markPaid` transaction;
- the transactional port with the account row lock, used by `POST /pos`
  and by the creation procedure;
- the two `IpRateLimiter` instances of order 7, and the Orchestra call
  budget, which counts calls per endpoint and minute rather than
  requests per key;
- the dependency `viem` at an exact version, for transaction decoding,
  Keccak-256, and ABI encoding. Nothing in this repository decodes EVM
  transactions today;
- `SPEC.md` rows and `docs/handbook/` sections for every new route and
  export, CONTRIBUTING's test section and e2e exception list for the new
  Playwright project, and a `CONCEPT.md` decisions-log row.

It reuses `requestGiftInvoice`, `posStore.recordInvoice`, `markPaid`,
`decodeBolt11`, `inspectBolt11`, `IpRateLimiter` for the per-address
limits, `resolveLnurlServerConfig`, `startPosPaidWorker`, the LUD-21
`/verify` read, `isUniqueViolation`, the `FxSpotStore` spot quote, the
`WAIT_SATS_TIMEOUT_MS` and `WAIT_SATS_POLL_MS` clocks, and the
`pos-store.ts` patterns for conditional updates and idempotent DDL.

### Tests

- Vitest with fakes for Orchestra, the RPC endpoints, and the LNURL
  server covers every row of every table in this document at 100 %, as
  CONTRIBUTING requires. It also covers the account merge with a shop payment of the merged
  account that is not paid or closed (refused), with only paid or closed
  ones (moved), and with two pending charges where the deleted one has a
  recorded invoice (rows and link cleared),
  and an order first seen as `refunding` or with an unknown status (held,
  **503**).
- The default end-to-end suite boots without these services. Its
  `webServer.env` leaves the four new variables empty, and each new
  route answers its default 404 there, as the other LNURL routes do.
- A second Playwright project, `shop-payment`, has its own `webServer`
  that boots the api with stand-ins for Orchestra, one EVM RPC endpoint
  per Tether rail, and the LNURL server, plus a verified-wallet fixture.
  Its driver is a TypeScript port of the client behaviour in
  [Tether Wallet 1.11.0](#tether-wallet-1110), including the status-code
  rules, the hint and `cb` rewrite, the bundle hash, the user-operation
  hash, the proof retries, and the settlement poll. With `USDT` on each
  of `Ethereum`, `Polygon`, and `Arbitrum` it must reach settled: when the
  first attempt is accepted, when the first attempt gets 503 and the
  stand-in accepts the resubmit of a later attempt, and when the stand-in
  detected the deposit and paid before the proof arrived, and when the
  stand-in detected the deposit and its order is still running. It must also
  reach the plain LNURL path with no open amount, `QUOTE_EXPIRED` on an
  expired quote, and `RAIL_UNAVAILABLE` on a pair that is not offered. A
  stand-in order that Orchestra creates without a submit must make the
  payment `accepted` through the watcher, a second completed order must
  move acceptance to it, and a dust transfer to the deposit address must
  not take acceptance from the payer.

## Release checks

Only a live run can prove these facts. The stablecoin rows stay off in
production until each one passes on staging. The person who runs them
records each result in the pull request that turns the feature on.

1. Tether Wallet 1.11.0 on a real Android phone, with a balance that
   covers the amount and the fee, pays a staging shop payment with USDT
   on Polygon, on Arbitrum, and on Ethereum, and reports
   `OPEN_CRYPTO_PAY_SETTLED` each time. The shop payment ends `paid`. One
   run has the api's submit switched off, to prove that Orchestra detects
   a deposit from an ERC-4337 account by itself. One run has it on, to
   prove that Orchestra accepts the submit of a bundle hash.
2. A quote request with `SHOP_REFUND_ADDRESS` and without `slippageBps`
   for `exact_out` into a BOLT11 commits on each offered pair, and the
   returned `amountIn` equals the amount in `transaction.data`. A pair
   that Orchestra refuses stays off.
3. The BOLT11 that the staging mint returns lives at least 1020 s, and
   its timestamp is within 60 s of the api's clock at the request.
4. A deposit made just after `expiresAt` is filled or refunded to
   `SHOP_REFUND_ADDRESS`, and a submit after the BOLT11 expired answers
   `409 quote_expired`. Each answer is recorded.
5. Orchestra accepts parallel quotes for different pairs, and later
   replacement quotes, that name the same BOLT11, and gives each quote
   its own deposit address.
6. Two submits of the same deposit, the second with a new idempotency
   key, return the same order, as the documentation states.
7. With the staging key, the route list and the quote, submit, status,
   and history calls stay within the observed rate limits at the watcher's budgets.
8. Production routes `<PUBLIC_BASE_URL>/lnurlp/*` to the api, as staging
   does.
9. One ERC-4337 bundle that carries deposits to two different quotes
   yields two orders, one per quote, when each is submitted with the
   bundle hash.
10. History with the payment's BOLT11 as `address` lists the orders of
    that payment's quotes.
11. For every offered pair, two staging quotes created one after the other
    return two different EVM deposit addresses, and a submit without
    `sourceAddress` for a deposit to one of them returns its order.

## Unchanged

- A payer who pays the BOLT11 directly pays the shop's verified in-app
  wallet. That payment does not pass through Orchestra.
- The till's Spark invoice is unchanged. It is a separate way to pay the
  same charge.
- A gift is still sats to the same wallet. Loans are unchanged.
- The 12 words stay on the phone. This payment does not read them and
  does not deliver to a Spark address.
- No zap, gift, or message is written for a shop payment.
