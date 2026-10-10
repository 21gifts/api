# Shop payment in USDT and USDC

Status: **specified, not implemented**. Decided 2026-10-01. Names fixed
2026-10-10. The wallet check is Tether Wallet for Android 1.11.0 (134).
The names in this document are the contract. The routes are not mounted,
and `SPEC.md` does not list them. Nothing here changes runtime behaviour.

A payer may settle a shop payment in USDT or USDC. The shop receives
bitcoin on its own Spark wallet and does not hold either stablecoin. The
member sees an ordinary bitcoin payment. Gifts, the till, and loans stay
in satoshis.

## Terms

The **sticker** is the one QR printed for that shop and that cashier. It
does not change for a quote, an amount, or a payment.

The **pay link** is the LNURL in that QR. It is the shop's existing pay
link, `https://<domain>/.well-known/lnurlp/<username>`. The QR is
`https://<domain>/pl/?lightning=<LNURL>`.

The **payment page** is what a phone camera opens from the sticker:
`/pl/?lightning=<LNURL>`.

A **quote** is a price for one fixed sat amount. It names one amount of
USDT or USDC on one chain, an expiry, and an id.

**Accepted** means Orchestra has taken a transfer that matches a quote
that was still valid. The sat amount stays due. The wallet is told the
OpenCryptoPay payment succeeded.

**Paid** means those sats are on the Spark address stored for the shop.
The api records paid when Orchestra has delivered them. Acceptance does
not record paid.

## Names

These names are the contract. Nothing in this section is mounted.
`SPEC.md` lists a route only after the change that implements it.

### Spark address

`account.spark_address` is nullable text. The quote reads it. It is not
derived from `spark_pubkey`, and the api does not encode a Spark address.
A usable value decodes to that account's `spark_pubkey` and its protobuf
has no field 2. Any other value is a missing address. The decoder used
today does not report field 2. The change that stores the column rejects
a value that has field 2. It does not add an encoder.

A missing address is the same as a missing Orchestra key. The pay link
serves no stablecoin amount, and Lightning is unchanged.

This payment does not write the column, and it does not ask the phone.
The 12 words are not read. There is no new route whose purpose is to
collect the address.

`PUT /me/wallet` remains the only wallet write. The body gains an
optional string `sparkAddress` beside `sparkPubkey`. On the first claim,
a usable `sparkAddress` for that pubkey is stored, and a missing
`sparkAddress` leaves the column null. A present value that is not usable
is **400** `{ "error": "Expected a Spark address for this wallet" }` and
the pubkey is not claimed. Once the wallet is connected, the same call
stores a usable `sparkAddress` when `sparkPubkey` equals the stored key,
and it does not replace that key. A body with no `sparkAddress` stays
**409** `{ "error": "Wallet is already connected" }`. A different pubkey
stays that same 409 and writes nothing. An open payment keeps the address
copied at its creation.

The owner account JSON includes `sparkAddress` when the column is stored,
and omits it when null. No public pay response includes it. `recipient`
has a name and no address.

### Identifiers

`quote.id` and `quote.payment` are UUIDs from `crypto.randomUUID()`, the
same shape as `pos_charge.id`. The stored form is lowercase hexadecimal,
eight-four-four-four-twelve. Neither id has a prefix. `quote.payment` is
not an amount. `quote.expiration` is UTC, millisecond precision, with a
`Z` suffix, the same form `GET /pay/:username` uses for `expiresAt`. It
is the expiry Orchestra returns for that quote. A quote for an open till
charge also ends when the charge ends, if that is sooner.

The `quote` parameter uses that same form. A value that is not that form,
compared case-insensitively, is an unknown quote.

### Pay link

The pay link is `https://<domain>/.well-known/lnurlp/<username>`. It
carries no payment query. The payment page and a wallet both read this
URL. The page does not build a second one. Tether Wallet for Android
1.11.0 (134) requests the URL it decoded and does not add a payment
query.

The page is opened as `/pl/?lightning=<LNURL>`. It decodes that LNURL
and fetches the decoded URL. The amounts it shows are `requestedAmount`
and `transferAmounts` in that response. That is the read the DFX.swiss
payment page makes of the LNURL it was opened with. An empty result here
is the Lightning pay request, not a 404, and the fetch does not wait.

### Callback and proof

When no amount is known, `callback` stays
`<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`. That URL has no `/cb`
segment.

When an amount is known and stablecoin rows are served, `callback` is
`<PUBLIC_BASE_URL>/lnurlp/cb/<username>`. The proof URL is
`<PUBLIC_BASE_URL>/lnurlp/tx/<username>`. The segments `cb` and `tx` are
literal. The username is the path id of the pay link, as the DFX.swiss
callback uses the payment link's id. Replacing `/cb/` with `/tx/` leaves
the username in place. `quote.payment` stays in the JSON. It is not a
path segment and not a query on the pay link. A refreshed quote keeps
the same callback. The callback has no query string. A wallet appends
its query itself. Neither URL is `…/lnurlp/<username>/invoice`.
`GET /lnurlp/:username/invoice` does not take these calls.

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
unknown username or a shop with no verified receiving address is **404**
`{ "error": "Not found" }`. CORS is the page's existing origin list, the
same as `POST /pay/:username/invoice`, not `*`.

The call writes a row only when the Orchestra key is configured and
`account.spark_address` is usable. Otherwise it writes nothing and
returns **503** `{ "error": "Stablecoin payment is unavailable" }`.

One pay link has one open amount. While a till charge is pending, the
amount is that charge. The call returns the one payment for it, creating
it if it does not exist yet. While no till charge is pending and no
payment is open, the call creates that one open payment. A later call
with the same amount returns the same id. A different amount is **400**
`{ "error": "Enter a whole number of sats" }` and writes nothing.

**Response** `200` `{ "payment": "<uuid>" }`. The page does not display
this body. It fetches the decoded LNURL again and displays that
response. A wallet deeplink is `lightning:` plus that same LNURL. It
does not add a payment query.

### Rows

A till charge is not the payment row. `quote.payment` is always
`shop_payment.id`. A page payment has no `pos_charge_id`. `pos_charge` is
not reused for a page payment.

`shop_payment` stores one payment. `id` is `quote.payment`. `account_id`
references `account`. `amount_sats` is a whole sat count of at least 1.
`status` is `open`, `accepted`, `paid`, or `ended`. `pos_charge_id` is
nullable, unique, and references `pos_charge` when set. More than one
null is allowed. At most one row per account has status `open`.
`spark_address` is the usable address copied at creation. `created_at`
is set.
`accepted_at` is set only for `accepted` and `paid`. `paid_at` is set
only for `paid`. `ended_at` is set only for `ended`. A payment does not
move from `accepted` to `ended`.

`shop_quote` stores one quote. `id` is `quote.id`. `payment_id`
references `shop_payment`. `expires_at` is `quote.expiration`.
`transfer_amounts` is the JSON array that quote served, so a later price
cannot rewrite it. `provider_ref` is the reference Orchestra returned for
that quote. It is stored as text, it is not parsed, and it is not shown
to the wallet. `created_at` is set.

`open` serves the current quote. A lapsed quote is replaced by a new
`shop_quote` for the same sats. The payment id does not change. A page
payment stays `open` across those refreshes until it is accepted. A till
payment moves to `ended` when its charge ends while the payment is still
`open`.

The implementing change adds these tables. This document does not migrate
them.

### Bitcoin quantity

The Lightning asset amount in `transferAmounts` is a decimal string built
from the integer sat count divided by 100000000. One sat is
`0.00000001`. 100000000 sats is `1`. The string has no exponent.
`requestedAmount.amount` is that same quantity as a JSON number.
`requestedAmount.asset` is `BTC`. The string is not formatted from the
JSON number. `minSendable` and `maxSendable` are both that sat count in
millisats, the sat count times 1000.

The api does not invent a fee. The api does not invent a chain. Lightning
`minFee` is the number 0.

### Errors on the pay link

When no payment is open, the pay link returns the Lightning pay request
it already serves. Not **404**. `method` and `asset` on that call do not
select a stablecoin.

While a payment is `open`, a fetch returns its current quote. A lapsed
quote is replaced for the same sats. The URL does not change.

While a payment is `accepted`, and until it is `paid`, the pay link
returns no `available` entry whose value is true, and the response is
not the empty Lightning pay request. `method` and `asset` on that call
are **400** `{ "error": "That payment is not offered" }`.

When the payment is `paid` or `ended`, the pay link is free. The next
fetch, with no new amount, is the Lightning pay request.

### Errors on callback and proof

An unknown username, or a shop with no verified receiving address, is
**404** `{ "error": "Not found" }`.

On `GET /lnurlp/cb/:username` or `GET /lnurlp/tx/:username`, an unknown
quote, a quote for another username, or an expired quote is **400**
`{ "error": "No such quote" }`. It is not served as another quote.

A `method` and `asset` pair the quote does not offer is **400**
`{ "error": "That payment is not offered" }`.

A proof the quote does not accept, or a transfer Orchestra has not
accepted, is **400** `{ "error": "Payment was not accepted" }`. The same
proof may be sent again while that quote is still valid. The error does
not ask for a second payment.

None of these bodies is the 404 a different provider returns when no fiat
amount is waiting.

A proof Orchestra has accepted is **200** `{ "txId": "<id>" }`. `txId` is
the reference Orchestra accepted. It is not the payer's transaction hash.
The call does not wait for bitcoin to arrive. A repeat after acceptance
is **200** and does not create a second payment. Tether Wallet for
Android 1.11.0 (134) does not treat that success as a payment when the
body carries no transaction id it can read. The id it reads is named in
the Tether Wallet section.

A Lightning call on `GET /lnurlp/cb/:username` has no `method`.
It sends `amount` in millisats. When that amount is the fixed sat count
times 1000, the response is `{ "pr": "<bolt11>" }` for those sats. A
missing or different amount is **400**
`{ "error": "Enter a whole number of sats" }` and mints no invoice.
Variable invoices stay on `GET /lnurlp/:username/invoice`.

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
stablecoin is paid to Orchestra (Flashnet), and Orchestra delivers
bitcoin to the shop's stored Spark address.

Spark, in those examples, is a way for the payer to send bitcoin. That
method is not offered. Here Spark is only the address where the shop
receives bitcoin after the swap.

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

The payment page is the payer's path. An empty till is not an error, and
this page is not the wallet's HTTP call.

The page shows the recipient, then the amount.

An unexpired till charge fixes the amount. The page shows it and does not
let the payer change it. This is the same lock the pay link already uses
for Lightning.

With no till charge, the payer enters the amount, in whole sats or in the
viewer's fiat, within the pay link's minimum and maximum. Fiat is
converted to whole sats by the same rule the payment page already uses
for a Lightning amount. The result is the fixed sat amount. The cashier
does not enter it.

The sat amount does not move after it is fixed. Each stablecoin figure is
a quote for those sats, including the provider fee and spread. A later
price does not change the sats.

The page then shows one option per chain and asset. USDT on Tron is not
USDT on Ethereum, and USDC is not USDT. A transfer on the wrong chain is
not a payment. Chains of one asset may be grouped under one label. The
amount due is still the amount of that chain and that asset.

The page shows the quote's expiry. When a quote lapses before it is
accepted, the page requests the next quote for the same sats.

The page keeps the Lightning invoice QR it already shows. That QR is
the BOLT11 for these sats. It is mounted only when the invoice exists and
the visitor is not a smartphone. A smartphone is an iPhone, an iPod, or
an Android user agent that also contains `Mobile`. A tablet is not a
smartphone. The window width does not decide it. On a smartphone the page
shows the `lightning:` button and no invoice QR. That QR is not a second
shop address, and it is not the stablecoin deeplink. `displayQr` false
does not remove it.

The page opens a compatible wallet by a deeplink. The deeplink is
`lightning:` plus the same LNURL the page decoded. It is not printed and
is not shown as a code. It does not add a query. A wallet that decodes
it fetches the same URL the page fetched. The wallet is not given a
second address. While that payment is open and not yet accepted, a later
fetch of the same URL returns the current quote for those sats.

The page shows what the api returns. It does not call Orchestra, it does
not hold a key, and it does not record paid.

## Wallet exchange

A wallet decodes the `lightning` parameter (LUD-01) to the pay link and
fetches it. The rules below are that call.

### No amount yet

When no amount is known, the response is the Lightning pay request the
pay link already serves: a minimum, a maximum, the metadata it already
returns, and its callback, `…/lnurlp/<username>/invoice`. There is no
stablecoin amount. The response is not an error and does not wait. The
payment page is where the payer names the amount. A wallet that scans
the sticker fetches this same URL.

### A known amount

One open amount on the pay link is a known amount. It is the pending
till charge when one exists, and otherwise the amount the page
submitted. When stablecoin rows are served, the response is the pay
request below. The URL is unchanged. Otherwise the pay link keeps
today's pinned Lightning request, and its callback stays
`/lnurlp/<username>/invoice`.

A later fetch while the payment is `open` returns a new quote for the
same sats. `quote.payment` does not change. After the transfer is
accepted, and until the payment is `paid`, a fetch does not offer a new
payable amount: no `available` entry is true, and the response is not
the Lightning pay request above.

For a known amount the pay request contains:

| Field | Value |
| --- | --- |
| `tag` | `payRequest` |
| `callback` | `<PUBLIC_BASE_URL>/lnurlp/cb/<username>` |
| `minSendable`, `maxSendable` | both that sat amount in millisats |
| metadata | unchanged |
| `displayName` | the shop name the payment page already shows |
| `recipient.name` | the same shop name |
| `standard` | `OpenCryptoPay` |
| `displayQr` | `false` |
| `quote.id` | UUID of this quote |
| `quote.expiration` | expiry, UTC, as named above |
| `quote.payment` | UUID of the payment this quote belongs to |
| `requestedAmount` | asset `BTC`; `amount` is a number, the bitcoin quantity of those sats, equal to the Lightning asset amount |
| `transferAmounts` | Lightning BTC for those sats, then one entry per chain Orchestra quoted, with the USDT amount, the USDC amount, or both |

`recipient` has that name and no address. A chain Orchestra did not quote
is absent. A chain whose quote names no minimum fee is absent, because
the api does not invent one. `minFee` is that minimum, a number.
Lightning's `minFee` is 0. The pay link adds no fee of its own. Each
asset amount in `transferAmounts` is a decimal string. `available` is
true only for a pair the wallet may pay. No other asset is listed.

Both ids are of this api. `quote.payment` is not an amount. The pay
link's path does not change.

### Transaction

The wallet calls `callback` with a GET and the query parameters `quote`,
`method`, and `asset`. The method name is the name in `transferAmounts`.
The response is the transaction detail the standard defines for that
method, and it expires with the quote. Lightning returns the BOLT11
invoice in `pr`. A stablecoin returns the `uri` Orchestra gave for that
chain and asset. The destination in that `uri` is Orchestra's. 21.gifts
does not hold it.

The same detail is returned by one GET that sets `method` and `asset` on
the pay link while its payment is still open. The detail belongs to the
current quote. An unknown pair or a quote that has expired is an error
and creates no payment. It is not served as another quote.

### Proof

The wallet pays the instruction. Where the standard requires a proof for
that method, the wallet sends a GET to the same callback with the path
segment `/cb/` replaced by `/tx/`. The username stays. The query
carries `quote` (the quote UUID), `method`, and the proof parameter the
standard defines for that method: `hex` for EVM, Bitcoin, and Firo;
`tx` for Monero, Zano, Solana, Tron, and Cardano. The paths are
`GET /lnurlp/cb/:username` and `GET /lnurlp/tx/:username`. They are not
`…/lnurlp/<username>/invoice`. Lightning sends no proof. A Lightning
wallet that calls `callback` with the fixed amount still receives the
BOLT11 invoice in `pr`. That payment does not go through Orchestra.

Tether Wallet for Android 1.11.0 (134) does not contain those two paths.
It builds the proof request from `callback`. The request that routine
sends is the proof the check accepts. A path it does not request is not
that proof. The check is in Tether Wallet.

For a proof, the api returns success only when the transfer matches the
quote and Orchestra has accepted it: the offered chain, the offered
asset, the quoted amount, and a quote that was still valid. From that
moment the sats stay due. The response does not wait for delivery, and
a wallet is not told to pay again because the bitcoin has not arrived.

Any other transfer is an error. Nothing is due, and the shop is not paid.

## Quote

The api creates the quote. The cashier's phone does not, and the member's
phone does not. The 12 words are not read.

The quote is for the fixed sat amount. It names the shop's Spark address
as the place bitcoin is delivered. That address is the one stored for the
account. It is read from the database. It is not derived from
`spark_pubkey`.

Today the account stores `spark_pubkey` and `spark_pubkey_verified_at`
and does not store `spark_address`. The change that adds
`account.spark_address` writes a usable value, as named above. A missing
address is treated as a missing Orchestra key: the pay link serves no
stablecoin amount, and Lightning is unchanged. The payment does not ask
the phone for the address.

The stablecoin for the named chain and asset is paid to Orchestra.
21.gifts does not receive it and does not hold it. Orchestra delivers
the bitcoin to the stored Spark address. 21.gifts does not hold that
bitcoin. The api does not ask Orchestra to pay the Lightning invoice,
and it does not publish a USDT or USDC address of its own.

The api learns the delivery from Orchestra, not from a phone.

A quote that lapses before acceptance is replaced by a quote for the
same sats. A quote for an open till charge also ends when the charge
ends, if that is sooner. After the charge has ended, the sticker takes
a new amount from the next payer and does not keep the charge's quote.
A replacement the Tether Wallet check reports as
`OPEN_CRYPTO_PAY_AMOUNT_CHANGED` is wrong. That check is below. The
sats of the replacement do not change either way.

An amount entered on the page is the one open amount of that pay link.
A later fetch of the same URL returns it until the payment is accepted
or ended. A pending till charge is that open amount. The page does not
replace it, and a page amount does not replace a pending charge.

With no Orchestra key configured, the pay link serves no stablecoin
amount. Lightning is unchanged.

## Paid

Paid is recorded only when the quoted sats are on the stored Spark
address. A success response, a proof, and the payment page do not record
it.

Until that delivery, too little, too much, the wrong chain, a stale
amount, or a transfer with no valid quote leaves the payment unpaid. A
stale amount is not treated as a different number of sats.

The member's app shows the record as an ordinary incoming bitcoin
payment of those sats. It shows no USDT or USDC balance and no
stablecoin. It does not create the quote, watch the swap, report the
payment, or add a receive step. The payment counts while the phone is
off.

No zap, gift, or message is written.

## Till

A charge is not required for the payment above. Creating one, its five
minutes, and the two confirmations the till already uses stay as they
are.

`POST /pos` still takes a whole sat amount of at least 1, inside the
receiving address's minimum and maximum, for an account with a username
and a verified receiving address. One unexpired pending charge. Five
minutes. While it is pending, both Lightning sendable bounds become that
sat amount in millisats. Metadata stays as it is. When the Spark address
is usable and the Orchestra key is configured, the stablecoin amounts
for those same sats are added beside that pin, and `callback` is
`/lnurlp/cb/<username>`. Otherwise
the callback stays `/lnurlp/<username>/invoice`.

A lapsed quote is replaced only while the charge is open, and only for
the same sats.

The charge is paid on the first confirmation: the Spark invoice
finalized at the coordinator, a BOLT11 the api handed out confirmed by
LUD-21 verify, or Orchestra's delivery of the agreed sats. One charge
is paid once. The first two stay on the watcher that already exists.

Sats that arrive after the five minutes still pay that charge when the
transfer was accepted against a quote that was valid for it. A transfer
sent after the charge has ended, with no such quote, does not pay it.
The sticker then takes a new amount from the next payer.

`GET /pos` shows a paid charge for 60 seconds. A paid charge no longer
pins the pay link. No zap, gift, or message is written for a till
payment.

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
not read `displayQr`. The strings `/lnurlp/cb` and `/lnurlp/tx` are not
in the build. The proof URL is the one this client derives from
`callback`. The test uses that URL.

The client says that a call it treats as success, and that returned no
transaction id, is not a payment. The field it reads as that id is in
the client. This service returns `txId`. If the client does not read
`txId`, the success body also carries the field the client reads. The
test is how that field is known. It is not guessed here.

For a Lightning invoice the client can no longer pay, it says the
invoice may have expired or already been paid.

### Results the build names

The comparison inside each result is in the compiled client. This
document does not restate it.

| Result | What the name says |
| --- | --- |
| `OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT` | no pending payment |
| `OPEN_CRYPTO_PAY_STANDARD` | the standard |
| `OPEN_CRYPTO_PAY_QUOTE_EXPIRED` | the quote has expired |
| `OPEN_CRYPTO_PAY_AMOUNT_CHANGED` | the amount changed |
| `OPEN_CRYPTO_PAY_RAILS` | the rails |
| `OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE` | that rail is not available |
| `OPEN_CRYPTO_PAY_RAIL_SHORTFALL` | that rail is short |
| `OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS` | the funds are insufficient |
| `OPEN_CRYPTO_PAY_CONFIRM` | confirmation |
| `OPEN_CRYPTO_PAY_PROOF` | the proof |
| `OPEN_CRYPTO_PAY_UNCONFIRMED` | not confirmed |
| `OPEN_CRYPTO_PAY_SETTLED` | settled |
| `OPEN_CRYPTO_PAY_NOT_SETTLED_PENDING_RAMP_LIMIT` | not settled because a ramp limit is pending |
| `LNURL_AMOUNT_RANGE` | the LNURL amount is a range |
| `LIGHTNING_INVOICE_UNPAYABLE` | the Lightning invoice cannot be paid |
| `LIGHTNING_INVOICE_EXPIRED` | the Lightning invoice has expired |
| `MAX_SPENDABLE` | the most the wallet can send |

`OPEN_CRYPTO_PAY_RAIL_SHORTFALL`, `OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS`,
and `OPEN_CRYPTO_PAY_NOT_SETTLED_PENDING_RAMP_LIMIT` name the payer's
own balance and a ramp limit. They are not a verdict on the pay link.
The HTTP test does not treat them as a failure of this service.

The client's pending proof ends in one of these outcomes:

- proving again
- confirming the send off the settled sale
- the transfer failed on chain, so there is nothing to prove
- the proof failed before the provider was reached
- abandoned because the wallet was torn down
- giving up because the proof has aged out
- giving up because the transfer stays unproven
- giving up because the transfer was never confirmed
- not proving again because the proof is no longer claimable

A pass is settled. Giving up, aged out, still unproven, never
confirmed, or no longer claimable is a failure of this service when the
quote was still valid and the transfer matched it. A transfer that
failed on chain, a wallet torn down, and a proof that never reached the
provider are not failures of this service. Proving again, and confirming
the send off the settled sale, are not the result of the check.

### The HTTP check

The check is one test in the existing HTTP end-to-end suite. That suite
boots the service and sends HTTP. It does not open a browser and it
does not broadcast a stablecoin transfer. Orchestra is a stand-in that
returns one quote and accepts one proof. The test is not in the suite
today. It cannot pass until the routes in this document exist.

The driver is the OpenCryptoPay routine from Tether Wallet for Android
1.11.0 (134). The input is the sticker `/pl/?lightning=<LNURL>`. The
routine decodes that LNURL and requests the decoded URL.

For one open amount, and for each chain and asset the pay link offers,
the routine reaches settled and does not return a failure result from
the table above. `requestedAmount` is asset `BTC`. That does not remove
the stablecoin rows, and the routine still settles each of those rows.
The proof request is the request the routine sends. If that request is
not `GET /lnurlp/tx/:username`, that path is not the proof for this
wallet. A repeat of that same proof is **200** and does not create a
second payment.

With no open amount, the routine receives the Lightning pay request.
That is `LNURL_AMOUNT_RANGE`, not
`OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT`.

A second request while the payment is `open` and the quote has not
expired does not return `OPEN_CRYPTO_PAY_AMOUNT_CHANGED`. A replacement
quote that does is wrong.

A method name this routine does not recognise is not offered. Offering
it is `OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE` and the test fails. An EVM
detail the routine cannot route as EIP-681 fails the test.

The test does not record paid. Paid stays the delivery of the sats.

Four facts stay in the routine, and this document does not copy them
out:

- when it returns `OPEN_CRYPTO_PAY_AMOUNT_CHANGED`
- which field it reads as the transaction id
- which method names are rails
- the proof request it builds from `callback`

The test is written from the routine. A client written from the
OpenCryptoPay description is not the test.

Running that Android package and paying on its screens uses the same
routine. That run is not a substitute for the HTTP test, and it is not
required to accept the HTTP contract. A later Android build replaces
the routine only after that build has been read the same way. Until
then the test names 1.11.0 (134).

## Unchanged

Lightning settlement is unchanged. The pay link still resolves to the
verified in-app wallet. A Lightning payment of the same sats does not go
through Orchestra.

A gift is still sats to the member's receiving address. Loans are
unchanged.

The 12 words stay on the phone.
