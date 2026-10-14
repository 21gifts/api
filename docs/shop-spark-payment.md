# Shop payment in USDT and USDC

Status: **specified, not implemented**. Decided 2026-10-01. Names fixed
2026-10-10. The wallet check is Tether Wallet for Android 1.11.0 (134).
The names in this document are the contract. The routes are not mounted,
and `SPEC.md` does not list them. Nothing here changes runtime behaviour.

A payer may settle a shop payment in USDT or USDC. Orchestra pays the
BOLT11 stored on the quote it accepted. The invoice is minted once by the same mint
`POST /pay/:username/invoice` already uses, on the shop's verified
in-app wallet. This document does not add a second mint. The public
invoice route takes a username and an amount. It does not select one
page payment when several are open for the same amount. The shop does
not hold either stablecoin. The member sees an ordinary bitcoin payment.
Gifts, the till, and loans stay in satoshis.

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
is the earliest of three instants: the earliest `expiresAt` stored on
that quote's offers, the expiry of the BOLT11 that quote names, and the
payment deadline. The payment deadline is five minutes after a page
payment was created, or the instant its till charge ends, unless a
stored proof has no result. That unresolved proof does not end the
quote and does not replace it. That earliest instant ends the quote.
It does not by itself move the payment out of `open`. The payment
leaves `open` when Orchestra accepts a stored proof, or by the
five-minute read, or when the till charge ends while the payment is
still `open`, as those sections state. When the payment deadline is
sooner, `shop_quote.expires_at` moves to it. An offer's own
`expires_at` does not move.

The `quote` parameter uses that same form. A value that is not that form,
compared case-insensitively, is an unknown quote.

### Pay link

The pay link is `https://<domain>/.well-known/lnurlp/<username>`. It
carries no payment query and no token. A pending till charge is the only
amount that link returns. A page payment is not that amount. Tether
Wallet for Android 1.11.0 (134) requests the URL it decoded and does not
add a payment query. After the payer enters an amount, the page fetches
the capability that call returned. It does not invent that URL, and it
does not fetch this shared link for that amount.

The page is opened as `/pl/?lightning=<LNURL>`. It decodes that LNURL
and fetches the decoded URL. It does not add `timeout`. While a till
charge is pending, the amounts it shows are `requestedAmount` and
`transferAmounts` in that response. After the payer enters an amount,
those fields come from the capability response, not from this fetch.
DFX.swiss decodes the LNURL it was opened with and then sets `timeout`.
This page does not. An empty result here is the Lightning pay request,
not a 404.

### Callback and proof

When no amount is known, `callback` and metadata stay on the pay request
`GET /.well-known/lnurlp/:username` already returns for the verified
wallet. This service does not rewrite them.

Stablecoin rows are served only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` both resolve, so the pay link is already the pay
request `GET /.well-known/lnurlp/:username` returns. A missing, blank, or
non-absolute `PUBLIC_BASE_URL` leaves that route **404**. The LNURL
server is not configured, and this document does not turn that **404**
into a pay request. On the shared pay link an amount is known only when a till charge is
pending. The capability is a different URL and already names one page
payment. When both values resolve and an amount is known, but
the Orchestra key is missing or no offered pair commits, no stablecoin
row is added and the shared pay link stays the pay request it already returns.
When an amount is known and those rows are served,
`callback` is the origin `resolvePublicApiBase` already returns for `PUBLIC_BASE_URL`, plus `/lnurlp/cb/<username>`.
`https://21.gifts` becomes `https://api.21.gifts`, `https://dev.21.gifts` becomes `https://dev-api.21.gifts`, and `https://staging.21.gifts` becomes `https://staging-api.21.gifts`. One trailing slash is removed first. Any other absolute value is used as given. The proof URL replaces `/cb`
with `/tx` in that callback. The username stays. It is the
path id of the pay link. `quote.payment` stays in the JSON. It is not a
path segment and not a query on the pay link. A refreshed quote keeps
the same callback. The till callback has no query string. A page
payment's callback adds `pay`, as Page capability states. A wallet
appends its query itself. Neither URL is `…/lnurlp/<username>/invoice`.
The mounted forward is `GET /lnurlp/:username/invoice` (`SPEC.md:514`,
`src/routes/lnurl-server.ts:331`). The only same strings are
`GET /lnurlp/cb/invoice` and `GET /lnurlp/tx/invoice`. The shop routes
do not handle those two paths. They stay that forward, for usernames
`cb` and `tx`, on every query. `amount` with no `method` is that
forward. A query with `quote` or `method` is not read as this callback
or this proof. Those paths never return a shop BOLT11. Username
`invoice` is not served this payment, so no pay request names them.
`normalizeUsername` still allows `invoice`, `cb`, and `tx`
(`src/lib/username.ts:18`). This document does not change that
function. An existing account named `invoice` keeps
`GET /lnurlp/invoice/invoice`. Usernames `cb` and `tx` are served.
Their paths are `GET /lnurlp/cb/cb`, `GET /lnurlp/tx/cb`,
`GET /lnurlp/cb/tx`, and `GET /lnurlp/tx/tx`. None of those is the
forward. Username `pay` stays the one-segment pay-link exception and
is not this rule.

`GET /.well-known/lnurlp/:username`,
`GET /.well-known/lnurlp/pay/:token`, `GET /lnurlp/cb/:username`, and
`GET /lnurlp/tx/:username` take no session. They use the headers the pay
link already sends: `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, OPTIONS`, and
`Cache-Control: no-store`.

### Opening a payment

`POST /pay/:username/payment` opens a payment for the page. No session.
The body is `{ "amountSats": <integer> }`. The amount uses the same
window as `POST /pay/:username/invoice`. An amount the page would already
refuse is **400** `{ "error": "Enter a whole number of sats" }`. Checks
then run in this order. An invalid username, username `invoice`, an
unknown account, a shop with no verified wallet, or an
`LNURL_SERVER_URL` that is missing, blank, or not an absolute `http`
or `https` URL, is **404** `{ "error": "Not found" }`. Username
`invoice` is that **404** before a row is written: nothing is written
and no invoice is minted. That **404** does not include
`PUBLIC_BASE_URL`. `GET /.well-known/lnurlp/:username` is unchanged.
There, the LNURL server is configured only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` both resolve, and the server not being configured stays
**404**. CORS is the page's existing origin list, the same as
`POST /pay/:username/invoice`, not `*`.

`POST /pay/:username/payment` counts its own 120 requests per minute
per client address, the same window as
`GET /.well-known/lnurlp/:username` (`SPEC.md:323`). Over that limit
the response is **429** `{ "error": "Too many requests" }`, nothing is
written, no invoice is fetched, and Orchestra is not called. That
answer is given after the **404** checks and before a quote is
requested. An absent client address is allowed and is not counted, the
same as that limiter.

The call writes a row only when the Orchestra key is configured, as
Orchestra defines that key, this call mints one BOLT11 by the same mint
`POST /pay/:username/invoice` uses, for this sat count on the shop's
verified in-app wallet, and at least one Orchestra exact-out quote
commits to that sat count on that invoice. The minted invoice and its
payment hash are stored on the new row. The public invoice route is not
called again to find that invoice. Its body has no payment id and no
token, so it cannot name this row. Two page payments with the same
amount keep two invoices. Settlement of one does not mark the other
paid. After the **404** checks, a `PUBLIC_BASE_URL` that is missing,
blank, or not an absolute `http` or `https` URL is **503**
`{ "error": "Stablecoin payment is unavailable" }`, writes nothing, and
does not fetch an invoice. It is not that **404**.
`GET /.well-known/lnurlp/:username` stays **404** in that case and is not
a pay request. A missing Orchestra key, once both of those URLs resolve,
is that same **503**, writes nothing, and does not fetch an invoice. Only
then does the pay link stay the pay request it already returns. When the
key is set, a resolve or store
failure, an empty or non-safe-integer window, a failed invoice fetch, or
a BOLT11 that is missing, not a safe integer amount, or not the requested
amount, is **502** `{ "error": "Lightning Address could not be resolved" }`
and writes nothing. When that invoice is obtained and no offered pair commits to that sat
count, the call is **503**
`{ "error": "Stablecoin payment is unavailable" }` and writes nothing.

The shared pay link has one open amount, and only a pending till charge
sets it. This call does not set that amount, does not return the till
payment, and does not replace a pending charge. Each call that passes
the checks creates a new page payment and a new token. The same amount
does not return an existing id. A different amount is not **409**. An
open or `accepted` page payment does not make this call **409**. A page
payment that is still `open` five minutes after it was created is marked
`ended` on the next read of that payment, before that read continues.
Those five minutes are the pending-charge window. Replacing the quote
does not move that time. An `accepted` payment is not ended by this
clock. A stored proof that has no result is not ended by this clock. An
unexpired submission claim does not keep the payment `open`. The claim
stays until the earlier of that offer's `expires_at` and the expiry of
the BOLT11 stored on that quote, and a proof that matches it is
still stored as Proof states only while that BOLT11 has not expired. A missing answer does not record that
proof `refused` and does not move the payment to `ended`. The proof
stays unresolved until Orchestra answers. A retry asks Orchestra again
for that same stored proof.

This call does not answer **409**. The page does not treat a later fetch
of the shared pay link as the amount this payer just entered.

**Response** `200` `{ "payment": "<uuid>", "lnurl": "<bech32>" }`.
`payment` is the new page payment's id. `lnurl` is the LUD-01 bech32
encoding of `https://<domain>/.well-known/lnurlp/pay/<token>`, on the
same origin as the shared pay link. The page does not display this body
as text. It decodes `lnurl` and fetches that URL. It does not fetch the
shared pay link for this amount. The invoice button is `lightning:` plus
the BOLT11. The OpenCryptoPay deeplink is `lightning:` plus that same
`lnurl`. It does not add a payment query, and it does not replace the
invoice button. It is not the sticker's LNURL.

### Rows

A till charge is not the payment row. `quote.payment` is always
`shop_payment.id`. A page payment has no `pos_charge_id`. `pos_charge` is
not reused for a page payment.

`shop_payment` stores one payment. `id` is `quote.payment`. `account_id`
references `account`. `amount_sats` is a whole sat count of at least 1.
`status` is `open`, `accepted`, `paid`, or `ended`. `pos_charge_id` is
nullable, unique, and references `pos_charge` when set. More than one
null is allowed. At most one open till payment exists per account: the
row whose charge is pending. A page payment has `pos_charge_id` null and
`pay_token` set. Several page payments of one account may be `open` at
once. None of them is the amount the shared pay link returns.
`pay_token` is 32 bytes from a cryptographic random source, encoded as
base64url with no padding: 43 characters from `A-Z`, `a-z`, `0-9`, `-`,
and `_`. It is unique. It is null on a till payment. It is not the
payment UUID. Guessing that UUID does not select this payment. A token
that is not this form is unknown. `bolt11` and `payment_hash` are the
current quote's invoice. Both are set when the row is created. A page
payment's open fetch reads that row by its token. A till payment's
open fetch reads the row with that `pos_charge_id`. It is not read
from `pos_charge_invoice`, which stores only the payment hash
(`docs/schema/pos_charge.sql:34`). The public invoice route does not choose the row. A
replacement moves those two fields to the new quote's invoice only
when the current invoice has expired unpaid. They are not moved while
a stored proof has no result. The earlier quote keeps its own invoice.
An accepted proof is watched on the BOLT11 stored on its own quote,
not on a later quote. `created_at` is set. The payment row does not store a proof.
`accepted_at` is set only for `accepted` and `paid`. `paid_at` is set
only for `paid`. `ended_at` is set only for `ended`. A payment moves
from `accepted` to `ended` only when Orchestra reports that order
refunded or failed. A lapsed quote does not end an `accepted` or
`paid` payment. A page payment that is still `open` ends as stated
below.

`shop_quote` stores one public quote. `id` is `quote.id`. `payment_id`
references `shop_payment`. `expires_at` is `quote.expiration`.
`bolt11` and `payment_hash` are the invoice this quote names. Both are
set when the row is created and are not updated. A replacement quote
copies them while that invoice is unpaid and unexpired. When that
invoice has expired unpaid, the new quote stores a new invoice for the
same sats. The earlier quote keeps the invoice it was created with.
`transfer_amounts` is the JSON array that quote served, so a later price
cannot rewrite it. This row does not store an Orchestra `quoteId`, and it does not record
the asset a method will submit. `created_at` is set.

`shop_selection` stores the offer one public quote chose for one method.
`quote_id` references `shop_quote`. `method` is the chain. `offer_id`
references the `shop_offer` of that quote and method whose asset is the
one the first callback named. Unique `(quote_id, method)`. The first
callback inserts this row in that same step. The insert does not
replace an existing row. The callback and the proof both read this row,
including after a restart. It is not an Orchestra id, and it is not
shown as one. A repeat of that asset returns the detail of that offer.
A different asset of the same method is **400**
`{ "error": "That payment is not offered" }` and does not replace that
row. The offer that was not selected stays stored and is not submitted.

`shop_offer` stores one Orchestra quote for one method and one asset of
that public quote. `quote_id` references `shop_quote`. One quote,
method, and asset are one row. `method` is the chain. `asset` is
`USDT` or `USDC`. `provider_ref` is that call's `quoteId`. It is stored
as text, it is not parsed, and it is not shown to the wallet.
`expires_at` is that call's `expiresAt`. `amount` is that call's
`requiredAmountIn`. The detail is the EVM `transaction` (`chainId`,
`to`, `data`, and `value`). The `uri` is the ERC-20 `transfer` URI
Transaction states. A source that returns no instruction this service
can express as that `uri` is absent and is not stored. A pair that does
not commit is not stored, and that pair is absent. The row stores the
idempotency key of that quote call. `detail_issued_at` is set in the
same step that first returns this offer's transaction detail, and only
while the payment is still `open`. It is null until then. That timestamp
and this offer's `expires_at` are the submission claim. The claim lasts
until the earlier of `expires_at` and the expiry of the BOLT11 stored
on that quote. It does not last past that BOLT11. It is not cleared
when the payment leaves `open`. It does not move when
`shop_quote.expires_at` moves. One offer has one
claim. Returning the same detail again does not write a second claim
and does not move `detail_issued_at`. A fetch after the payment is
`paid` or `ended` does not set a claim that was not set while it was
`open`. `created_at` is set.

`shop_proof` stores one proof attempt. `offer_id` references the
`shop_offer` the quote selected for that method. The row holds that
offer, the method, the asset, the proof parameter, and the idempotency
key of that attempt. A completed `hex` broadcast also stores the derived
identifier on that row. The same quote, method, asset, and proof parameter
are one row. A different proof parameter of the same quote is another
row only when Proof accepts it and the payment is under its cap. It is stored before it is asked. At most one stored proof of a
payment has been sent and still has no result. That one is the
unresolved row stored first. While that sent proof has no result,
another row is not sent. That sent proof is retried with its own
idempotency key until Orchestra returns a definitive result. Only after that result is `refused` is the
oldest stored proof that has not been sent asked, with its own
idempotency key. The response stays the result of the proof the request
named. A repeat of a `refused` proof stays **400**. A `refused` row does not keep a later different proof
from being stored or sent. An unresolved row delays that send. It does
not discard the other row, and the clock does not record it `refused`.
When one proof of this payment becomes `accepted`, a stored proof that
was not sent is not asked. That row is recorded `refused`, it stores no
`txId`, and it was not sent to Orchestra. A later quote of the same
payment gets its own rows and does not overwrite an earlier proof. A
quote has at most one `accepted` proof. A payment has at most one
`accepted` proof. A sent row stays unresolved until Orchestra answers
it, then `refused` or `accepted`. An `accepted` result stores the
`txId` Orchestra returned. A `refused` result stores none. Absent is
unresolved. Storing a row does not move the payment from `open` to
`accepted`. A repeat of that same row answers from it and does not
insert another. `created_at` is set.

`open` serves the current quote. A fetch while that quote has not lapsed
returns it unchanged and does not mint another. A lapsed quote is
replaced by a new `shop_quote` for the same sats, except while a stored
proof has no result. The new quote can store its own proof. A refused
proof of the quote it replaced stays on that quote and stays **400**
for that same proof. The payment id does
not change. A page payment stays `open` across those refreshes until it
is accepted, or until five minutes after it was created, whichever is
first. Replacing the quote does not extend those five minutes. When
they pass while it is still `open`, the next read marks it `ended`
before the read continues, unless a stored proof has no result. That
proof does not end the payment and does not replace the quote. A till payment moves to `ended` when its charge expires
unpaid while the payment is still `open`, unless a stored proof has no result. That proof does not end the payment and does not replace the quote. `DELETE /pos`, while the pending charge it would cancel belongs to a payment that is `accepted`, whose stored proof has no result, or whose submission claim has not expired, is **409** `{ "error": "A payment is already open" }` and cancels nothing. The charge status stays with the existing watcher. The Spark invoice or a BOLT11 the api handed out can already mark that charge `paid`, and this document does not change that. A charge held only by an unanswered proof, or by an unexpired claim, is not cancelled by this call. This call does not record that proof `refused` and does not move the payment to `ended`. The proof stays unresolved until Orchestra answers. Otherwise, when it cancels that pending charge, an `open` payment moves to `ended`. When the BOLT11 stored on a quote of this payment is settled, the payment is `paid`. A later quote does not erase that invoice. The charge becoming `paid` from the Spark invoice, or from a BOLT11 handed out for that charge that is not stored on this payment, does not. While the payment is still `open` and a stored proof has no result, that payment of the charge marks only the charge `paid`. It does not move the payment to `ended` and does not record the proof `refused`. The proof stays unresolved until Orchestra answers. Otherwise, while the payment is still `open`, that payment of the charge marks only the charge `paid` and does not move the payment to `ended` in that step. A later Orchestra accept moves that `ended` payment to `accepted` when the BOLT11 stored on that proof's quote is not settled, as the proof section states. While it is `accepted`, it stays `accepted` until that BOLT11 settles or Orchestra reports the order refunded or failed. A refused proof does not move the payment to `ended`. A different proof of the same quote can be stored while the payment is still `open`, and it is sent only when no sent proof of this payment is still unresolved. The read that ends an `open` payment whose charge has expired, or whose charge is already `paid` by the Spark invoice or by a BOLT11 handed out for that charge that is not stored on this payment, still does so when no stored proof is unresolved.

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

These paragraphs are the shared pay link. A page payment is not a
payment of that link. An open page payment does not make this link
return a quote, and `method` and `asset` on this link do not select a
page offer.

The link returns a fixed amount only while the till charge is
`pending`. That is `SPEC.md:325` and `SPEC.md:545`. `shop_payment.status`
does not pin it. A charge that is `paid`, `expired`, or `cancelled`
makes the next fetch the Lightning pay request, even when the shop
payment for that charge is still `open` or `accepted`. The longer
BOLT11 watch does not pin the sticker. Not **404**.

While the charge is `pending` and no shop payment exists, the first
fetch creates that payment, its BOLT11, and its offers, as A known
amount states. A `method` and `asset` on that fetch are answered from
the offer that step stored, the same detail as the callback. Only when
the Orchestra key is missing, the mint fails, or no pair commits does
the response stay the Lightning pay request that route already serves,
with both bounds at that sat count. That failure stores no shop row,
and `method` and `asset` do not select a stablecoin.

While the charge is `pending` and the shop payment is `open`, a fetch
returns its current quote. A quote that has not lapsed is not replaced.
A lapsed quote is replaced for the same sats, except while a stored
proof has no result. The URL does not change.

While the charge is `pending` and the shop payment is `accepted`, the
response is still a pay request for those sats. Every `available` value
is false. It does not mint a new quote. It is not the Lightning pay
request with a minimum and a maximum. `method` and `asset` on that call
are **400** `{ "error": "That payment is not offered" }`.

While the charge is `pending` and the shop payment is `ended`, the
response is the Lightning pay request that route already serves, with
both bounds at that sat count. `method` and `asset` do not select a
stablecoin. The call does not mint a quote, does not replace the ended
payment, and does not clear `pos_charge_id`.

When the charge is `paid`, `expired`, or `cancelled`, the pay link is
free. The next fetch, with no new pending charge, is the Lightning pay
request. A shop payment that is still `open` or `accepted`, and a page
payment that is still open, do not keep the link pinned.

### Errors on callback and proof

An unknown username is **404** `{ "error": "Not found" }`. Username
`invoice` is not served this payment. `GET /lnurlp/cb/invoice` and
`GET /lnurlp/tx/invoice` are not this **404** and are not these routes.
They stay the invoice forward for usernames `cb` and `tx` on every
query, including `amount` with no `method`, and they do not return a
shop BOLT11. A shop with no
verified wallet is that same **404** when no payment is stored. Callback
and proof of a stored payment use that payment, its quote, and its
BOLT11. A later missing verified wallet does not make those calls
**404**.

On `GET /lnurlp/tx/:username`, and on `GET /lnurlp/cb/:username` when
`method` is set, an unknown quote or a quote for another username is
**400** `{ "error": "No such quote" }`. It is not served as another
quote. An expired quote is that same **400**. On the callback, expiry is that
error even after the payment is `accepted`, except a repeat of the asset
this quote already selected while that offer's claim has not expired.
That repeat returns the stored detail and does not create a payment. On
the proof, expiry is that error only when the proof was not stored while
the quote was valid and this offer's claim has expired or was never set.
A stored proof is answered from its stored result, not from the payment
status. Only a stored `accepted` result with its `txId` is **200**,
including when the payment is `paid` and `quote.expiration` is in the
past. A stored `refused` result stays **400**
`{ "error": "Payment was not accepted" }`, including when the payment is
`paid`. A stored proof that was sent and has no result is asked of
Orchestra again for that same proof, including when the payment is
`paid` or the BOLT11 was paid directly. A different proof that has not
been sent is not asked while that result is absent. A missing answer
is not **200** and is not that **400**.
The callback does not return a new transaction detail after the quote
has lapsed. A repeat of the stored detail, while that offer's claim has
not expired, is the exception above.

A callback with no `method` is the LNURL amount path below. It does not
mint an invoice. A `pay` query selects that one page payment. With no
`pay` query the call is the one open till payment and does not return
a page payment. It does not choose among page payments by amount.
`method=Lightning` is not this path.
`GET /lnurlp/cb/invoice` is not that path. It is the
invoice forward for username `cb` on every query, including `amount`
with no `method`, and it does not return a shop BOLT11.

`method=Lightning` with `asset=BTC` is offered. The response is the
OpenCryptoPay Lightning detail below, not this error. Any other
`method` and `asset` pair the quote does not offer is **400**
`{ "error": "That payment is not offered" }`.

A proof the quote does not accept, or a transfer Orchestra has not
accepted, is **400** `{ "error": "Payment was not accepted" }`. That
sent proof is asked again with the same idempotency key while it has
no result. A different proof parameter of the same quote may be stored
while the payment is still `open`, or while that offer's claim has not
expired, and under the cap in Proof, including when this proof is
`refused` or still unresolved. While a sent proof of this payment has
no result, that other proof is not sent. The error does not ask for a
second payment.

None of these bodies is the 404 a different provider returns when no fiat
amount is waiting.

A proof Orchestra has accepted is **200** `{ "txId": "<id>" }`. The body
is exactly that object and no other transaction-id field. `txId` is the
reference Orchestra accepted. It is not the payer's transaction hash.
The call does not wait for bitcoin to arrive. A repeat of that stored
`accepted` proof is **200** and does not create a second payment. A
`refused` proof and a proof with no result are not that repeat. The
check treats that success as a payment only when the body carries `txId`.

The LNURL amount call on `GET /lnurlp/cb/:username` has no `method` and
no `asset`, and the username is not `invoice`. Username `invoice` is not served this
payment, so this call is never `GET /lnurlp/cb/invoice`. That path is
the invoice forward for username `cb` on every query, including
`amount` alone, and it does not return a shop BOLT11. This call sends
`amount` in millisats and does not mint an invoice. A `pay` query is
that page payment's `pay_token`. It selects that one row and no other.
When `amount` is that row's sat count times 1000, the response is
`{ "pr": "<bolt11>" }` for the BOLT11 stored on that row. A `pay`
value that is not a `pay_token`, or that matches no page payment, is
**404** `{ "error": "Not found" }`. A missing or different amount is
**400** `{ "error": "Enter a whole number of sats" }` and returns no
invoice. It does not return another payment of the same amount. With
no `pay` query, the call is the one open till payment of that username.
When `amount` is that charge's sat count times 1000, the response is
`{ "pr": "<bolt11>" }` for the BOLT11 stored on that till row. It does
not return a page payment. No open till payment, or a different amount,
is that same **400** and returns no invoice. `quote` is not read on
this path. This call is not the OpenCryptoPay Lightning detail. That
detail sends `method=Lightning`, `asset=BTC`, and `quote`, and it
returns the BOLT11 stored on that quote. Variable invoices stay on the
invoice callback that pay request already names,
`<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`.

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
stored on that payment. The invoice was minted once by the same mint
`POST /pay/:username/invoice` uses. This document does not add a second
mint. The public route does not look the invoice up again.

Spark, in those examples, is a way for the payer to send bitcoin. That
method is not offered on this pay link. This payment does not deliver
the stablecoin to a Spark address. The till's existing `sparkInvoice` is
a separate payment of the same charge and is unchanged.

## Sticker

There is one QR. It belongs to the shop and the cashier. The string does
not grow a second address, and the window sticker does not change.

The sticker has two uses. A phone camera opens the payment page. A wallet
decodes the pay link and calls the api. When a till charge is pending,
both uses are that charge. When the payer enters an amount, the page uses
the capability and the wallet that decoded the sticker does not see that
amount. Neither use is a second QR.

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

The page then shows one option per chain and asset that the pay request
it fetched serves. For a till charge that request is the shared pay
link. For an amount the payer entered, it is the capability. When no
stablecoin row is served, it shows no stablecoin amount.
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

The page opens an OpenCryptoPay wallet by a separate deeplink. While a
till charge is pending, that deeplink is `lightning:` plus the sticker
LNURL the page was opened with. A wallet that decodes it fetches the
shared pay link. With no till charge, the payer's amount uses the
`lnurl` from `POST /pay/:username/payment`. That deeplink is
`lightning:` plus that value. A wallet that decodes it fetches the
capability, the same URL the page fetched. It does not fetch the shared
pay link. Neither deeplink is printed or shown as a code. Neither adds
a query. Neither replaces the invoice button. The wallet is not given a
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
returns, and its callback on the verified wallet. There is no
stablecoin amount. The response is not an error and does not wait. The
payment page is where the payer names the amount. A wallet that scans
the sticker fetches this same URL.

### A known amount

One open amount on the shared pay link is a known amount, and it is only
the pending till charge. An amount entered on the page is not that
amount. The page amount is the capability below. When stablecoin rows
are served for the till charge, the response is the pay request below.
The shared URL is unchanged. Otherwise the pay link keeps today's pinned
Lightning request, and its callback stays on the verified wallet.

Username `invoice` is not served this payment. This fetch does not
create a shop payment for it, does not mint one for it, and does not
name `/lnurlp/cb/invoice`. The response stays the Lightning pay request
the route already returns.

The first fetch while a charge is pending and no `shop_payment` has that
`pos_charge_id` creates that one payment, its BOLT11, and its offers in
the same step. This fetch mints one new BOLT11 by the same mint
`POST /pay/:username/invoice` uses, for this sat count on the shop's
verified in-app wallet, and stores that string and its payment hash on
the new row. `pos_charge_invoice` stores only `payment_hash`
(`docs/schema/pos_charge.sql:34`). It does not store the BOLT11 string,
and this fetch does not read one from that table. Hashes already
recorded for the charge keep paying the charge. They are not this
payment's invoice. Minting through that same mint, while the charge is
pending, records the new payment hash against the charge as that route
already does (`SPEC.md:673`, `src/routes/pay.ts:182`). The existing
watcher can then mark the charge paid when this invoice settles. This
fetch does not mint a second invoice for this payment while that one is
unpaid and unexpired. When that step stores an offer, a `method` and
`asset` on this same fetch return that offer's detail, the same detail
as the callback. With no `method` and no `asset`, the response is the
pay request below. The insert is
one row for that `pos_charge_id`. A concurrent fetch that loses the insert
reads the row that won. It does not create a second payment and does not
mint another invoice. If the Orchestra key is missing, the mint fails, or
no pair commits, the step leaves no `shop_payment`, no `shop_quote`, and
no `shop_offer`. The charge keeps the payment hashes the existing route
already recorded. The response stays the Lightning pay request. A later
fetch may try again. A fetch that finds the row returns that payment. It
does not start another one for the same charge.

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
`BTC`, its `minFee` is the number 0, and `available` is true while the payment is `open`. Each other
method is one chain Orchestra quoted. A chain whose proof is `hex` is
listed only when `SHOP_CHAIN_BROADCAST` has an endpoint for it. A `tx`
chain needs no endpoint. A hex chain with no endpoint is absent, is not
offered, and is not a 503. Its assets are `USDT`, `USDC`, or
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
method name is absent. While the payment is `open`, a listed method has `available` true. While it is `accepted`, and until it is `paid`, every `available` entry is false.

`recipient` has the shop name and no other field. The pay request does
not include `id`, `externalId`, `mode`, `route`, or `possibleStandards`.
Both ids are of this api. `quote.payment` is not an amount. The shared
pay link's path does not change.

### Page capability

`GET /.well-known/lnurlp/pay/:token` is one page payment. No session.
The token is that payment's `pay_token`. The route is the two segments
`pay` and the token. It is not `GET /.well-known/lnurlp/:username`. An
account whose username is `pay` stays that one-segment route. A token
that is not the form above, or that matches no page payment, is **404**
`{ "error": "Not found" }`. The response is the known-amount pay request
for this payment only, with the same fields. `callback` is the origin
from `resolvePublicApiBase` plus `/lnurlp/cb/<username>?pay=<token>`.
The token is that payment's `pay_token`. Username
`invoice` is not served, so that callback is never
`/lnurlp/cb/invoice` and the proof is never `/lnurlp/tx/invoice`.
The proof URL replaces `/cb` with `/tx` and keeps the `pay` query.
The path stays `GET /lnurlp/tx/:username`. The token is not a path
segment. A different path fails the Tether Wallet check.

While this payment is `open`, a fetch returns its current quote. A quote
that has not lapsed is returned unchanged. While it is `accepted`, and
until it is `paid`, every `available` entry is false and the response
does not mint a new quote. When it is `paid` or `ended`, the response
stays that pay request with every `available` entry false. It does not
become the Lightning pay request of the shared link, and it does not
offer another amount. `method` and `asset` on this URL return the
selected offer's detail, the same detail as the callback. The first
response that returns the detail, and only while the payment is still
`open`, sets that offer's claim. A repeat of the same asset returns the
stored detail while the claim has not expired, including when the
payment is already `paid` or `ended`. After the claim has expired, the
detail is not returned. A fetch that does not return the detail does
not set a claim. `method=Lightning` with `asset=BTC` is not an offer.
It returns the BOLT11 named in Transaction and sets no claim.

### Transaction

The wallet calls `callback` with a GET and the query parameters `quote`,
`method`, and `asset`. The method name is the name in `transferAmounts`.
The response is the transaction detail the standard defines for that
method, and it expires with the quote. The OpenCryptoPay Lightning
detail is exactly `method=Lightning` and `asset=BTC`. A `pay` query
selects that page payment, as on the LNURL amount path. With no `pay`,
the payment is the one open till payment and not a page payment.
`quote` is that payment's current quote. The body is
`{ "pr": "<bolt11>" }` for the BOLT11 stored on that quote. It does not
mint, it does not insert `shop_selection`, and it sets no submission
claim. There is no stablecoin offer for Lightning. A `pr` that is not
an invoice is not that detail. `method=Lightning` with any other asset,
a missing open payment, or a `quote` that is not that current quote, is
**400** `{ "error": "That payment is not offered" }`. When the payment
is not `open`, that query is the same 400. A stablecoin method is every listed
method other than `Lightning`. A stablecoin returns a `uri` whose destination is Orchestra's.
21.gifts does not hold it. Orchestra's quote does not contain that URI.
The quote sets `includeCalldata` so an EVM source can return an unsigned
transaction: chain id, destination, data, and value. For an exact-out
quote that transaction encodes the source amount, not the sat count. The
`uri` is one EIP-681 ERC-20 `transfer` and nothing else. `data` must be
68 bytes: `a9059cbb`, then 12 zero bytes, then the 20-byte recipient,
then the 32-byte uint256 amount. `value` must be zero. The URI is
`ethereum:` + the lowercase `0x` address in `to` + `@` + the decimal
`chainId` + `/transfer?address=0x` + the 40 lowercase hex characters of
that recipient + `&uint256=` + that amount in decimal, with no leading
zero except for zero itself. Any other `data`, or a non-zero `value`,
is not that URI. An EVM `uri` is EIP-681. A source that returns no
instruction this service can express as that `uri` is absent. This
service does not invent a URI for a chain that returns only a deposit
address. An EVM `uri` Tether Wallet for
Android 1.11.0 (134) cannot route as EIP-681 fails the check in Tether
Wallet.

The same stablecoin detail is returned by one GET that sets `method` and
`asset` on the pay request URL. On the shared link that payment is the
till payment, and only while it is still `open`. On the capability it is
that page payment, including a repeat while the claim has not expired.
The detail belongs to the current quote. Lightning on either URL is the
OpenCryptoPay Lightning detail, returned only while the payment is
`open`, and it sets no claim. The first response that returns an
offer's detail sets that offer's submission claim in the same step, and
only while the payment is still `open`. When the method lists both
assets, the first callback selects the named asset and returns that
offer's detail. A repeat of that asset returns the stored detail. A
later callback for the other asset is **400**
`{ "error": "That payment is not offered" }` and does not replace it.
An unknown pair or a quote that has expired is an error and creates no
payment. It is not served as another quote. A repeat of the stored
detail while that offer's claim has not expired is not that error.

### Proof

The wallet pays the instruction. Where the standard requires a proof for
that method, the wallet sends a GET to the proof URL, built by replacing
`/cb` with `/tx` in `callback`. The username stays. A `pay` query on
that callback stays. The wallet's query also carries
`quote` (the quote UUID), `method`, and the proof parameter the standard
defines for that method: `hex` for EVM, Bitcoin, and Firo; `tx` for
Monero, Zano, Solana, Tron, and Cardano. Spark, Internet Computer, and
BinancePay are not offered, and their parameters are not accepted. The
paths are `GET /lnurlp/cb/:username` and `GET /lnurlp/tx/:username`,
and the username is not `invoice`. They are not
`…/lnurlp/<username>/invoice`. `GET /lnurlp/cb/invoice` and
`GET /lnurlp/tx/invoice` stay the invoice forward for usernames `cb`
and `tx`, on every query. They are not this callback and not this
proof, and they do not return a shop BOLT11. Lightning sends no proof.
A Lightning wallet that calls a callback this document issued, with
the fixed amount and no `method`, receives the BOLT11 stored on the one
payment that callback names. A page callback names its payment with `pay`. A till
callback names the one open till payment and does not name a page
payment. That call does not choose by amount among page payments and
does not mint. That callback is never `/lnurlp/cb/invoice`. That call
does not create an Orchestra quote. It is not a call to
`POST /pay/:username/invoice`. The page's invoice QR is that same `pr`.

Tether Wallet for Android 1.11.0 (134) builds its proof request from
`callback`. Those two paths are not stored as strings in that build. The
path the check sends is `GET /lnurlp/tx/:username`. A page payment keeps
the `pay` query from that callback. A till payment has no `pay` query.
A different path fails the check. This service does not add a second
proof path.

The proof parameter is checked before a row is stored. `hex`, for EVM,
Bitcoin, and Firo, is the raw signed transaction: one query value, an
optional leading `0x`, then an even run of hexadecimal characters, at
least 100 and at most 200000. The stored value has no `0x`. `tx`, for
Monero, Zano, Tron, and Cardano, is one query value of exactly 64
hexadecimal characters and no prefix. Solana `tx` is one query value
of 87 or 88 base58 characters and no prefix. Any other parameter, a
repeated key, or a value outside that form is **400**
`{ "error": "Payment was not accepted" }`, stores nothing, and is not
sent. `GET /lnurlp/tx/:username` counts its own 120 requests per minute
per client address, the same window as
`GET /.well-known/lnurlp/:username` (`SPEC.md:323`). Over that limit
the response is **429** `{ "error": "Too many requests" }`, nothing is
stored, and Orchestra is not called. That answer is given before a
repeat is read. A payment stores at most 8 `shop_proof` rows. A new
parameter past that cap is the same **400**, stores nothing, and is
not sent. A repeat of a stored parameter still reads that row when the
request is under the limit.

For a proof that is not yet stored, the api stores it when the transfer
matches the quote and either the payment is still `open` and the quote
was still valid, or this offer's submission claim has not expired. The
match is the offered chain, the offered asset, and the quoted amount.
The BOLT11 stored on that quote must not have expired. An expired
BOLT11 does not store the proof and does not send it. The response is
**400** `{ "error": "Payment was not accepted" }`.
The claim is set only while the payment is still `open`, in the step
that returns that offer's detail. When the payment is already `paid` or
`ended` and this offer has no claim, or that claim has expired, the
proof is not stored and is not sent. The response is **400**
`{ "error": "Payment was not accepted" }`. Before it asks Orchestra, it
stores that proof as one `shop_proof` row for that offer, method, asset,
and proof parameter. It does not ask Orchestra when the BOLT11 stored
on that proof's quote has expired. That proof is recorded `refused`,
stores no `txId`, and the response is **400**
`{ "error": "Payment was not accepted" }`. A `paid` payment stays `paid`. An `ended` payment
stays `ended` when the proof is stored. The claim does not move either
one to `open` or `accepted`. The accept answer below is the step that
can move `ended` to `accepted`. Success is still Orchestra accepting
that stored proof. At
most one stored proof of this payment has been sent and still has no
result. While that row has no result and the payment is still `open`,
or that offer's claim has not expired, and the payment is under that
cap, a different proof is stored and is not sent. That request, and a repeat
of that unsent proof while the sent proof still has no result, is
**503** `{ "error": "Stablecoin payment is unavailable" }`. It is not
**200** and not **400**. The
sent proof is retried with its own idempotency key until a definitive
result. Only after that result is `refused` does a later
`GET /lnurlp/tx/:username` for this payment ask the oldest stored proof
that has not been sent, with that proof's own idempotency key. A repeat
of the refused proof does not ask the refused row again. That repeat
stays **400** `{ "error": "Payment was not accepted" }`. Asking the
unsent proof in that same step does not change this response. The
**200**, **400**, or **503** of the proof that was asked is the response
only when the request's proof parameter is that proof. When no unsent
proof remains, the repeat of the refused proof stays **400** and asks
nothing. A proof already stored for another quote of this payment stays
that row. A repeat of the same quote, method, asset, and proof
parameter reads the stored row and does not insert another. Once this
payment has an `accepted` proof, a different proof is not stored and
is not asked. The response is **400**
`{ "error": "Payment was not accepted" }` and does not replace the
stored `txId`. A repeat of the `accepted` proof is the **200** below. The proof
query does not carry `asset`. The asset is the one
that method lists. When the method lists both, the asset is the one
`shop_selection` stores for that method. The proof references that offer
and submits that offer's `provider_ref`. If it lists both and no
`shop_selection` row exists for that method, the proof is **400**
`{ "error": "That payment is not offered" }` and nothing is stored. A payment that is `ended` is not moved to `accepted` by storing a later
proof. An unexpired claim stores that proof and still does not move the
payment. Only the accept answer below moves it. While a stored proof has
no result, that sent proof is not refused for quote expiry while the
BOLT11 stored on that quote has not expired. An expired BOLT11 records
it `refused`, stores no `txId`, does not ask Orchestra, and the
response is **400** `{ "error": "Payment was not accepted" }`. A retry
of a proof whose BOLT11 has not expired asks Orchestra again for that
same sent proof and does not send a different proof of this payment. Orchestra unreachable is **503**
`{ "error": "Stablecoin payment is unavailable" }`. The stored proof
stays unresolved. An `open` payment stays `open`. A `paid` payment
stays `paid`. A missing answer does
not record the proof `refused`, does not move the payment to `ended`,
and is not **400** `{ "error": "Payment was not accepted" }`. When Orchestra accepts a stored proof that has no result, and this
payment has no `accepted` proof, it stores `accepted` and the `txId`
Orchestra returned. The row is not `accepted` before that answer. When
the payment is still `open`, it becomes `accepted` in that same step.
When the payment is already `paid`, it stays `paid`. When it is already
`ended` and the BOLT11 stored on that proof's quote is not settled, it becomes
`accepted` in that same step. When it is already `ended` and that
quote's BOLT11 is settled, it becomes `paid` in that same step. Storing the
proof did not move it. This accept answer does. That result is for a proof stored while the
payment was still `open`, or stored under a submission claim that had
not expired. A stored proof of this payment that was not sent is
recorded `refused` in that same step, stores no `txId`, and is not sent.
The response is **200** `{ "txId": "<id>" }` in each of those cases,
including when the quote has lapsed since the proof was stored while
that quote's BOLT11 has not expired, and
including when the Spark invoice, or a BOLT11 handed out for that charge
that is not stored on this payment, has already marked the charge
`paid`. That **200** answers a submit sent while that BOLT11 had not
expired. A submit that has not been sent after the BOLT11 expired is
the refusal above, not this **200**. That **200** answers the request
whose proof parameter is the proof Orchestra just accepted. A request whose own stored proof is
`refused` stays **400**, including when this step accepted a different
proof. The charge stays `paid`. From that
accept, a payment that is `accepted` is watched on the BOLT11 stored
on that proof's quote, not on a later quote's invoice. That is
the same accepted-payment watch stated for the till, including when this
step moved it from `ended` to `accepted`. A payment that is already
`paid` stays `paid` and is not watched again. When Orchestra does not accept, that stored proof
is `refused` and stores no `txId`. The response is **400**
`{ "error": "Payment was not accepted" }`. An `open` payment stays
`open`. A `paid` payment stays `paid`.
A refused proof does not move it to `ended`. A different proof of the
same quote may be stored while the payment is still `open`, or while
that offer's claim has not expired, and it is sent only when no sent
proof of this payment is still unresolved. Storing that different proof
does not move a `paid` or `ended` payment.
While the payment is still `open` and no stored proof is unresolved,
the read that sees the charge already `paid` by the Spark invoice, or by
a BOLT11 handed out for that charge that is not stored on this payment,
moves the payment to `ended`. Otherwise, while the payment is
still `open` and no stored proof is unresolved, the five-minute read
may end it again. An unexpired claim does not keep it `open`. A repeat answers from that stored result, not from the
payment status. Only `accepted` with its stored `txId` is **200**. A
proof that was sent and has no result is asked of Orchestra again for that same stored proof, even when the BOLT11
has been paid directly and the payment is already `paid`. When that answer carries `orderId`, the stored proof is `accepted` and the response is **200** `{ "txId": "<id>" }`. A `paid` payment stays `paid`. A different proof that has not been sent is not asked while that result is absent. A missing answer, an HTTP 409 `idempotency_in_progress`, or an HTTP 200 without `orderId` does not record it `refused`. The response is **503** `{ "error": "Stablecoin payment is unavailable" }`, not **400**. A `refused` proof stays **400**, including
when that BOLT11 has since been paid. That direct payment does not
invent a `txId`. From the moment Orchestra has accepted, the sats stay
due until that invoice settles. The response does not wait for
delivery, and a wallet is not told to pay again because the bitcoin
has not arrived.

Any other transfer is an error. Nothing is due, and the shop is not paid.

## Orchestra

Orchestra is Flashnet Orchestra. `ORCHESTRA_BASE_URL` is its origin: an
absolute `http` or `https` URL with no path. The documented origin is
`https://orchestration.flashnet.xyz`. `ORCHESTRA_API_KEY` is the server
key, the `fn_` key. A client key, `fnp_`, is not this key. The key is
configured only when the key is non-blank and the origin is absolute.
Otherwise the Orchestra key is missing. The key is not logged and not
returned.

`SHOP_CHAIN_BROADCAST` is the transport for a `hex` proof. It is a JSON
object. These routes are not mounted, so the current process does not
read it. A later build that mounts them treats a missing or blank value
as `{}` and still boots. Each value is an absolute `http` or `https`
origin with no path and no query. When that origin has userinfo, the
broadcast request uses HTTP Basic with it, and the userinfo is not
logged. An EVM chain's key is `evm:` plus the decimal `chainId` on that
offer's transaction, such as `evm:1`. Bitcoin's key is `bitcoin`. Firo's
key is `firo`. Any other key is ignored. A hex chain whose key is
absent, or whose value is not such an origin, is not offered.

Every call that sends a body uses `Content-Type: application/json`,
`Authorization: Bearer` plus the server key, and `X-Idempotency-Key` of
1 to 255 printable ASCII characters. A retry of the same unfinished
call uses the same key and the same body. Each offered pair is its own
quote call and uses its own key. A different proof uses its own key
when it is sent, and not while another sent proof of the payment has
no result. A transport timeout, HTTP 429, or HTTP 5xx leaves
that call unresolved and is retried with the same key. A quote call
stops after the budget below. A submit or status call does not invent
a deadline shorter than the stored offer's `expiresAt`. A quote call
has no `expiresAt` until it commits. An
error body is `{ "error": { "code", "message" } }`. The wallet is not
shown `message`.

`GET {ORCHESTRA_BASE_URL}/v2/orchestration/routes` takes no key. The
decimals of a chain and asset are that asset's `decimals`. A pair whose
destination is not in that asset's `route.exactOutTo` is not offered.
`/routes` in this document is this call. The quote response's `route`
labels are not the decimal source.

`POST {ORCHESTRA_BASE_URL}/v1/orchestration/quote` creates one Orchestra
quote for one chain and one asset. One public quote asks once per chain
and asset it can offer. The body is `sourceChain` the chain,
`sourceAsset` `USDT` or `USDC`, `destinationChain` `lightning`,
`destinationAsset` `BTC`, `amount` the sat count as an integer string,
`amountMode` `exact_out`, `slippageBps` 0, `recipientAddress` the
BOLT11, and `includeCalldata` true. The body does not send
`refundAddress`. The call commits only on HTTP 200 when
`targetAmountOut` is that sat count and `requiredAmountIn` is present.
That call's `quoteId` is the `provider_ref` on the `shop_offer` for
that method and asset. The expiry this document reads is that call's
`expiresAt`, stored on that offer. An EVM `transaction` is `chainId`,
`to`, `data`, and `value`. A 200 that does not commit, or any status
other than a transport timeout, HTTP 429, or HTTP 5xx, means that pair
is not offered and is not retried. A transport timeout, an HTTP 429,
or an HTTP 5xx is retried with the same key at most twice more before
this call answers. The third unfinished attempt means that pair is not
offered and is not stored. `expiresAt` is read
only from a committed quote and is the lifetime of that stored offer,
not a deadline for this call. When no pair commits, `POST /pay/:username/payment` is **503**
`{ "error": "Stablecoin payment is unavailable" }`, writes nothing, and
does not serve the quote. The shared pay link does not answer **503**
for that miss. It leaves no shop row and stays the Lightning pay request. After it has answered, the next open uses a
new key for each pair. This service does not call
`GET /v1/orchestration/estimate`.

Asking Orchestra about a stored proof is
`POST {ORCHESTRA_BASE_URL}/v1/orchestration/submit` for that proof's
offer. The quote sent is that offer's `provider_ref`, the Orchestra
`quoteId`. The call uses that proof's idempotency key. Orchestra's submit body has no field for a raw transaction. An unknown
field is ignored, so the stored `hex` is not sent. This service
broadcasts a stored `hex` only through `SHOP_CHAIN_BROADCAST`, and only
before the submit call. EVM, Bitcoin, and Firo are the only chains this
service broadcasts. A `tx` proof is not broadcast. It is the identifier
of a transaction the wallet already published, and this service does not
rebuild a transaction from it. The stored `hex` is the raw signed
transaction with no leading `0x`. For an EVM offer the request is
JSON-RPC `eth_sendRawTransaction` and the parameter is `0x` plus that
stored value. For Bitcoin and Firo the request is JSON-RPC
`sendrawtransaction` and the parameter is the stored value. One proof
attempt sends `POST` to that chain's origin with
`Content-Type: application/json` and the body
`{"jsonrpc":"2.0","id":1,"method":"<method>","params":["<parameter>"]}`.
It sends at most one repeat of that same body. The broadcast is complete
when a `result` equals the derived identifier below, with hex letters
compared case-insensitively, and that identifier is then stored on the
proof. A later ask of that proof does not send the raw transaction
again. It submits the stored identifier. A transport error, or a
JSON-RPC error whose message contains `already known`, `already in
mempool`, `already in chain`, or `already in block chain`, without
regard to case, is not final. That attempt then reads the derived
identifier from the same endpoint. For an EVM `hex` the read is
JSON-RPC `eth_getTransactionByHash` and the parameter is the derived
`txHash`. A `result` that is an object completes the broadcast. A
`result` of null does not. For Bitcoin and Firo the read is JSON-RPC
`getrawtransaction` and the parameter is the derived transaction id.
A `result` that is a string completes the broadcast. A JSON-RPC error
does not. The read is sent at most twice, and the second send is only
for a transport error. When the read finds the transaction, the
broadcast is complete and the submit follows. When the first send was
a transport error or that duplicate error and the read does not find
the transaction, the original body is sent once more and judged the
same way. A missing endpoint does not complete it. The proof is recorded
`refused`, stores no `txId`, Orchestra is not called, and the response
is **400** `{ "error": "Payment was not accepted" }`. A result that does
not match, or any JSON-RPC error that is not a transport error and is
not one of those duplicate messages, after that one repeat, is that
same `refused`. A transport error, or a read that does not find the
transaction after a transport error or a duplicate error, leaves the
proof unresolved and the response is **503**
`{ "error": "Stablecoin payment is unavailable" }`. The next ask of
that proof reads the derived identifier again and does not send the raw
transaction again. Ten minutes after the first send, a read that still
does not find the transaction records the proof `refused`, stores no
`txId`, does not call Orchestra, and the response is **400**. A refused
broadcast does not keep a later different proof from being stored or
sent. The submit body
then sends the derived identifier, not the raw bytes. For an EVM `hex`,
`txHash` is `0x` plus the 64 lowercase hexadecimal characters of the
Keccak-256 hash of the signed transaction bytes. For Bitcoin,
`bitcoinTxid` is the 64 lowercase hexadecimal characters of the
transaction id, the double SHA-256 of those bytes reversed, and the
body does not send `txHash` or `bitcoinVout`. For Firo, `txHash` is
that same Bitcoin-style transaction id. For `tx`, `txHash` is the
stored parameter unchanged, and no broadcast is attempted.
The body sends no source address. HTTP 200 with `orderId` is accepted.
The stored `txId` is that `orderId`. It is not the payer's transaction
hash and it is not the raw `hex`. HTTP 409 whose `error.code` is
`idempotency_in_progress` stays unresolved. A 200 without `orderId`
stays unresolved. Either unresolved submit answer is **503**
`{ "error": "Stablecoin payment is unavailable" }`. It is not **400**
and it does not record the proof `refused`. Any other HTTP 4xx is
`refused` and stores no `txId`. The payment moves from `open` to
`accepted` only after this accept, and only while that payment has no
`accepted` proof.

After accept, `GET {ORCHESTRA_BASE_URL}/v1/orchestration/status?id=`
the order id, with the server key. `order.status` `refunded` or
`failed` moves that payment from `accepted` to `ended`. Any other
status does not. A timeout or an HTTP 5xx leaves it `accepted`. The
status check runs on the existing paid watcher, `startPosPaidWorker`,
every 2 s (`SPEC.md:502`). This service does not add a second clock
and does not register a webhook.

## Quote

The api creates the quote. The cashier's phone does not, and the member's
phone does not. The 12 words are not read.

The quote is for the fixed sat amount. The BOLT11 is the one stored on
this payment, minted once by the same mint
`POST /pay/:username/invoice` uses, on the shop's verified in-app
wallet. This document does not add a second mint. The public invoice
route does not return this invoice by amount.
Orchestra's destination is
that invoice. The invoice amount is that sat count. The quote is
exact-out. The amount sent to Orchestra is the integer string of that
sat count, and slippage is 0 basis points, because the invoice amount
cannot move. The quote commits only when `targetAmountOut` is that same
count. The stablecoin figure is `requiredAmountIn` for that chain and
asset.

The page's invoice QR is the `pr` from the callback for this quote. That
call returns the stored invoice and does not request another while it is
unpaid and unexpired. It does not call `POST /pay/:username/invoice`.
A replacement quote reuses that invoice. When it has expired unpaid, this
service mints a new invoice for the same sats by that same mint and the
new quote names that invoice. The public invoice route still takes only
a username and an amount. While a till charge is pending it records the
payment hash against that charge, as it already does, and it does not
select a page payment.
After Orchestra has accepted, this service does not request another
invoice for these sats. An invoice that is already paid is not named on a quote.

The stablecoin for the named chain and asset is paid to Orchestra.
21.gifts does not receive it and does not hold it. Orchestra pays the
invoice. The shop receives the bitcoin on its verified in-app wallet
when that invoice is confirmed. 21.gifts does not hold that bitcoin
before it arrives. This service does not deliver the stablecoin payment
to a Spark address, and it does not publish a USDT or USDC address of
its own.

The api learns that the invoice was paid from settlement of the BOLT11
stored on that payment, not from a phone. For a pending till charge,
the paid watcher already marks the charge paid when an invoice recorded
against that charge settles. The shop payment is paid when the BOLT11
it stored settles. Another invoice the public route handed out for the
same amount does not mark a different page payment paid. This document
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
`accepted` to `ended` and records nothing paid. While that charge is
still `pending`, the next fetch of the shared pay link is the Lightning
pay request that route already serves, and the call does not mint a
quote. Silence after acceptance
does not free the pay link and does not record paid. A deposit against
a quote whose invoice is already paid is not a second sale. This service
does not take it back.

A quote that lapses before acceptance is replaced by a quote for the
same sats, and only while the payment is still `open`, except while a stored proof has no result. No replacement
is made after the payment has ended. An unexpired quote is returned as
stored. A later fetch does not mint a second one. A quote for an open till charge also ends when
the charge ends, if that is sooner, unless a stored proof has no result. That proof keeps that quote for the payment. It does not keep the sticker pinned. Once the charge is not `pending`, the next fetch of the shared pay link is the Lightning pay request. The old payment continues only through its stored quote, its callback, and its proof. After the charge has ended, the sticker takes
a new amount from the next payer and does not keep the charge's quote.
The sats of the replacement do not change. The Tether Wallet check fails
if it reports `OPEN_CRYPTO_PAY_AMOUNT_CHANGED` for that replacement.

An amount entered on the page belongs to that page payment. It is not
the open amount of the shared pay link. A later fetch of the capability
returns it until the payment is accepted or ended. While it is still
`open`, it ends five minutes after it was created, unless a stored proof
has no result. An unexpired claim does not keep it `open`. A pending
till charge is the one open amount of the shared pay link. The page does
not replace that charge, and a page amount does not replace it. The
shared link does not return the page amount.

With no Orchestra key configured, the pay link serves no stablecoin
amount. Lightning is unchanged.

## Paid

Paid is recorded once, when the BOLT11 stored on that payment
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
is absent, or has a submission claim that has not expired, the call is
**409** `{ "error": "A payment is already open" }` and writes nothing.
The claim has not expired when `detail_issued_at` is set and the current
time is before that offer's `expires_at` and before the expiry of the
BOLT11 stored on that quote. This includes a page payment
that is already `paid` or `ended` while that claim has not expired. An
unanswered proof, and an unexpired claim, do not let this call record a
proof `refused` or move that payment to `ended`. While no payment of
that account is in that state, each open page payment whose stored
proofs are absent or all `refused` is marked `ended`, and the call then
creates the charge. A refused proof is a result, not an in-flight
payment. A refused proof on an earlier quote does not keep a proof of
the quote that replaced it from being stored or sent. `DELETE /pos` is
that same **409** and cancels nothing while the pending charge belongs
to a payment that is `accepted`, whose stored proof has no result, or
whose submission claim has not expired. The charge status stays with the existing watcher. The Spark invoice or a BOLT11 the api handed out can already mark that charge `paid`, and this document does not change that. A charge held only by an unanswered proof, or by an unexpired claim, is not cancelled by this call. This call does not record that proof `refused` and does not move the payment to `ended`. The proof stays unresolved until Orchestra answers. The shared pay link is one public
URL and carries no payment id and no token. Only a pending till charge
pins that URL. A page payment does not. The capability is a different
URL and is not the sticker. While it is pending, both Lightning
sendable bounds become that sat amount in millisats. Metadata stays on
the pay request the verified wallet already returns. When the Orchestra
key is configured, the username is not `invoice`, and Orchestra commits
to those sats on the invoice for this charge, the stablecoin amounts
for those same sats are added beside that pin, and `callback` is the
origin `resolvePublicApiBase` already returns for `PUBLIC_BASE_URL`,
plus `/lnurlp/cb/<username>`. That callback is never
`/lnurlp/cb/invoice`. Otherwise
callback and metadata stay on that pay request. That commit is the first
fetch of the shared pay link. It creates the one `shop_payment` for this
charge, as A known amount states. This section does not create a second
one. If no pair commits, no shop row is written.

A lapsed quote is replaced only while the charge is open and only for the
same sats. It is not replaced while a stored proof has no result.

The existing watcher pays the charge once, when the Spark invoice or a
BOLT11 the api handed out for those sats settles. Orchestra paying that
BOLT11 is one of those confirmations, not the only one. While that charge is pending
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
that same worker watching the BOLT11 stored on the quote of the accepted proof until it settles or
Orchestra reports the order refunded or failed. The Orchestra status
read is that same tick, every 2 s (`SPEC.md:502`), not a second clock.
A Spark invoice, or a BOLT11 handed out for that charge that is not
stored on this payment, that has already marked the charge `paid` does
not stop that watch and does not mark the shop payment `paid`. It does not stop at ten minutes.
That longer watch is not mounted. The same tick also includes a shop
payment that became `accepted` after the charge was already `paid`.
The worker does not stay stopped for that BOLT11. It does not mark the
charge `paid` again and it does not reopen a cancelled charge. That
watch does not pin the pay link. Once the charge is `paid`, `expired`,
or `cancelled`, the next fetch of the shared link is the Lightning pay
request, even while this payment is `open` or `accepted`. A page payment with no charge is paid
when the invoice this payment named is settled. It is not left open
after that. No zap, gift, or message is written for a till payment.

Sats that arrive after the five minutes still pay that charge when it is
not yet `paid` and the existing watcher still includes it. That watcher
is every BOLT11 the api handed out for those sats while the charge was
pending, and the Spark invoice. A Lightning payment with no Orchestra
proof is one of those. This document does not add an acceptance check
to that watcher. If the Spark invoice has already marked the charge
`paid`, a later BOLT11 does not change the charge. When that BOLT11 is
the one stored on the quote of the accepted proof, and Orchestra has
accepted that transfer, it marks the shop payment `paid`. That later
arrival is the settlement of an invoice already handed out. It is not
a new proof. The watch past ten minutes applies only while the shop
payment is `accepted`, and only to the BOLT11 stored on that proof's
quote. A later quote's invoice is not that invoice. A transfer sent after the charge has
ended, with no invoice handed out while the charge was pending, does
not pay the charge. The sticker then takes a new amount from the next
payer.

## Tether Wallet

The wallet this payment must satisfy is Tether Wallet for Android,
version 1.11.0, build 134. A later build is not this check until it has
been read the same way. The Wallet Development Kit signs a transaction
and broadcasts it. It is not the OpenCryptoPay client. That broadcast
is not this proof. An OpenCryptoPay `hex` proof is the raw signed
transaction, and that client does not broadcast it. An OpenCryptoPay
`tx` proof is sent only after that client has published the transaction.
This service broadcasts a stored `hex` only through
`SHOP_CHAIN_BROADCAST`, as the submit call states. A chain with no
endpoint there is not offered. The client is
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
does not publish a transaction on a public chain. For each `hex` chain
the fixture offers, `SHOP_CHAIN_BROADCAST` names the stand-in, and the
stand-in returns the derived identifier. A hex chain with no endpoint
is absent. Orchestra is a stand-in that returns one quote and accepts
one proof. The test is not in the suite today. It cannot pass until the
routes in this document exist.

The driver is the OpenCryptoPay routine from Tether Wallet for Android
1.11.0 (134). For a pending till charge, the input is the sticker
`/pl/?lightning=<LNURL>`. The routine decodes that LNURL and requests
the decoded URL. For a page payment, the input is the capability LNURL
`POST /pay/:username/payment` returned. The routine decodes that LNURL
and requests `/.well-known/lnurlp/pay/<token>`. The sticker is not that
input. With no pending till charge, a request to the sticker is the
no-amount case below, including while a page payment is open.

For one open amount, the routine reaches settled for each stablecoin method the pay link offers, and only for the asset stored on the quote for that method. Lightning is offered and is not in the settled loop. A second asset on the same method does not have to reach settled. `requestedAmount` is asset `BTC`. That does
not remove the stablecoin rows. The Lightning request in this check is
one GET of `callback` with `method=Lightning`, `asset=BTC`, and `quote`
set to that payment's current quote. A page callback keeps its `pay`
query. A till callback has none. The body is `{ "pr": "<bolt11>" }` for
the BOLT11 stored on that quote. A different Lightning query is not this
check. The LNURL amount call, which sends no `method`, is not this
request. The proof request for a till payment is
`GET /lnurlp/tx/:username` with no `pay` query. For a page payment it
is that same path with the `pay` query the callback carried. A
different path fails the check. A repeat of
that same proof is **200** and does not create a second payment. The
success body is exactly `{ "txId": "<id>" }`. A body without `txId`
fails the check.

With no pending till charge, the sticker returns the Lightning pay request.
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

Those sentences are the whole decision rule for
`OPEN_CRYPTO_PAY_AMOUNT_CHANGED` and for rails. The check records
`OPEN_CRYPTO_PAY_AMOUNT_CHANGED` as a failure only in the two cases
above: a second request while the payment is `open` and the quote has
not expired, and a replacement quote for the same sats. It does not
add another case. A rail is a `method` in `transferAmounts` other than
`Lightning`. `OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE` for one of those
methods fails the check. A method name this build does not recognise
is absent from `transferAmounts` and is not a rail. This document does
not keep a second list of method names. The check does not pass or
fail on a predicate this section does not state.

The test asserts only those cases. A client that adds a predicate this
section does not state is not the test.

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
