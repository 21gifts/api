# Shop payment in USDT and USDC

Status: **specified, not implemented**. Decided 2026-10-01. Names fixed
2026-10-10. The wallet check is Tether Wallet for Android 1.11.0 (134).
The names in this document are the contract. The routes are not mounted,
and `SPEC.md` does not list them. Nothing here changes runtime behaviour.

A payer may settle a shop payment in USDT or USDC. Orchestra pays the
BOLT11 `POST /pay/:username/invoice` already returns for those sats on
the shop's verified in-app wallet. That route already returns it. This
document does not add a second mint. The shop does not hold either
stablecoin. The member sees an ordinary bitcoin payment. Gifts, the till,
and loans stay in satoshis.

## Terms

The **sticker** is the one QR printed for that shop and that cashier. It
does not change for a quote, an amount, or a payment.

The **pay link** is the LNURL in that QR. It is the shop's existing pay
link, `https://<domain>/.well-known/lnurlp/<username>`. The QR is
`https://<domain>/pl/?lightning=<LNURL>`.

The **payment page** is what a phone camera opens from the sticker:
`/pl/?lightning=<LNURL>`.

A **quote** is one price for one fixed sat amount. It names those sats,
an expiry, an id, and the chain amounts quoted for those sats.

**Accepted** means Orchestra has taken a transfer that matches a quote
that was still valid. The sat amount stays due. The wallet is told the
OpenCryptoPay payment succeeded.

**Paid** means the payment has settled once. That is the BOLT11 for
these sats settled. Orchestra pays that BOLT11. A direct Lightning
payment of the same invoice is the same confirmation. The first
confirmation records paid. Acceptance does not record paid. The till's
existing Spark invoice is a separate payment of the same charge. This
document does not change that payment, and it does not settle the
stablecoin transfer on Spark.

## Names

These names are the contract. Nothing in this section is mounted.
`SPEC.md` lists a route only after the change that implements it.

### Identifiers

`quote.id` and `quote.payment` are UUIDs from `crypto.randomUUID()`, the
same shape as `pos_charge.id`. The stored form is lowercase hexadecimal,
eight-four-four-four-twelve. Neither id has a prefix. `quote.payment` is
not an amount. `quote.expiration` is UTC, millisecond precision, with a
`Z` suffix, the same form `GET /pay/:username` uses for `expiresAt`. It
is the earlier of the expiry Orchestra returns for that quote, the
expiry of the BOLT11 that quote names, and the instant that payment
leaves `open`. When that instant is sooner, `shop_quote.expires_at`
moves to it. A quote for an open till charge also ends when the charge
ends, if that is sooner, unless a stored proof has no result and was stored less than ten minutes ago.

The `quote` parameter uses that same form. A value that is not that form,
compared case-insensitively, is an unknown quote.

### Pay link

The pay link is `https://<domain>/.well-known/lnurlp/<username>`. It
carries no payment query. The payment page and a wallet both read this
URL. The page does not build a second one. Tether Wallet for Android
1.11.0 (134) requests the URL it decoded and does not add a payment
query.

The page is opened as `/pl/?lightning=<LNURL>`. It decodes that LNURL
and fetches the decoded URL. It does not add `timeout`. The amounts it
shows are `requestedAmount` and `transferAmounts` in that response.
DFX.swiss decodes the LNURL it was opened with and then sets `timeout`.
This page does not. An empty result here is the Lightning pay request,
not a 404.

### Callback and proof

When no amount is known, `callback` and metadata stay on the pay request
`GET /.well-known/lnurlp/:username` already returns for the verified
wallet. This service does not rewrite them.

Stablecoin rows are served only when `PUBLIC_BASE_URL` is an absolute
`http` or `https` URL. Otherwise the pay link stays the pay request it
already returns. When an amount is known and those rows are served,
`callback` is the origin `resolvePublicApiBase` already returns for `PUBLIC_BASE_URL`, plus `/lnurlp/cb/<username>`.
`https://21.gifts` becomes `https://api.21.gifts`, `https://dev.21.gifts` becomes `https://dev-api.21.gifts`, and `https://staging.21.gifts` becomes `https://staging-api.21.gifts`. One trailing slash is removed first. Any other absolute value is used as given. The proof URL replaces `/cb`
with `/tx` in that callback. The username stays. It is the
path id of the pay link. `quote.payment` stays in the JSON. It is not a
path segment and not a query on the pay link. A refreshed quote keeps
the same callback. The callback has no query string. A wallet appends
its query itself. Neither URL is `…/lnurlp/<username>/invoice`.
That path stays the invoice forward it already is. It is not this
callback and not this proof.

`GET /.well-known/lnurlp/:username`, `GET /lnurlp/cb/:username`, and
`GET /lnurlp/tx/:username` take no session. They use the headers the pay
link already sends: `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, OPTIONS`, and
`Cache-Control: no-store`.

### Opening a payment

`POST /pay/:username/payment` opens a payment for the page. No session.
The body is `{ "amountSats": <integer> }`. The amount uses the same
window as `POST /pay/:username/invoice`. An amount the page would already
refuse is **400** `{ "error": "Enter a whole number of sats" }`. An
invalid username, an unknown account, or a shop with no verified wallet
is **404** `{ "error": "Not found" }`. The LNURL server not being
configured is that same **404**. CORS is the page's existing origin list,
the same as `POST /pay/:username/invoice`, not `*`.

The call writes a row only when the Orchestra key is configured, this
service can obtain or reuse the BOLT11 `POST /pay/:username/invoice`
already returns for this sat count on the shop's verified in-app wallet,
and Orchestra's exact-out quote commits to that sat count on that
invoice. A missing Orchestra key, or a `PUBLIC_BASE_URL` that is
missing, blank, or not an absolute `http` or `https` URL, is **503**
`{ "error": "Stablecoin payment is unavailable" }`, writes nothing, and
does not fetch an invoice. The pay link stays the pay request it already
returns. When the key is set, a resolve or store
failure, an empty or non-safe-integer window, a failed invoice fetch, or
a BOLT11 that is missing, not a safe integer amount, or not the requested
amount, is **502** `{ "error": "Lightning Address could not be resolved" }`
and writes nothing. When that invoice is obtained and the quote does not
commit to that sat count, the call is **503**
`{ "error": "Stablecoin payment is unavailable" }` and writes nothing.

One pay link has one open amount. While a till charge is pending, the
amount is that charge. The call returns the one payment for it, creating
it if it does not exist yet. While no till charge is pending and no
payment is open, the call creates that one open payment. A later call
with the same amount returns the same id. A different amount, while a
payment is open, is **409** `{ "error": "A payment is already open" }`
and writes nothing. The open amount stays. While the payment is
`accepted`, the same call is that same **409** and writes nothing.
A page payment that is still `open` five minutes after it was created
is marked `ended` on the next read, before that read continues. Those
five minutes are the pending-charge window. Replacing the quote does
not move that time. The read then has no open amount, and a new amount
may be opened. An `accepted` payment is not ended by this clock. A stored
proof that has no result is not ended by this clock for ten minutes
after that proof was stored. When those ten minutes pass with no
answer, the next read records the proof `refused` with no `txId` and
moves an `open` payment to `ended` before it continues. This document
does not claim Orchestra sent that refusal.

On **409** the page shows that error. It does not treat a later fetch of
the pay link as the amount this payer just entered.

**Response** `200` `{ "payment": "<uuid>" }`. The page does not display
this body. It fetches the decoded LNURL again and displays that
response. The invoice button is `lightning:` plus the BOLT11. The
OpenCryptoPay deeplink is `lightning:` plus that same LNURL. It does
not add a payment query, and it does not replace the invoice button.

### Rows

A till charge is not the payment row. `quote.payment` is always
`shop_payment.id`. A page payment has no `pos_charge_id`. `pos_charge` is
not reused for a page payment.

`shop_payment` stores one payment. `id` is `quote.payment`. `account_id`
references `account`. `amount_sats` is a whole sat count of at least 1.
`status` is `open`, `accepted`, `paid`, or `ended`. `pos_charge_id` is
nullable, unique, and references `pos_charge` when set. More than one
null is allowed. At most one row per account has status `open`.
`bolt11` is the invoice this payment names. `payment_hash` is that
invoice's payment hash. Both are set when the row is created. A
replacement quote reuses them while the invoice is unpaid and unexpired.
When that invoice has expired unpaid, both are replaced by a new invoice
for the same sats. They are not replaced while a stored proof has no
result and was stored less than ten minutes ago. That proof keeps its quote, this BOLT11, and this payment hash. `created_at` is set. One proof may be stored. It holds the quote, the
method, the asset, and the proof parameter. Its result is absent until
Orchestra answers or those ten minutes pass with no answer, then `refused` or `accepted`. An `accepted` result stores the `txId` Orchestra returned. A `refused` result stores none. Absent is unresolved.
`accepted_at` is set only for `accepted` and `paid`. `paid_at` is set
only for `paid`. `ended_at` is set only for `ended`. A payment moves
from `accepted` to `ended` only when Orchestra reports that order
refunded or failed. A lapsed quote does not end an `accepted` or
`paid` payment. A page payment that is still `open` ends as stated
below.

`shop_quote` stores one quote. `id` is `quote.id`. `payment_id`
references `shop_payment`. `expires_at` is `quote.expiration`.
`transfer_amounts` is the JSON array that quote served, so a later price
cannot rewrite it. `provider_ref` is the reference Orchestra returned for
that quote. It is stored as text, it is not parsed, and it is not shown
to the wallet. The first callback that returns a detail for a method
stores that asset and that detail on this quote. The stored detail is
not part of `transfer_amounts`. A repeat of the same asset returns the
stored detail. A different asset is **400**
`{ "error": "That payment is not offered" }` and does not replace it.
The first stored detail for that quote and method wins. `created_at` is
set.

`open` serves the current quote. A fetch while that quote has not lapsed
returns it unchanged and does not mint another. A lapsed quote is
replaced by a new `shop_quote` for the same sats, except while a stored
proof has no result and was stored less than ten minutes ago. The payment id does
not change. A page payment stays `open` across those refreshes until it
is accepted, or until five minutes after it was created, whichever is
first. Replacing the quote does not extend those five minutes. When
they pass while it is still `open`, the next read marks it `ended`
before the read continues, unless a stored proof has no result and was stored less than ten minutes ago. That
proof does not end the payment and does not replace the quote. A till payment moves to `ended` when its charge expires
unpaid while the payment is still `open`, unless a stored proof has no result and was stored less than ten minutes ago. That proof does not end the payment and does not replace the quote. `DELETE /pos`, while the pending charge it would cancel belongs to a payment that is `accepted`, or whose stored proof has no result and was stored less than ten minutes ago, is **409** `{ "error": "A payment is already open" }` and cancels nothing. An `accepted` payment's charge stays `pending` or `expired` until the existing watcher confirms that payment's BOLT11. A charge held only by an unanswered proof stays that way until those ten minutes pass. The next `DELETE /pos` after that records the proof `refused` with no `txId` and moves an `open` payment to `ended` before it continues. It does not claim Orchestra sent that refusal. Otherwise, when it cancels that pending charge, an `open` payment moves to `ended`. When the BOLT11 this payment stored is settled, the payment is `paid`. The charge becoming `paid` from its separate Spark invoice does not. While the payment is still `open`, that Spark payment moves it to `ended`. While it is `accepted`, it stays `accepted` until that BOLT11 settles or Orchestra reports the order refunded or failed. Once that proof is refused, a till payment whose charge has already expired moves to `ended`.

The implementing change adds these tables. This document does not migrate
them.

### Bitcoin quantity

The Lightning asset amount is a decimal string of the integer sat count
divided by 100000000. One sat is `0.00000001`. 100000000 sats is `1`.
The string has no exponent. It is built from the integer, not printed
from a JSON number. `requestedAmount.amount` is the JSON number of that
division. `requestedAmount.asset` is `BTC`. `minSendable` and
`maxSendable` are both that sat count times 1000.

The api does not invent a gas price. The api does not invent a chain.
Lightning `minFee` is the number 0.

A stablecoin amount is the decimal string of `requiredAmountIn` divided
by 10 to the power of that asset's decimals on that chain. The decimals
are the `decimals` Orchestra names for that chain and asset on `/routes`. A pair `/routes` does not name is not offered. This service does not invent a decimal count, and the quote response's `route` labels are not that source. The string
has no exponent. It is built from the integer, not from a JSON number.
It is not the sat amount.

### Errors on the pay link

When no payment is open, the pay link returns the Lightning pay request
it already serves. Not **404**. `method` and `asset` on that call do not
select a stablecoin.

While a payment is `open`, a fetch returns its current quote. A quote
that has not lapsed is not replaced. A lapsed quote is replaced for the
same sats, except while a stored proof has no result and was stored less than ten minutes ago. The URL does not change.

While a payment is `accepted`, and until it is `paid`, the response is
still a pay request for those sats. Every `available` value is false.
It does not mint a new quote. It is not the Lightning pay request with
a minimum and a maximum. `method` and `asset` on that call are **400**
`{ "error": "That payment is not offered" }`.

When the payment is `paid` or `ended`, the pay link is free. The next
fetch, with no new amount, is the Lightning pay request.

### Errors on callback and proof

An unknown username is **404** `{ "error": "Not found" }`. A shop with no
verified wallet is that same **404** when no payment is stored. Callback
and proof of a stored payment use that payment, its quote, and its
BOLT11. A later missing verified wallet does not make those calls
**404**.

On `GET /lnurlp/tx/:username`, and on `GET /lnurlp/cb/:username` when
`method` is set, an unknown quote or a quote for another username is
**400** `{ "error": "No such quote" }`. It is not served as another
quote. An expired quote is that same **400**. On the callback, expiry
is that error even after the payment is `accepted`. On the proof, expiry
is that error only while the payment is not yet `accepted` and the proof
was not stored while the quote was valid. After `accepted` or `paid`, a
matching proof stays **200** even when `quote.expiration` is in the past.
The callback does not return the transaction detail after the quote has
lapsed.

A callback with no `method` does not check `quote`. It is the Lightning
path below.

A `method` and `asset` pair the quote does not offer is **400**
`{ "error": "That payment is not offered" }`.

A proof the quote does not accept, or a transfer Orchestra has not
accepted, is **400** `{ "error": "Payment was not accepted" }`. That
proof may be sent again while the quote is still valid and the payment
is not yet `accepted`. The error does not ask for a second payment.

None of these bodies is the 404 a different provider returns when no fiat
amount is waiting.

A proof Orchestra has accepted is **200** `{ "txId": "<id>" }`. The body
is exactly that object and no other transaction-id field. `txId` is the
reference Orchestra accepted. It is not the payer's transaction hash.
The call does not wait for bitcoin to arrive. A repeat after acceptance
is **200** and does not create a second payment. The check treats that
success as a payment only when the body carries `txId`.

A Lightning call on `GET /lnurlp/cb/:username` has no `method`.
It sends `amount` in millisats. When that amount is the fixed sat count
times 1000, the response is `{ "pr": "<bolt11>" }` for those sats. A
missing or different amount is **400**
`{ "error": "Enter a whole number of sats" }` and returns no invoice.
Variable invoices stay on the invoice callback that pay request already
names, `<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`.

## Standard and settlement

OpenCryptoPay is the exchange with the wallet, and nothing after it. A
wallet reads the sticker, fetches the payment details for a known amount,
chooses one chain and one asset, fetches the transaction for that pair,
pays, and where the standard requires a proof, sends that proof back. A
success response on that proof means the payment was accepted. Steps two
and three may be one request: `method` and `asset` on the payment-details
URL return the transaction details, or an error when that pair is not
offered.

What the provider does with the coins is not part of the standard. Two
providers can both follow it and settle differently. The provider in the
published examples holds the payer's coin, settles its merchant in fiat,
and answers 404 when no amount is waiting. 21.gifts does not. Here the
stablecoin is paid to Orchestra (Flashnet), and Orchestra pays the BOLT11
`POST /pay/:username/invoice` already returned for those sats. That route
already returns it. This document does not add a second mint.

Spark, in those examples, is a way for the payer to send bitcoin. That
method is not offered on this pay link. This payment does not deliver
the stablecoin to a Spark address. The till's existing `sparkInvoice` is
a separate payment of the same charge and is unchanged.

## Sticker

There is one QR. It belongs to the shop and the cashier. The string does
not grow a second address, and the window sticker does not change.

The sticker has two uses. A phone camera opens the payment page. A wallet
decodes the pay link and calls the api. Both uses are the same payment.
Neither is a second QR.

The cashier does not have to be online and does not have to have saved a
sat amount. The sticker, the payment page, and the api are enough. An
open till charge fixes the amount when one exists. It is not required.

## Payment page

This repository does not serve this page. The controls below are specified
and are not implemented.

The payment page is the payer's path. An empty till is not an error, and
this page is not the wallet's HTTP call.

The page shows the recipient, then the amount.

An unexpired till charge fixes the amount. The page shows it and does not
let the payer change it. This is the same lock the pay link already uses
for Lightning.

With no till charge, the payer enters the amount, in whole sats or in the
viewer's fiat, within the pay link's minimum and maximum. Fiat is
converted to whole sats by the rule that page already uses for a Lightning
amount. This repository does not contain that rule and does not add one. The result is that whole sat amount. The cashier
does not enter it.

The sat amount does not move after it is fixed. Each stablecoin figure is
a quote for those sats, including the provider fee and spread. A later
price does not change the sats.

The page then shows one option per chain and asset that the pay link
serves. When no stablecoin row is served, it shows no stablecoin amount.
USDT on Tron is not
USDT on Ethereum, and USDC is not USDT. A transfer on the wrong chain is
not a payment. Chains of one asset may be grouped under one label. The
amount due is still the amount of that chain and that asset.

The page shows the quote's expiry. When a quote lapses before it is
accepted, the page requests the next quote for the same sats.

The page shows the Lightning invoice QR for this BOLT11. No file in this
repository defines that QR or the `lightning:` button. That QR is the
BOLT11 for these sats. It is the invoice Orchestra pays. The page does
not mint a second one. It is mounted only when the invoice exists and the
visitor is not a smartphone. A smartphone is an iPhone, an iPod, or an
Android user agent that also contains `Mobile`. A tablet is not a
smartphone. The window width does not decide it. On a smartphone the page
shows the `lightning:` button and no invoice QR. That button opens
`lightning:` plus the BOLT11. That QR is not a second shop address, and
it is not the stablecoin deeplink. `displayQr` false does not remove it.
Tether Wallet for Android 1.11.0 (134) does not read `displayQr`.

The page opens an OpenCryptoPay wallet by a separate deeplink. That
deeplink is `lightning:` plus the same LNURL the page decoded. It is not
printed and is not shown as a code. It does not add a query. It does not
replace the invoice button. A wallet that decodes it fetches the same
URL the page fetched. The wallet is not given a second address. While
that payment is open and not yet accepted, a later fetch of the same URL
returns the current quote for those sats.

The page shows what the api returns. It does not call Orchestra, it does
not hold a key, and it does not record paid.

## Wallet exchange

A wallet decodes the `lightning` parameter (LUD-01) to the pay link and
fetches it. The rules below are that call.

### No amount yet

When no amount is known, the response is the Lightning pay request the
pay link already serves: a minimum, a maximum, the metadata it already
returns, and its callback on the verified wallet. There is no
stablecoin amount. The response is not an error and does not wait. The
payment page is where the payer names the amount. A wallet that scans
the sticker fetches this same URL.

### A known amount

One open amount on the pay link is a known amount. It is the pending
till charge when one exists, and otherwise the amount the page
submitted. When stablecoin rows are served, the response is the pay
request below. The URL is unchanged. Otherwise the pay link keeps
today's pinned Lightning request, and its callback stays on the verified
wallet.

A later fetch while the payment is `open` returns the current quote for
the same sats. A quote that has not lapsed is returned unchanged.
`quote.payment` does not change. After the transfer is
accepted, and until the payment is `paid`, a fetch does not offer a new
payable amount: no `available` entry is true, and the response is not
the Lightning pay request above.

For a known amount the pay request contains:

| Field                        | Value                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `tag`                        | `payRequest`                                                     |
| `callback`                   | origin from `resolvePublicApiBase`, plus `/lnurlp/cb/<username>` |
| `minSendable`, `maxSendable` | both that sat amount in millisats                                |
| metadata                     | unchanged                                                        |
| `displayName`                | the name `GET /pay/:username` returns                            |
| `recipient.name`             | the same shop name                                               |
| `standard`                   | `OpenCryptoPay`                                                  |
| `displayQr`                  | `false`                                                          |
| `quote.id`                   | UUID of this quote                                               |
| `quote.expiration`           | expiry, UTC, as named above                                      |
| `quote.payment`              | UUID of the payment this quote belongs to                        |
| `requestedAmount`            | asset `BTC`; `amount` is the JSON number named above             |
| `transferAmounts`            | one entry per method, Lightning first                            |

A `transferAmounts` entry has `method`, `minFee`, `assets`, and
`available`. `assets` holds `{ "asset", "amount" }`. Lightning's amount
is the bitcoin quantity named above. A stablecoin amount is the decimal
string named above. Lightning's method is `Lightning`, its asset is
`BTC`, its `minFee` is the number 0, and `available` is true. Each other
method is one chain Orchestra quoted. Its assets are `USDT`, `USDC`, or
both. No other asset is listed. `minFee` is the number Orchestra named
for that chain, when the quote names one. The api does not invent a gas
price and does not change the unit of a fee the quote names. The standard
reads an EVM `minFee` as a gas price in wei and a Bitcoin `minFee` as
sat/vB. This service copies a named number and does not rescale it.
Orchestra's quote names no gas price. A chain whose quote names no
minimum fee has `minFee` 0. The wallet pays its own network fee. The
Tether check fails if that build will not send a method whose `minFee`
is 0. A chain Orchestra did not quote is absent. A method name Tether
Wallet for Android 1.11.0 (134) does not recognise is absent. An empty
method name is absent. A listed method has `available` true.

`recipient` has the shop name and no other field. The pay request does
not include `id`, `externalId`, `mode`, `route`, or `possibleStandards`.
Both ids are of this api. `quote.payment` is not an amount. The pay
link's path does not change.

### Transaction

The wallet calls `callback` with a GET and the query parameters `quote`,
`method`, and `asset`. The method name is the name in `transferAmounts`.
The response is the transaction detail the standard defines for that
method, and it expires with the quote. Lightning returns the BOLT11
invoice in `pr`. A `pr` that is not an invoice is not a Lightning
detail. A stablecoin returns a `uri` whose destination is Orchestra's.
21.gifts does not hold it. Orchestra's quote does not contain that URI.
The quote sets `includeCalldata` so an EVM source can return an unsigned
transaction: chain id, destination, data, and value. For an exact-out
quote that transaction encodes the source amount, not the sat count. The
`uri` is the EIP-681 URI built from those fields. An EVM `uri` is
EIP-681. A source that returns no instruction this service can express
as that `uri` is absent. This service does not invent a URI for a chain
that returns only a deposit address. An EVM `uri` Tether Wallet for
Android 1.11.0 (134) cannot route as EIP-681 fails the check in Tether
Wallet.

The same detail is returned by one GET that sets `method` and `asset` on
the pay link while its payment is still open. The detail belongs to the
current quote. When the method lists both assets, the call returns the asset and the
detail stored on the quote for this method. A repeat of that asset
returns the stored detail. A later callback for the other asset is
**400** `{ "error": "That payment is not offered" }` and does not
replace it. An unknown pair or a quote that has expired is an
error and creates no payment. It is not served as another quote.

### Proof

The wallet pays the instruction. Where the standard requires a proof for
that method, the wallet sends a GET to the proof URL, built by replacing
`/cb` with `/tx` in `callback`. The username stays. The query carries
`quote` (the quote UUID), `method`, and the proof parameter the standard
defines for that method: `hex` for EVM, Bitcoin, and Firo; `tx` for
Monero, Zano, Solana, Tron, and Cardano. Spark, Internet Computer, and
BinancePay are not offered, and their parameters are not accepted. The
paths are `GET /lnurlp/cb/:username` and `GET /lnurlp/tx/:username`. They
are not `…/lnurlp/<username>/invoice`. Lightning sends no proof. A
Lightning wallet that calls `callback` with the fixed amount still
receives the BOLT11 invoice in `pr`. That call does not create an
Orchestra quote. The invoice it returns is the one the stablecoin quote
names.

Tether Wallet for Android 1.11.0 (134) builds its proof request from
`callback`. Those two paths are not stored as strings in that build. The
request the check sends is `GET /lnurlp/tx/:username`. A different URL
fails the check. This service does not add a second proof path.

For a proof, the api returns success the first time only when the
payment is still `open`, the transfer matches the quote, and Orchestra
has accepted it: the offered chain, the offered asset, the quoted
amount, and a quote that was still valid. Before it asks Orchestra, it
stores that proof: the quote, the method, the asset, and the proof
parameter. The proof query does not carry `asset`. The asset is the one
that method lists. When the method lists both, the asset is the one
stored on the quote for that method. If it lists both and no such detail
is stored, the proof is **400**
`{ "error": "That payment is not offered" }` and nothing is stored. A payment that is `ended`, and that has no such stored proof,
is not moved to `accepted` by a later proof. While a stored proof has
no result and was stored less than ten minutes ago, that proof is not refused for quote expiry. A retry in that time
asks Orchestra again. Orchestra unreachable is **503**
`{ "error": "Stablecoin payment is unavailable" }`. The stored proof
stays unresolved and the payment stays `open` for ten minutes after
the proof was stored. A retry in that time asks Orchestra again. When
those ten minutes pass with no answer, the next read, `POST /pos`, or
`DELETE /pos` records the proof `refused` with no `txId` and moves an
`open` payment to `ended` before it continues. It does not claim
Orchestra sent that refusal. When Orchestra accepts, it stores `accepted` and the `txId` Orchestra
returned. The response is **200** `{ "txId": "<id>" }`, including when
the quote has lapsed since the proof was stored. A payment that is
still `open` becomes `accepted`. A payment that is already `paid`
stays `paid`. When Orchestra does not accept, the stored proof is
`refused` and stores no `txId`. The response is **400**
`{ "error": "Payment was not accepted" }`. A `paid` payment stays
`paid`. While the payment is still `open`, the five-minute read may
end it again. A repeat answers from that stored result, not from the
payment status. Only `accepted` with its stored `txId` is **200**. A
proof with no result that was stored less than ten minutes ago is asked of Orchestra again, even when the BOLT11
has been paid directly. A proof request after those ten minutes, while the result is still absent, records the proof `refused` with no `txId`, moves an `open` payment to `ended`, and returns **400** `{ "error": "Payment was not accepted" }`. It does not ask Orchestra again, and it does not claim Orchestra sent that refusal. A `refused` proof stays **400**, including
when that BOLT11 has since been paid. That direct payment does not
invent a `txId`. From the moment Orchestra has accepted, the sats stay
due until that invoice settles. The response does not wait for
delivery, and a wallet is not told to pay again because the bitcoin
has not arrived.

Any other transfer is an error. Nothing is due, and the shop is not paid.

## Quote

The api creates the quote. The cashier's phone does not, and the member's
phone does not. The 12 words are not read.

The quote is for the fixed sat amount. The BOLT11 is the one
`POST /pay/:username/invoice` already returns for those sats on the
shop's verified in-app wallet. That route already returns it. This
document does not add a second mint.
Orchestra's destination is
that invoice. The invoice amount is that sat count. The quote is
exact-out. The amount sent to Orchestra is the integer string of that
sat count, and slippage is 0 basis points, because the invoice amount
cannot move. The quote commits only when `targetAmountOut` is that same
count. The stablecoin figure is `requiredAmountIn` for that chain and
asset.

The page's invoice QR is this invoice. `POST /pay/:username/invoice`,
while this payment is open for these sats, returns this invoice and does
not request another while it is unpaid and unexpired. A replacement quote
reuses that invoice. When it has expired unpaid, this service requests a
new invoice for the same sats and the new quote names that invoice.
After Orchestra has accepted, this service does not request another
invoice for these sats. An invoice that is already paid is not named on a quote.

The stablecoin for the named chain and asset is paid to Orchestra.
21.gifts does not receive it and does not hold it. Orchestra pays the
invoice. The shop receives the bitcoin on its verified in-app wallet
when that invoice is confirmed. 21.gifts does not hold that bitcoin
before it arrives. This service does not deliver the stablecoin payment
to a Spark address, and it does not publish a USDT or USDC address of
its own.

The api learns that the invoice was paid from settlement of that
BOLT11, not from a phone. For a pending till charge,
`POST /pay/:username/invoice` already records that BOLT11, and the paid
watcher already marks the charge paid when it settles. This document
does not add a second watch. A page payment with no charge is not that
watch. The build that comes later is what records that page payment
paid. Nothing here is mounted.

A stablecoin row is served only when that exact-out quote commits to
this sat count on that invoice. Exact-out onto a Spark address is not
this settlement. An estimate that does not commit to the sat count is
not a quote this pay link serves. This service does not hold a
source-chain refund address, and the quote request does not send one.
The payer's address is not known when the quote is created. Omitting
the address does not withhold the quote. A refund goes to the payer's
detected source address when that address is a safe return, and it
does not come to this service. This service does not add a refund
wallet. A quote Orchestra does not return is not served. With no
committed quote, the pay link keeps today's Lightning request.

A deposit Orchestra settles for fewer sats than this count does not pay
this payment. A refund or a failed order moves the payment from
`accepted` to `ended` and records nothing paid. Silence after acceptance
does not free the pay link and does not record paid. A deposit against
a quote whose invoice is already paid is not a second sale. This service
does not take it back.

A quote that lapses before acceptance is replaced by a quote for the
same sats, and only while the payment is still `open`, except while a stored proof has no result and was stored less than ten minutes ago. No replacement
is made after the payment has ended. An unexpired quote is returned as
stored. A later fetch does not mint a second one. A quote for an open till charge also ends when
the charge ends, if that is sooner, unless a stored proof has no result and was stored less than ten minutes ago. That proof keeps the quote and the sticker. Otherwise, after the charge has ended, the sticker takes
a new amount from the next payer and does not keep the charge's quote.
The sats of the replacement do not change. The Tether Wallet check fails
if it reports `OPEN_CRYPTO_PAY_AMOUNT_CHANGED` for that replacement.

An amount entered on the page is the one open amount of that pay link.
A later fetch of the same URL returns it until the payment is accepted
or ended. While it is still `open`, it ends five minutes after it was
created, unless a stored proof has no result and was stored less than ten minutes ago. A pending till charge is
that open amount. The page does not replace it, and a page amount does
not replace a pending charge.

With no Orchestra key configured, the pay link serves no stablecoin
amount. Lightning is unchanged.

## Paid

Paid is recorded once, when the BOLT11 already returned for these sats
is settled. Orchestra paying that BOLT11 is that confirmation. A direct
Lightning payment of the same invoice is the same confirmation. A success
response, a proof, and the payment page do not record it. Acceptance
does not record it.

Until that settlement, too little, too much, the wrong chain, a stale
amount, or a transfer with no valid quote leaves the payment unpaid. A
stale amount is not treated as a different number of sats. After
Orchestra has accepted, the page does not request another invoice for
these sats. After the invoice is confirmed, the pay link offers no
stablecoin amount. This service does not take those coins back.

The member's app shows the record as an ordinary incoming bitcoin
payment of those sats. It shows no USDT or USDC balance and no
stablecoin. It does not create the quote, watch the swap, report the
payment, or add a receive step. The payment counts while the phone is
off.

No zap, gift, or message is written.

## Till

A charge is not required for the payment above. Creating one and its five
minutes stay as they are.

`POST /pos` still takes a whole sat amount of at least 1, inside the
verified wallet's minimum and maximum, for an account with a username
and a verified wallet. No verified wallet is **400**
`{ "error": "Set up your wallet first", "code": "wallet_required" }`.
One unexpired pending charge. Five minutes. While a `shop_payment` for
that account is `accepted`, or `open` with a stored proof whose result
is absent and that was stored less than ten minutes ago, the call is **409** `{ "error": "A payment is already open" }`
and writes nothing. When that proof was stored at least ten minutes ago and still has no result, the call records it `refused` with no `txId` and moves that `open` payment to `ended` before it continues. It does not claim Orchestra sent that refusal. While a page payment is `open`, no till charge is
pending, and no proof is stored or the stored proof is `refused`, the
call marks that payment `ended` and then creates the charge. A refused
proof is a result, not an in-flight payment. `DELETE /pos` is that same
**409** and cancels nothing while the pending charge belongs to a
payment that is `accepted`, or whose stored proof has no result and was stored less than ten minutes ago. An `accepted` payment's
charge stays `pending` or `expired` until the existing watcher confirms
that payment's BOLT11. A charge held only by an unanswered proof stays that way until those ten minutes pass. The next `DELETE /pos` after that records the proof `refused` with no `txId` and moves an `open` payment to `ended` before it continues. It does not claim Orchestra sent that refusal. The pay link is one public
URL and carries no payment id, so that open payment pins the URL until
this call or the five minutes. While it is pending, both Lightning
sendable bounds become that sat amount in millisats. Metadata stays on
the pay request the verified wallet already returns. When the Orchestra
key is configured and Orchestra commits to those sats on the invoice for
this charge, the stablecoin amounts for those same sats are added beside
that pin, and `callback` is the origin `resolvePublicApiBase` already
returns for `PUBLIC_BASE_URL`, plus `/lnurlp/cb/<username>`. Otherwise
callback and metadata stay on that pay request.

A lapsed quote is replaced only while the charge is open and only for the
same sats. It is not replaced while a stored proof has no result and was
stored less than ten minutes ago.

The charge is paid when the BOLT11 for those sats is settled. Orchestra
pays that BOLT11. One charge is paid once. While that charge is pending
and free in-app payments are on, the same invoice route also returns
`sparkInvoice`, a `spark1…` invoice for exactly those sats to the shop's
verified wallet key, memo `pos:<chargeId>`. A 21.gifts in-app wallet
pays that invoice without a fee. This document does not change that
payment and does not settle the stablecoin transfer on Spark.
`GET /pos` already returns `{ charge, history }`. Status is `pending`,
`paid`, `cancelled`, or `expired`, and every row carries `paidAt`. The
paid watcher already marks the charge `paid` once the Spark invoice or a
BOLT11 the api handed out settles, and `charge` stays that paid row for
60 seconds when no pending charge is open. It watches a charge that is
`pending`, or `expired` less than ten minutes ago, and it stops once
the charge is paid or cancelled. `SPEC.md:504`. `history` stays the
newest 20 rows. This document does not change that response. While a
`shop_payment` for that charge is `accepted`, this specification keeps
that same worker watching that payment's BOLT11 until it settles or
Orchestra reports the order refunded or failed. A Spark invoice that
has already marked the charge `paid` does not stop that watch and does
not mark the shop payment `paid`. It does not stop at ten minutes.
That longer watch is not mounted. A paid
charge does not pin the pay link. A page payment with no charge is paid
when the invoice this payment named is settled. It is not left open
after that. No zap, gift, or message is written for a till payment.

Sats that arrive after the five minutes still pay that charge when the
transfer was accepted against a quote that was valid for it and that
continued watch still includes the charge. That later arrival is the
invoice settlement of a transfer already accepted. It is not a new
proof. A transfer sent after the charge has ended, with no such quote,
does not pay it. The sticker then takes a new amount from the next
payer.

## Tether Wallet

The wallet this payment must satisfy is Tether Wallet for Android,
version 1.11.0, build 134. A later build is not this check until it has
been read the same way. The Wallet Development Kit signs a transaction
and broadcasts it. It is not the OpenCryptoPay client. The client is
the app module `services/opencryptopay/`. That module has a route and a
pending-proof store. An EVM payment instruction is an EIP-681 URI.

The client is compiled into that Android package. A client written from
the OpenCryptoPay description is not this check.

### What that build reads

That build reads `requestedAmount`, `transferAmounts`, `minSendable`,
`maxSendable`, `quote`, and `callback`. It requests
`/.well-known/lnurlp/`. It does not contain a `payment` query. It does
not contain `displayQr`. It does not contain `/lnurlp/cb` or
`/lnurlp/tx`. A method name it sends is a non-empty string. The words are
`fetchOpenCryptoPayPayment methodName must be a non-empty string`.
Lightning invoices are one-time payments and can't be saved as a contact.
Pay it from the home screen instead.

A success it cannot read a transaction id from is not a payment. The
words are `getOpenCryptoPayPayment succeeded but returned no transaction ID`.
This service returns `txId` and no other transaction-id field. `txId` is
the reference Orchestra accepted. It is not the payer's transaction
hash. The check requires `txId`.

For a Lightning invoice it can no longer pay, it says `This invoice can
no longer be paid. It may have expired or already been paid.`

### Results the build names

The comparison that returns each name is in the compiled client. This
document does not restate it. The confirmation name is
`OPEN_CRYPTO_PAY_CONFIRMING`.

`OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT`, `OPEN_CRYPTO_PAY_STANDARD`,
`OPEN_CRYPTO_PAY_QUOTE_EXPIRED`, `OPEN_CRYPTO_PAY_AMOUNT_CHANGED`,
`OPEN_CRYPTO_PAY_RAILS`, `OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE`,
`OPEN_CRYPTO_PAY_RAIL_SHORTFALL`, `OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS`,
`OPEN_CRYPTO_PAY_CONFIRMING`, `OPEN_CRYPTO_PAY_PROOF`,
`OPEN_CRYPTO_PAY_SETTLED`,
`OPEN_CRYPTO_PAY_NOT_SETTLED_PENDING_RAMP_LIMIT`, `LNURL_AMOUNT_RANGE`,
`LIGHTNING_INVOICE_UNPAYABLE`, `LIGHTNING_INVOICE_EXPIRED`.

The build also contains `OPEN_CRYPTO_PAY_ROUTER_DISMISS_ALL_TYPE`. That
name is not a payment result of this check.

`MAX_SPENDABLE` is the wallet's own spend limit.
`OPEN_CRYPTO_PAY_RAIL_SHORTFALL`, `OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS`,
and `OPEN_CRYPTO_PAY_NOT_SETTLED_PENDING_RAMP_LIMIT` are the payer's
balance or a ramp limit. None of these four is a verdict on the pay link.

The pending proof ends in one of these sentences:

- `background proof: proving again`
- `background proof: confirming the send row off the settled sale`
- `background proof: transfer failed on chain, nothing to prove`
- `background proof: failed before the provider was reached`
- `background proof: abandoned, the wallet was torn down`
- `background proof: giving up, the proof has aged out`
- `background proof: giving up, the transfer stays unproven`
- `background proof: giving up, the transfer was never confirmed`
- `background proof: not proving again, the proof is no longer claimable`

The build also contains `released: proof kept, the provider never answered`,
`No armed proof for this payment; a transfer may go unproven`,
`claimed: proof is now owed`, and `No Open CryptoPay proof attempt yet`.
None of these is a pass. A proof the provider never answered, while the
quote was still valid, is a failure of this service.

Settled is a pass. Giving up, aged out, still unproven, never confirmed,
or no longer claimable is a failure of this service when the quote was
still valid and the transfer matched it. A transfer that failed on chain,
a wallet torn down, and a proof that never reached the provider are not
failures of this service. Proving again, and confirming the send row off
the settled sale, are not the result of the check.

### The HTTP check

The check is one test in the existing HTTP end-to-end suite. That suite
boots the service and sends HTTP. It does not open a browser and it
does not broadcast a stablecoin transfer. Orchestra is a stand-in that
returns one quote and accepts one proof. The test is not in the suite
today. It cannot pass until the routes in this document exist.

The driver is the OpenCryptoPay routine from Tether Wallet for Android
1.11.0 (134). The input is the sticker `/pl/?lightning=<LNURL>`. The
routine decodes that LNURL and requests the decoded URL.

For one open amount, the routine reaches settled for each stablecoin method the pay link offers, and only for the asset stored on the quote for that method. Lightning is offered and is not in that loop. A second asset on the same method does not have to reach settled. `requestedAmount` is asset `BTC`. That does
not remove the stablecoin rows. The proof request is
`GET /lnurlp/tx/:username`. A different URL fails the check. A repeat of
that same proof is **200** and does not create a second payment. The
success body is exactly `{ "txId": "<id>" }`. A body without `txId`
fails the check.

With no open amount, the routine receives the Lightning pay request.
The check requires `LNURL_AMOUNT_RANGE`. `OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT`
fails the check.

A second request while the payment is `open` and the quote has not
expired does not return `OPEN_CRYPTO_PAY_AMOUNT_CHANGED`. A replacement
quote that does fails the check. `OPEN_CRYPTO_PAY_QUOTE_EXPIRED` while
that quote has not expired fails the check.
`OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE` for a method this service offered
fails the check.

The balance, spend limit, and ramp results above do not fail the check.
The test does not record paid. Paid stays confirmation of the invoice
for those sats.

Two facts stay in the routine, and this document does not copy them
out:

- when it returns `OPEN_CRYPTO_PAY_AMOUNT_CHANGED`
- which method names are rails

The test is written from the routine. A client written from the
OpenCryptoPay description is not the test.

Running that Android package and paying on its screens uses the same
routine. That run is not a substitute for the HTTP test, and it is not
required to accept the HTTP contract. A later Android build replaces
the routine only after that build has been read the same way. Until
then the test names 1.11.0 (134).

## Unchanged

A payer who pays the BOLT11 pays the shop's verified in-app wallet
directly. That payment does not pass through Orchestra. The pay link
still resolves to that wallet.

A gift is still sats to that same wallet. Loans are unchanged.

The 12 words stay on the phone. This service does not hold USDT or USDC.
