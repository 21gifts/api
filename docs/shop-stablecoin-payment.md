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
bitcoin payment. The shop never holds USDT or USDC, and 21.gifts never
holds either coin. Gifts, the till, and loans stay in satoshis.

## Requirements

Three requirements are hard. The sections below state how each one is
met.

| Requirement                       | Verified against                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCryptoPay compatible          | The OpenCryptoPay standard: the README of `openCryptoPay/landingPage` at `c840d64e`, which opencryptopay.io links as its documentation. LUD-01, LUD-06, and LUD-16 as well, because the standard is "LNURL backward compatible". |
| Consistent with the DFX reference | DFX.swiss, whose API answers every example in that README. Where this document differs, [Deviations](#deviations) gives the reason.                                                                                              |
| Tether Wallet for Android 1.11.0  | Build 134, read from its compiled OpenCryptoPay client (`services/opencryptopay/api`, `route`, and `pending-proof`) and its wallet worklet. [Tether Wallet 1.11.0](#tether-wallet-1110) lists what that build does.              |

Orchestra facts come from its public route list,
`GET https://orchestration.flashnet.xyz/v2/orchestration/routes`, read on
2026-10-14, and from the Orchestra calls this document names. Facts that
only a live run can prove are listed in [Release checks](#release-checks).

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
6. The api verifies the transfer on chain and submits it to Orchestra.
   Orchestra accepting it is **accepted**. The wallet is told the
   payment succeeded, and the sticker is free again.
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
- **Waiting amount**: what the pay link pins. It is the open amount, or,
  when there is none, a pending charge that has no shop payment or whose
  shop payment is `ended`. A pending charge whose shop payment is
  `accepted` or `paid` is not a waiting amount.
- **Quote**: one row of `shop_quote`. It names one set of offers.
  `quote.id` is its id.
- **Offer**: one row of `shop_offer`. It is one committed Orchestra quote
  for one method and one asset of a quote.
- **Detail**: the transaction detail of one offer, the response to a
  callback with `method` and `asset`.
- **Proof**: one verified ERC-20 transfer log to an offer's deposit
  address, stored as one row of `shop_proof`.
- **Accepted**: Orchestra returned an `orderId` for a proof.
- **Paid**: the payment's BOLT11 has settled.
- **Unresolved**: a proof that was submitted to Orchestra and has no
  definitive answer yet.

Every timestamp in a response is ISO 8601 UTC with milliseconds and `Z`,
as `Date.prototype.toISOString` writes it, the same form `GET
/pay/:username` uses for `expiresAt`.

## Methods

The api offers exactly these methods. A method name is the
OpenCryptoPay name. It is compared exactly, as the standard requires: the
method "must match exactly the method name from the `transferAmounts`
array".

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
the api logs `shop.route.mismatch`. The route list is cached for its
`validForMs`.

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

| Name               | Value                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window             | Five minutes (`POS_CHARGE_TTL_MS`). A charge-backed payment uses the charge's `expires_at`. A payer-opened payment uses `created_at` + 5 min.                          |
| Offer expiry       | Orchestra's `expiresAt` for that offer.                                                                                                                                |
| Proof grace        | 420 s. Tether 1.11.0 may send its last proof attempt about 364 s after its send deadline: up to 180 s for confirmation, three quick tries, then three runs 60 s apart. |
| `quote.expiration` | A quote with offers: the earliest of `window_ends_at` and every offer's `expiresAt` minus the proof grace. A Lightning-only quote: `window_ends_at`.                   |
| BOLT11 expiry      | The invoice timestamp plus its `expiry` tag, or plus 3600 s when the tag is absent, as BOLT11 defines.                                                                 |
| BOLT11 margin      | An offer commits only when the payment's BOLT11 expires at least 600 s after that offer's `expiresAt`.                                                                 |
| Minimum quote life | An offer whose `expiresAt` minus the proof grace is less than 60 s away is not offered.                                                                                |
| Settlement watch   | The payment's BOLT11 is watched until 10 min after its expiry.                                                                                                         |
| Unresolved limit   | A proof that is still unresolved 24 h after its first submit becomes `stuck`.                                                                                          |

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
| `open`, `ended`             | `accepted` | Orchestra accepts a proof, the BOLT11 has not settled, and no other proof of the payment is `accepted`.                                    | sets `accepted_at`; clears `ended_at`, `end_reason` |
| `open`, `ended`, `accepted` | `paid`     | The BOLT11 settles.                                                                                                                        | sets `paid_at`; clears `ended_at`, `end_reason`     |
| `accepted`                  | `ended`    | Orchestra reports the order `refunded` or `failed`, or the BOLT11 is past its expiry and has not settled.                                  | sets `ended_at`, `end_reason`                       |

`paid` is final. `ended` can still move to `accepted` or `paid`, because
a transfer made in time can be confirmed after the window. Nothing else
changes a status. `db_change` keeps every earlier value.

The step that moves a charge-backed payment to `paid` also runs
`markPaid` for its charge, so the till sees the charge paid even after
the charge's own 15-minute watch has ended.

`end_reason` is one of `window`, `superseded` (by `POST /pos`),
`replaced` (by a new payer amount), `cancelled`, `charge_paid`,
`orchestra_refunded`, `orchestra_failed`, or `expired_unpaid`.

`shop_proof.result` is null (unresolved, or not yet submitted),
`accepted`, `refunded`, `refused`, `superseded`, or `stuck`. Each change
is a conditional update on the expected result, in the same database
transaction as the payment change it causes.

| From       | To           | Trigger                                                                                                                                    |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| null       | `accepted`   | Orchestra returns an `orderId`, and the payment can move to `accepted`, or it is already `paid` by this proof's order.                     |
| null       | `superseded` | Orchestra returns an `orderId`, but another proof of the payment is `accepted`, or the BOLT11 had settled before this proof was submitted. |
| null       | `refused`    | Orchestra refuses the proof with a refusal code ([Orchestra](#orchestra)).                                                                 |
| null       | `stuck`      | `give_up_at` has passed without a definitive answer.                                                                                       |
| `accepted` | `refunded`   | Orchestra reports that proof's order `refunded` or `failed`.                                                                               |
| `stuck`    | null         | An operator runs `POST /debug/shop-proofs/:id/retry`, which sets `give_up_at` 24 h ahead.                                                  |

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
today's pin (both bounds are the charge amount). Any LNURL wallet can
still pay the sticker.

A pending charge with no shop payment first runs the
[Creation procedure](#creation-procedure). When it succeeds, the fetch
answers as for an open amount.

When the request carries `timeout`, the api follows the standard's
waiting rule, which DFX implements. `timeout` is a whole number of
seconds. Values above 10 count as 10, and an empty or unparseable value
counts as 0. The api checks for a waiting amount once per second until
it finds one or the time is up. With an open amount it answers the pay
request below. With a waiting charge but no open amount it answers
today's pinned Lightning request. With neither it answers **404** with
this body, which is the body of the standard's example:

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
for it, with or without `timeout`. The table is the complete body. Today's
`commentAllowed`, `allowsNostr`, `nostrPubkey`, and `payerData` are left
out, because the shop callback serves no comment and no zap.

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
| `quote`             | `{ "id": <quote id>, "expiration": <quote.expiration>, "payment": <shop payment id> }`               |
| `requestedAmount`   | `{ "asset": "BTC", "amount": <sats / 100000000> }`                                                   |
| `transferAmounts`   | Lightning first, then each offered method in table order. Inside one method, USDT comes before USDC. |

A `transferAmounts` entry is
`{ "method", "minFee", "assets": [{ "asset", "amount" }], "available" }`.

- Lightning: `method` `Lightning`, `minFee` 0, one asset `BTC` whose
  `amount` is the sat count divided by 100000000, and `available` true.
- A stablecoin method: `minFee` is the gas price in wei, an integer: the
  `eth_gasPrice` result at quote creation times 12/10, or times 20/12 on
  `BinanceSmartChain`, rounded up. These are DFX's markups. `assets`
  lists the offered assets. Each `amount` is `requiredAmountIn` divided
  by 10 to the power of the decimals. `available` is true.

Every amount string is built from integers. It has no exponent, no
trailing zero after the decimal point, and no point when it is a whole
number (`0.00001`, `1.5`, `12`). `requestedAmount.amount` is a JSON
number written in that same plain notation, never `1e-8`.

A fetch while the quote has not lapsed returns that quote unchanged.
When `quote.expiration` has passed and the window has not, the fetch
replaces the quote ([Quotes](#quotes)). No response ever carries a
`quote.expiration` in the past. `quote.payment` never changes for a
payment.

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
  by the web app. [Release checks](#release-checks) item 6 covers this.
- The web app proxies `/.well-known/lnurlp/:username` to the api and
  forwards the query string, so `timeout` arrives. The proxy forwards no
  client address, so requests through the site origin share one
  rate-limit bucket, as they do today.
- Usernames `invoice` and `cb` never get stablecoin rows. `invoice`
  collides with the invoice forward `GET /lnurlp/:username/invoice`.
  `cb` breaks a proof URL that is built by replacing path segments:
  Tether 1.11.0 replaces every path segment `cb` with `tx` when no
  `hint` URL is usable, and other wallets may replace every `/cb`. Both
  usernames keep today's Lightning pay request.
- `GET /lnurlp/cb/invoice`, `GET /lnurlp/tx/invoice`, and
  `GET /lnurlp/wait/invoice` stay the invoice forward of the usernames
  `cb`, `tx`, and `wait`. The new routes do not match the literal path
  segment `invoice`.

## Opening a payment

### By a till charge

`POST /pos` keeps its body, its checks, its 409 for a second pending
charge, and its response. It takes the account's creation lock
([Creation procedure](#creation-procedure)). Before it inserts the
charge, it ends the account's `open` shop payment, if there is one: with
`end_reason` `superseded`, or `window` when that payment's window has
already passed.

After `POST /pos` answers, the api starts the creation procedure for the
charge in the background, so that the first scan finds the payment
ready. A pay-link fetch of a pending charge without a shop payment runs
the same procedure or joins the run in progress. `DELETE /pos` keeps its
behaviour, and the charge's `open` shop payment ends with `end_reason`
`cancelled`.

When the watcher marks the charge `paid` from the Spark invoice or from
a BOLT11 that is not the shop payment's, an `open` shop payment ends
with `end_reason` `charge_paid`.

### By the payer

`POST /pay/:username/payment` opens a payment for an amount the payer
entered on the payment page. No session. The body is
`{ "amountSats": <integer> }`. CORS is the page's origin list, the same
as for `POST /pay/:username/invoice`. The checks run in this order:

| Order | Condition                                                                                                      | Response                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | Invalid username, unknown account, no verified wallet, or no LNURL server config.                              | **404** `{ "error": "Not found" }`                                                           |
| 2     | The wallet's pay request cannot be resolved.                                                                   | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 3     | The body is not a positive whole number of sats.                                                               | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 4     | The amount is outside that pay request's minimum and maximum.                                                  | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 5     | A till charge is pending.                                                                                      | **409** `{ "error": "A payment is already open", "code": "payment_open" }`                   |
| 6     | Username `invoice` or `cb`; or `ORCHESTRA_BASE_URL`, `ORCHESTRA_API_KEY`, or `SHOP_EVM_RPC` is not configured. | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |
| 7     | This account already created 10 payments in the last 5 min, or the api created 60 in the last minute.          | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |
| 8     | The mint fails, or the BOLT11 amount differs.                                                                  | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 9     | No pair commits.                                                                                               | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |

Orders 1 to 4 and 8 are the checks, texts, and order of
`POST /pay/:username/invoice`. The two counters in order 7 count
successful creations only, in process. They do not depend on the client
address, because the web app's proxy forwards none.

An `open` payer-opened payment is always replaced: it ends with
`end_reason` `replaced`, and the new payment is created. A stranger
therefore cannot hold the sticker against a payer. A payer whose payment
was replaced while sending still gets their transfer confirmed: the
proof moves the `ended` payment to `accepted`, and the Tether settlement
poll sees a different `quote.payment` and reports settled.

**Response** `200`
`{ "payment": "<uuid>", "expiresAt": "<window_ends_at>" }`. The page then
fetches the pay link, which returns this payment while it is the open
amount.

### Creation procedure

One procedure creates a shop payment, for a charge or for a payer:

1. Take the account's in-process creation lock. A second caller for the
   same account waits for the first and then re-reads.
   `translate-note.ts` keeps in-flight work in a map the same way.
2. Re-check the state under the lock: end a lapsed `open` payment of the
   account with `end_reason` `window`, stop when the payment to create
   already exists, and for a payer stop with order 5 when a charge is
   now pending.
3. Read the route list and select the candidate pairs ([Methods](#methods)).
4. Mint one BOLT11 with `requestGiftInvoice`, as
   `POST /pay/:username/invoice` does, with a 5 s timeout. While a charge
   is pending, record its payment hash against the charge with
   `posStore.recordInvoice`, as that route does. Check the amount and read
   the BOLT11 expiry.
5. In parallel, read `eth_gasPrice` for each candidate chain and request
   one Orchestra quote per candidate pair, with 3 s per attempt and 4 s
   for the whole step.
6. Keep each quote that commits and passes [Offer checks](#offer-checks).
7. When none is kept, write nothing, and the account's next creation waits
   60 s. Until then a fetch answers today's pinned Lightning request, and
   `POST /pay/:username/payment` answers order 9.
8. Insert the payment with its BOLT11, its first quote, and its offers in
   one database transaction. The implementing change adds a transactional
   port to the shop payment store, the way `MergeDb.begin` wraps
   `sql.begin` for `account-merge.ts`. The partial unique index on open
   payments is the backstop while a deploy briefly runs two containers: a
   lost insert (`23505`) re-reads the winning row.

The procedure stays within 9 s: 5 s for the mint and 4 s for the quotes.
Tether 1.11.0 waits 20 s for the pay request, and its plain LNURL path
waits 10 s. A fetch that joins a run in progress waits at most 9 s, and
then answers today's pinned Lightning request.

Every external call runs outside the database transaction. A losing
caller's BOLT11 stays recorded against the charge and can still pay the
charge. Its Orchestra quotes are never shown and expire unused.

## Quotes

A fetch of the open amount after `quote.expiration` creates a
replacement quote for the same sats and the same BOLT11. It runs steps 3,
5, and 6 of the creation procedure, inserts one `shop_quote` with the
offers that pass, and keeps the payment id. A payment never gets a
second BOLT11, so the shop can only be paid once through it.

When no new offer meets the BOLT11 margin or commits, the replacement is
a Lightning-only quote: its `transferAmounts` has only the Lightning
entry, and its `quote.expiration` is `window_ends_at`.

## Offer checks

An Orchestra quote becomes an offer only when every check holds:

- HTTP 200, `targetAmountOut` equals the sat count, and
  `requiredAmountIn` is a positive integer string;
- `transaction.chainId` equals the table `chainId`;
- `transaction.to` equals the table contract, compared in lowercase;
- `transaction.value` is zero;
- `transaction.data` is exactly 68 bytes: `a9059cbb`, 12 zero bytes, the
  20-byte recipient, and the 32-byte amount, and that amount equals
  `requiredAmountIn`;
- the recipient is not the recipient of any other offer created in the
  last 24 h, so that one deposit address belongs to one offer;
- `expiresAt` minus the proof grace is at least 60 s in the future;
- the BOLT11 expires at least 600 s after `expiresAt`;
- when a BTC/USD spot younger than 10 minutes is available
  (`btc-usd-spot.ts`), `requiredAmountIn` in USD is at most 5 % above the
  sats' value at that spot.

A failed check means the pair is not offered. The api logs
`shop.offer.rejected` with the name of the check. A shared recipient
also logs `shop.alert.shared_recipient`.

## Callback

`GET /lnurlp/cb/:username`. No session. CORS `*`, methods `GET, OPTIONS`,
`Cache-Control: no-store`, 120 requests per minute per client address.

### LNURL amount path

A request without `method` is the LUD-06 second step. `amount` is in
millisats. When the account has an open amount and `amount` equals its
sats times 1000, the response is `{ "pr": "<bolt11>", "routes": [] }`
for the payment's BOLT11. Otherwise the response is **400**, reason
`Amount does not match this payment`. This path never mints.

### Detail

A request with `method` is checked in this order:

| Order | Condition                                                                                          | Response                                      |
| ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1     | `quote` or `asset` is missing, or a key is repeated.                                               | **400**, reason `That payment is not offered` |
| 2     | `quote` is not the current quote of this username's open amount, or `quote.expiration` has passed. | **404**, reason `Quote expired`               |
| 3     | `method=Lightning` and `asset=BTC`.                                                                | **200** `{ "pr": "<bolt11>" }`                |
| 4     | A stablecoin method and asset that the quote offers with `available` true.                         | **200** with the stablecoin detail below      |
| 5     | Anything else.                                                                                     | **400**, reason `That payment is not offered` |

Tether 1.11.0 reads the 404 as `QUOTE_EXPIRED` and the 400 as
`RAIL_UNAVAILABLE`.

The stablecoin detail has the four fields the standard and DFX return
for an EVM chain:

```json
{
  "expiryDate": "<quote.expiration>",
  "blockchain": "<method>",
  "uri": "ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<amount>",
  "hint": "Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to <PUBLIC_BASE_URL>/lnurlp/tx/<username>"
}
```

The URI uses the offer's lowercase contract, the decimal `chainId`, the
lowercase recipient, and `requiredAmountIn` in decimal.
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
  `0x`. It is normalised to `0x` plus lowercase. It is the hash of a
  transaction the wallet already published, or the hash of an ERC-4337
  user operation.
- `hex`: an optional `0x`, then an even number of hexadecimal characters,
  at least 100 and at most 4096. It is a signed EVM transaction that the
  wallet did not publish.

The standard names `hex` for EVM chains. DFX accepts `tx` on EVM as
well, and Tether 1.11.0 sends only `tx`. The api accepts both.

### Verification of `tx`

1. Read `eth_getTransactionReceipt` on the method's endpoint. When the
   result is null, read `eth_getUserOperationReceipt` with the same hash
   (the ERC-4337 bundler method). From a user-operation receipt the api
   uses that user operation's own `logs` and its `receipt.transactionHash`.
   `user_op_hash` keeps the value the wallet sent.
2. Neither receipt is found: store a lookup row (`shop_proof_lookup`)
   and answer **503**, reason `Transfer not found yet`. The wallet
   retries, and the [Watcher](#watcher) keeps looking for one hour.
3. The receipt status is not `0x1`: **400**, reason
   `Payment was not accepted`. Nothing is stored.
4. Find the ERC-20 `Transfer` logs (topic
   `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`)
   whose emitting address is an offer contract of this quote and method,
   whose `to` topic is that offer's recipient, and that no stored proof
   claims yet. A log whose value equals the offer amount comes first;
   otherwise the first such log is used. It selects the offer. When
   `asset` is present, it must equal that offer's asset.
5. No such log: **400**, reason `Payment was not accepted`. Nothing is
   stored, because no coin reached Orchestra for this offer.

One proof is one log, identified by `(chain_id, tx_hash, log_index)`.
One ERC-4337 bundle can carry the transfers of several payers. The
transferred value is stored. A transfer of a different amount is still
submitted, because only Orchestra can fill it or refund it.

### Verification of `hex`

1. Decode the signed transaction. Legacy (EIP-155), EIP-2930, and
   EIP-1559 transactions are accepted.
2. Its chain id must equal the method's `chainId`. `to` must be an offer
   contract of this quote and method. `value` must be zero. `data` must
   equal that offer's transfer data byte for byte. Its gas price, or its
   `maxFeePerGas`, must be at least the offer's `minFee`, as DFX
   requires. When `asset` is present, it must equal the offer's asset.
3. A failed check: **400**, reason `Payment was not accepted`. Nothing is
   stored and nothing is broadcast.
4. The transaction hash is the Keccak-256 of the signed bytes. The api
   stores the proof with `raw_hex` and `log_index` null, then sends
   `eth_sendRawTransaction`. A JSON-RPC error whose message contains
   `already known` or `nonce too low`, without regard to case, counts as
   sent only when `eth_getTransactionByHash` then finds that hash. Any
   other JSON-RPC error records the proof `refused` and answers **400**.
   A transport error answers **503**, and the watcher sends it again.
5. The proof is submitted at once. When the receipt arrives, the watcher
   stores the `log_index` of the transfer.

The api broadcasts only transactions that passed step 2, so its
endpoints are not an open relay.

### Storing and submitting

1. A stored proof with the same transaction and log for this quote is a
   repeat and answers from the stored row. A `tx` whose transaction hash
   equals a stored `hex` proof of this quote is a repeat of that proof.
   For another quote or another
   payment the response is **400**, reason `Transaction already used`. A
   lost insert (`23505`) re-reads the winning row and answers from it.
2. Insert the `shop_proof` row with its own idempotency key and
   `give_up_at` 24 h ahead.
3. Submit it to Orchestra ([Orchestra](#orchestra)). `sent_at` is set
   before the call.

Every verified proof is submitted, including when the payment is
`ended`, `paid`, or already `accepted`, and after its quote expired.
Orchestra is the only party that holds the coin, and submitting is how
it fills or refunds the deposit.

| Stored result         | Response                                                                       |
| --------------------- | ------------------------------------------------------------------------------ |
| `accepted`            | **200** `{ "txId": "<tx_hash>" }`                                              |
| `superseded`          | **400**, reason `This payment was already paid; the transfer will be refunded` |
| `refunded`            | **400**, reason `The transfer was refunded`                                    |
| `refused`             | **400**, reason `Payment was not accepted`                                     |
| unresolved or `stuck` | **503**, reason `Payment is being confirmed`                                   |

`txId` is the transaction hash, as DFX returns it. Orchestra's `orderId`
is stored as `provider_order` and is not sent to the wallet. A repeat of
an accepted proof is **200** with the same body and never creates a
second payment.

Accepting a proof moves the payment as [States](#states) states. In the
same step the payment stops being the open amount, so the next pay-link
poll with `timeout` is the 404 above.

## Wait

`GET /lnurlp/wait/:payment` serves the payment page. No session. CORS
`*`, `Cache-Control: no-store`, 120 requests per minute per client
address. `:payment` must be a shop payment id. Otherwise the response is
**404**.

The response is
`{ "status": <DFX status>, "paymentStatus": <status>, "invoiceExpiresAt": <BOLT11 expiry> }`.
It answers at once when `paymentStatus` is not `open`. Otherwise it
waits up to 25 s for a change and then answers with the state on hand.

| `paymentStatus` | `status` (DFX `PaymentLinkPaymentStatus`)                                     |
| --------------- | ----------------------------------------------------------------------------- |
| `open`          | `Pending`                                                                     |
| `accepted`      | `Pending`                                                                     |
| `paid`          | `Completed`                                                                   |
| `ended`         | `Cancelled` for `superseded`, `replaced`, or `cancelled`; otherwise `Expired` |

`Completed` is final, as at DFX. `accepted` maps to `Pending` because an
accepted order can still be refunded here. A client that shows "on its
way" reads `paymentStatus`.

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

| Variable             | Kind   | Rule                                                                                                                                                 |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCHESTRA_BASE_URL` | config | Absolute `https` origin without a path. The documented origin is `https://orchestration.flashnet.xyz`.                                               |
| `ORCHESTRA_API_KEY`  | secret | The server key (`fn_…`). A client key (`fnp_…`) is refused. Never logged.                                                                            |
| `SHOP_EVM_RPC`       | secret | A JSON object from decimal `chainId` to an absolute `https` JSON-RPC URL. A URL may hold a provider key, so the whole value is secret. Never logged. |

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
(1 to 255 printable ASCII characters). A retry of one call reuses its key
and its body. The error body is `{ "error": { "code", "message" } }`.
The wallet never sees `message`.

- **Routes**: `GET {base}/v2/orchestration/routes`, without a key, cached
  for `validForMs`.
- **Quote**: `POST {base}/v1/orchestration/quote` with `sourceChain`
  (table), `sourceAsset` (`USDT` or `USDC`), `destinationChain`
  `lightning`, `destinationAsset` `BTC`, `amount` (the sat count as an
  integer string), `amountMode` `exact_out`, `slippageBps` 0,
  `recipientAddress` (the payment's BOLT11), and `includeCalldata` true.
  The body has no `refundAddress`: Orchestra refunds to the detected
  source address. A transport timeout, HTTP 429, or HTTP 5xx is retried
  once with the same key inside the step's budget. Any other answer means
  the pair is not offered.
- **Submit**: `POST {base}/v1/orchestration/submit` with
  `{ "quoteId": <provider_ref>, "txHash": <tx_hash> }` and the proof's
  idempotency key.
  - HTTP 200 with `orderId`: accepted.
  - HTTP 400 or 422 whose `error.code` is in `ORCHESTRA_REFUSAL_CODES`:
    refused. The implementing change copies that list from Orchestra's
    API reference into the code.
  - Anything else is unresolved: a timeout, HTTP 409
    `idempotency_in_progress`, HTTP 200 without `orderId`, HTTP 401, 403,
    404, 429, or 5xx, and any code not on the list. HTTP 401 and 403 also
    log `shop.alert.orchestra_auth`.
- **Status**: `GET {base}/v1/orchestration/status?id=<orderId>` with the
  key. `order.status` `refunded` or `failed` moves the proof to
  `refunded` and the payment as [States](#states) states. Every other
  status, a timeout, and every HTTP error change nothing. An unknown
  status is logged once per order.

The api registers no webhook and does not call
`/v1/orchestration/estimate`.

## Watcher

The existing `startPosPaidWorker` tick (every 2 s, without overlap)
gains these duties, in this order. They have their own budget of 20
external calls per tick, separate from the charge watch, and each call
times out after 5 s. Each duty takes its rows in order of `next_try_at`,
oldest first, and what is left waits for the next tick. A cadence below
is the earliest next try, not a promise.

| Order | Duty                      | Rows                                                                 | Cadence                                                                                                                                     |
| ----- | ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | End lapsed windows        | `open` payments whose `window_ends_at` has passed                    | Every tick, one conditional update, no external call.                                                                                       |
| 2     | Settlement                | Payments that are not `paid`, inside their BOLT11's settlement watch | Every 2 s for 15 min after creation, then every 30 s. The LUD-21 `/verify` read the charge watch uses.                                      |
| 3     | Lookups                   | `shop_proof_lookup` rows younger than one hour                       | After 10 s, 30 s, and 60 s, then every 2 min. A found receipt runs the `tx` verification and, when it passes, stores and submits the proof. |
| 4     | Broadcasts                | `hex` proofs whose transaction is not found                          | Send again after 30 s, then every 2 min, until the proof is resolved.                                                                       |
| 5     | Unresolved proofs         | `result` null and `sent_at` set                                      | Resubmit with the same key after 10 s, 30 s, and 60 s, then every 5 min.                                                                    |
| 6     | Stuck proofs              | Unresolved proofs past `give_up_at`                                  | Mark `stuck` and log `shop.alert.proof_stuck`.                                                                                              |
| 7     | Accepted orders           | `accepted` proofs of `accepted` or `paid` payments, until final      | Orchestra status every 10 s for 10 min, then every 60 s, until `completed`, `refunded`, or `failed`.                                        |
| 8     | Expired, accepted, unpaid | `accepted` payments whose BOLT11 is past its expiry                  | End with `expired_unpaid` and log `shop.alert.accepted_unpaid`.                                                                             |

The BOLT11 settling marks the payment `paid` and runs `markPaid` for its
charge. When the payment's BOLT11 settles after its charge was already
paid by another invoice or cancelled, the api logs
`shop.alert.double_settled`: the shop then received the charge twice and
refunds the payer directly. The watcher does not reopen a cancelled
charge.

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
  pos_charge_id      uuid UNIQUE REFERENCES pos_charge (id),
  bolt11             text NOT NULL,
  payment_hash       text NOT NULL UNIQUE,
  bolt11_expires_at  timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('open', 'accepted', 'paid', 'ended')),
  end_reason         text CHECK (end_reason IN ('window', 'superseded', 'replaced', 'cancelled',
                       'charge_paid', 'orchestra_refunded', 'orchestra_failed', 'expired_unpaid')),
  window_ends_at     timestamptz NOT NULL,
  next_try_at        timestamptz,
  created_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  paid_at            timestamptz,
  ended_at           timestamptz,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_payment_account_open_idx
  ON shop_payment (account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS shop_payment_watch_idx
  ON shop_payment (next_try_at) WHERE status <> 'paid';

CREATE TABLE IF NOT EXISTS shop_quote (
  id                uuid PRIMARY KEY,
  payment_id        uuid NOT NULL REFERENCES shop_payment (id),
  expires_at        timestamptz NOT NULL,
  transfer_amounts  jsonb NOT NULL,
  created_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_quote_payment_idx ON shop_quote (payment_id);

CREATE TABLE IF NOT EXISTS shop_offer (
  id                uuid PRIMARY KEY,
  quote_id          uuid NOT NULL REFERENCES shop_quote (id),
  method            text NOT NULL,
  chain_id          integer NOT NULL,
  asset             text NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  token_address     text NOT NULL,
  recipient         text NOT NULL,
  amount            numeric(78, 0) NOT NULL CHECK (amount > 0),
  decimals          smallint NOT NULL,
  min_fee           numeric(78, 0) NOT NULL,
  provider_ref      text NOT NULL,
  idempotency_key   text NOT NULL,
  expires_at        timestamptz NOT NULL,
  detail_issued_at  timestamptz,
  created_at        timestamptz NOT NULL,
  UNIQUE (quote_id, method, asset)
);
CREATE INDEX IF NOT EXISTS shop_offer_recipient_idx ON shop_offer (recipient, created_at);

CREATE TABLE IF NOT EXISTS shop_proof (
  id               uuid PRIMARY KEY,
  offer_id         uuid NOT NULL REFERENCES shop_offer (id),
  payment_id       uuid NOT NULL REFERENCES shop_payment (id),
  chain_id         integer NOT NULL,
  tx_hash          text NOT NULL,
  log_index        integer,
  user_op_hash     text,
  raw_hex          text,
  transfer_amount  numeric(78, 0),
  idempotency_key  text NOT NULL,
  result           text CHECK (result IN ('accepted', 'refunded', 'refused', 'superseded', 'stuck')),
  provider_order   text,
  sent_at          timestamptz,
  give_up_at       timestamptz NOT NULL,
  next_try_at      timestamptz,
  tries            integer NOT NULL DEFAULT 0,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL,
  CHECK (raw_hex IS NOT NULL OR (log_index IS NOT NULL AND transfer_amount IS NOT NULL)),
  CHECK (result NOT IN ('accepted', 'refunded', 'superseded') OR provider_order IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_log_idx
  ON shop_proof (chain_id, tx_hash, log_index) WHERE log_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_hex_idx
  ON shop_proof (chain_id, tx_hash) WHERE raw_hex IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_payment_accepted_idx
  ON shop_proof (payment_id) WHERE result = 'accepted';
CREATE INDEX IF NOT EXISTS shop_proof_retry_idx
  ON shop_proof (next_try_at) WHERE result IS NULL;

CREATE TABLE IF NOT EXISTS shop_proof_lookup (
  id             uuid PRIMARY KEY,
  quote_id       uuid NOT NULL REFERENCES shop_quote (id),
  method         text NOT NULL,
  asset          text,
  chain_id       integer NOT NULL,
  hash           text NOT NULL,
  next_try_at    timestamptz NOT NULL,
  tries          integer NOT NULL DEFAULT 0,
  done_at        timestamptz,
  created_at     timestamptz NOT NULL,
  UNIQUE (chain_id, hash, quote_id)
);
```

Ids come from `crypto.randomUUID()`, the same form as `pos_charge.id`:
lowercase, eight-four-four-four-twelve. A `quote` or `:payment` value
that is not that form, compared in lowercase, is unknown. Addresses and
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
- The charge watch stays as it is. A charge is paid when the Spark
  invoice or any BOLT11 recorded against it settles. Orchestra paying the
  shop payment's BOLT11 is one of those, because step 4 of the creation
  procedure records that BOLT11 against the charge. When that happens
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
- With an entered amount it calls `POST /pay/:username/payment` instead
  of `POST /pay/:username/invoice`. On **503** `stablecoin_unavailable`,
  and on any other failure of that call, it falls back to
  `POST /pay/:username/invoice`, which is today's Lightning-only path. On
  **409** `payment_open` it reloads and shows the till charge.
- It fetches the pay link on its own origin, without `timeout`, and shows
  one line per method and asset from `transferAmounts`, with the quote's
  expiry. It fetches again after `quote.expiration`. When the response
  has no stablecoin, the page looks as it does today.
- It shows the Lightning invoice from the callback's Lightning detail.
  The Wallet of Satoshi button and the desktop invoice QR stay as they
  are today.
- It tells the payer to scan the sticker with Tether Wallet or another
  OpenCryptoPay wallet. Tether 1.11.0 opens only `https://…?lightning=`
  links, so the page shows no `lightning:` stablecoin deeplink.
- It polls `GET /lnurlp/wait/:payment` and shows "waiting" (`open`, or
  `ended` before `invoiceExpiresAt`, because the invoice can still be
  paid), "on its way" (`accepted`), "paid", or "ended".
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
passed (`QUOTE_EXPIRED`). It pays from an ERC-4337 account through a
bundler, then waits up to 180 s for the on-chain hash. The hash it sends
is the hash of the bundle transaction. It sends the user-operation hash
only when the receipt has neither `hash` nor `transactionHash`.

**Proof.** A `hint` that holds an `http` or `https` URL on the same host
with a path segment `tx` gives the proof URL; trailing punctuation is cut
off. Without such a hint, the proof URL is `callback` with every path
segment `cb` replaced by `tx`. The query is kept. The wallet sends
`quote`, `method`, `asset`, and `tx`. It retries up to 3 times, after
1 s and 3 s, only when the request throws (HTTP 5xx or no response). Any
status below 500 is a final refusal. Success is a 2xx with a non-empty
string `txId`. A background run retries a thrown proof up to 3 times,
60 s apart.

**Settlement.** Only after a 2xx on the proof request or its two quick
retries does the wallet poll the URL it first fetched, adding
`timeout=0`, every 3 s for 30 s. It reports settled when an answer is a
404 with an OpenCryptoPay body, or names a different `quote.payment`.
Otherwise it reports unconfirmed. A proof that succeeds only in a
background run shows `send.OPEN_CRYPTO_PAY_NOT_SETTLED` on screen, even
when the shop is paid. The till, not the wallet screen, decides.

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

| Wallet behaviour                                  | Rule here                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Opens only `https://…?lightning=`                 | The sticker has that form. The page shows no `lightning:` stablecoin deeplink.        |
| Exact method and asset names                      | [Methods](#methods) uses `Ethereum`, `Polygon`, `Arbitrum`, and `USDT`.               |
| Sends `tx` and `asset` on EVM                     | [Proof](#proof) accepts `tx` and an optional `asset`.                                 |
| Pays from an ERC-4337 bundle                      | A proof is one transfer log; a user-operation hash is also accepted.                  |
| 400 and 404 on the callback mean different things | An expired quote is 404, and a pair that is not offered is 400.                       |
| A proof status below 500 is final                 | Pending, unresolved, and rate-limited proofs answer 503, never 429.                   |
| 20 s request timeout                              | Creation stays within 9 s, and a proof request within 18 s.                           |
| Proof up to about 364 s after the send deadline   | The proof grace keeps `quote.expiration` 420 s before Orchestra's own expiry.         |
| Hint URL first, then the `cb` segment rewrite     | The hint names the proof URL with no punctuation after it. Username `cb` is excluded. |
| Settled only on 404 or a new `quote.payment`      | Acceptance frees the sticker in the same step, and the `timeout` poll answers 404.    |
| Token must be the wallet's USDT contract          | [Offer checks](#offer-checks) require the table contract.                             |
| Unreadable dates are skipped                      | Every timestamp is `toISOString` output.                                              |

## Deviations

| Topic                 | DFX or the standard                                                                                           | Here                                                                                  | Reason                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No pending payment    | Waits 10 s by default, `timeout` without an upper bound, then 404.                                            | Without `timeout`: the Lightning pay request. With `timeout`: at most 10 s, then 404. | The sticker must stay payable by every LNURL wallet, and those never send `timeout`. The cap bounds held requests. |
| Expired quote         | DFX: 400 `Quote is expired` until its job marks the quote expired, then 404 `No matching actual quote found`. | Always 404 `Quote expired`.                                                           | Tether 1.11.0 reads only 404 as an expired quote. The standard names no code.                                      |
| Opening by the payer  | DFX: `POST /lnurlp/:id` with a fiat amount.                                                                   | `POST /pay/:username/payment` with sats.                                              | The repository's page routes live under `/pay`, and a shop payment has no fiat price.                              |
| `requestedAmount`     | The fiat price.                                                                                               | BTC.                                                                                  | A shop payment is a sat amount, and no fiat price exists.                                                          |
| Ids                   | `plq_…`, `plp_…`.                                                                                             | UUIDs.                                                                                | Repository convention (`pos_charge.id`). The standard fixes no id form.                                            |
| Statuses              | `Pending`, `Completed`, `Cancelled`, `Expired`.                                                               | `open`, `accepted`, `paid`, `ended`.                                                  | Accepted and paid differ here. `/lnurlp/wait` returns the DFX name next to the state.                              |
| Wait                  | DFX: 404 for a payment that is not pending, and a hold of up to 60 s.                                         | 200 with the state, and a hold of up to 25 s.                                         | The page needs `accepted`, `paid`, and `ended` apart. 25 s stays below common proxy timeouts.                      |
| Late proof            | DFX: 404 once the quote is no longer actual.                                                                  | Verified and submitted to Orchestra.                                                  | Orchestra holds the coin, and only a submit lets it fill or refund the deposit.                                    |
| Proof not found yet   | DFX: 400.                                                                                                     | 503 and a lookup row.                                                                 | Tether 1.11.0 retries only on 5xx, and a 400 would strand a real transfer.                                         |
| Proof rate limit      | DFX: 429.                                                                                                     | 503.                                                                                  | Tether 1.11.0 reads 429 as a final refusal.                                                                        |
| Different amount      | DFX: refuses an underpayment.                                                                                 | Submitted to Orchestra.                                                               | Orchestra holds the coin and decides whether to fill or refund it.                                                 |
| User-operation hash   | Not part of DFX or the standard.                                                                              | Accepted as `tx`.                                                                     | Tether 1.11.0 pays from an ERC-4337 account.                                                                       |
| URL tweaking (path B) | DFX serves `GET /pl` on its API.                                                                              | Not served.                                                                           | The site has no `app` host to swap for `api`. The standard recommends path A.                                      |
| Sticker path          | DFX: `/pl?lightning=`.                                                                                        | `/pl/?lightning=`.                                                                    | Printed stickers carry this form. The web app redirects `/pl/` to `/pl` and keeps the query.                       |
| Error body            | DFX: `{ statusCode, message, error }` with the HTTP reason phrase in `error`.                                 | Those fields plus `status` and `reason`, with the text in `error`.                    | One body for LUD-06, DFX-built wallets, Tether 1.11.0, and this repository's clients.                              |
| Quote per fetch       | DFX creates a quote on every fetch.                                                                           | One quote until it lapses.                                                            | Each quote costs one Orchestra call per pair. Reuse also keeps the amounts stable for a wallet that fetches twice. |
| `displayQr`           | Controls DFX's link QR.                                                                                       | Always `false`.                                                                       | The page shows the BOLT11 QR, not a link QR.                                                                       |
| Extra fields          | `externalId`, `mode`, `route`.                                                                                | Omitted.                                                                              | They have no meaning for a shop payment, and the standard does not require them.                                   |

## Logging

Each event is one `logEvent` line with `paymentId`, and with `quoteId`,
`offerId`, `proofId`, `providerRef`, or `orderId` where it applies. The
api never logs a key, an RPC URL, raw `hex`, or a BOLT11.

- `shop.payment.opened`, `.accepted`, `.paid`, `.ended`
- `shop.offer.rejected`, `shop.route.mismatch`
- `shop.proof.stored`, `.submitted`, `.accepted`, `.refused`,
  `.superseded`, `.refunded`, `.unresolved`
- `shop.orchestra.error`
- `shop.alert.orchestra_auth`, `shop.alert.proof_stuck`,
  `shop.alert.accepted_unpaid`, `shop.alert.double_settled`,
  `shop.alert.shared_recipient`, and `shop.alert.accepted_long` (a
  payment `accepted` for more than one hour)

The operator alerts on `shop.alert.*` and reads the five tables through
`GET /debug/db`, as for other tables. `POST /debug/shop-proofs/:id/retry`
uses the existing debug authorization. It moves a `stuck` proof back to
unresolved, sets `give_up_at` 24 h ahead, and logs
`shop.proof.retried`.

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
- `resolveShopPaymentConfig` and the three variables in CONTRIBUTING's
  environment table;
- the in-process counters of order 7, which `IpRateLimiter` cannot
  express because they count accounts and successes over 5 min;
- the dependency `viem` at an exact version, for transaction decoding,
  Keccak-256, and ABI encoding. Nothing in this repository decodes EVM
  transactions today;
- `SPEC.md` rows and `docs/handbook/` sections for every new route and
  export, and a `CONCEPT.md` decisions-log row.

It reuses `requestGiftInvoice`, `posStore.recordInvoice`, `markPaid`,
`decodeBolt11`, `inspectBolt11`, `IpRateLimiter` for the per-address
limits, `resolveLnurlServerConfig`, `startPosPaidWorker`, the LUD-21
`/verify` read, `isUniqueViolation`, `btc-usd-spot.ts`, and the
`pos-store.ts` patterns for conditional updates and idempotent DDL.

### Tests

- Vitest with fakes for Orchestra, the RPC endpoints, and the LNURL
  server covers every row of every table in this document at 100 %, as
  CONTRIBUTING requires.
- The default end-to-end suite boots without these services. Its
  `webServer.env` leaves the three new variables empty, and each new
  route answers its default 404 there, as the other LNURL routes do.
- A second Playwright project, `shop-payment`, has its own `webServer`
  that boots the api with stand-ins for Orchestra, one EVM RPC endpoint
  per Tether rail, and the LNURL server, plus a verified-wallet fixture.
  CONTRIBUTING lists it next to the default suite. Its driver is a
  TypeScript port of the client behaviour in
  [Tether Wallet 1.11.0](#tether-wallet-1110), including the status-code
  rules, the hint and `cb` rewrite, the bundle hash, the user-operation
  hash, and the settlement poll. With `USDT` on each of `Ethereum`,
  `Polygon`, and `Arbitrum` it must reach settled. It must also reach the
  plain LNURL path with no open amount, `QUOTE_EXPIRED` on an expired
  quote, and `RAIL_UNAVAILABLE` on a pair that is not offered.

## Release checks

Only a live run can prove these facts. The stablecoin rows stay off in
production until each one passes on staging. The person who runs them
records each result in the pull request that turns the feature on.

1. Tether Wallet 1.11.0 on a real Android phone, with a balance that
   covers the amount and the fee, pays a staging shop payment with USDT
   on Polygon, on Arbitrum, and on Ethereum, and reports
   `OPEN_CRYPTO_PAY_SETTLED` each time. The shop payment ends `paid`. This
   also proves that Orchestra detects a deposit made from an ERC-4337
   account.
2. The BOLT11 that the staging mint returns meets the BOLT11 margin for
   Orchestra's quote lifetimes on those chains.
3. A proof submitted after Orchestra's `expiresAt`, for a deposit made
   before it, is either filled or refunded by Orchestra. An underpaid and
   an overpaid deposit are filled or refunded. Each answer is recorded.
4. Orchestra accepts two quotes, one after the other, that name the same
   BOLT11, and gives each quote its own deposit address.
5. Orchestra's refusal codes for submit are copied into
   `ORCHESTRA_REFUSAL_CODES`, and Orchestra keeps an idempotency key for
   at least 24 h.
6. Production routes `<PUBLIC_BASE_URL>/lnurlp/*` to the api, as staging
   does.

## Unchanged

- A payer who pays the BOLT11 directly pays the shop's verified in-app
  wallet. That payment does not pass through Orchestra.
- The till's Spark invoice is unchanged. It is a separate way to pay the
  same charge.
- A gift is still sats to the same wallet. Loans are unchanged.
- The 12 words stay on the phone. This payment does not read them and
  does not deliver to a Spark address.
- No zap, gift, or message is written for a shop payment.
