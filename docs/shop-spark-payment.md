# Shop payment in USDT and USDC

Status: **concept only**. Decided 2026-10-01. Corrected 2026-10-10. Not
implemented. No HTTP path in this document is reserved. The change that
builds this adds its routes, fields, and id formats to `SPEC.md` in that
same change. Nothing here changes runtime behaviour.

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

## Standard and settlement

OpenCryptoPay is the exchange with the wallet, and nothing after it. A
wallet reads the sticker, fetches the payment details for a known amount,
chooses one chain and one asset, fetches the transaction for that pair,
pays, and where the standard requires a proof, sends that proof back. A
success response means the payment was accepted. Steps two and three may
be one request: `method` and `asset` on the payment-details URL return
the transaction details, or an error when that pair is not offered.

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

With no till charge, the payer enters the amount, in bitcoin or in the
viewer's fiat, within the pay link's minimum and maximum. Fiat is
converted to sats by the same rule the page already uses for a Lightning
amount. The result is the fixed sat amount. The cashier does not enter it.

The sat amount does not move after it is fixed. Each stablecoin figure is
a quote for those sats, including the provider fee and spread. A later
price does not change the sats.

The page then shows one option per chain and asset. USDT on Tron is not
USDT on Ethereum, and USDC is not USDT. A transfer on the wrong chain is
not a payment. Chains of one asset may be grouped under one label. The
amount due is still the amount of that chain and that asset.

The page shows the quote's expiry. When a quote lapses before it is
accepted, the page requests the next quote for the same sats.

The page shows no QR. It opens a compatible wallet by a deeplink for the
quote the api just returned. The deeplink is not printed and is not shown
as a code. The wallet's first call is the payment-details request for
that quote. The request carries the quote id. A call without that id does
not receive another payer's quote.

The page shows what the api returns. It does not call Orchestra, it does
not hold a key, and it does not record paid.

## Wallet exchange

A wallet decodes the `lightning` parameter (LUD-01) to the pay link and
fetches it. The rules below are that call.

### No amount yet

When no amount is known, the response is the Lightning pay request the
pay link already serves: a minimum, a maximum, and the metadata it
already returns. There is no stablecoin amount. The response is not an
error and does not wait. The payment page is where the payer names the
amount. A wallet that only scans the sticker does not see a quote another
payer opened on the page.

### A known amount

An open till charge is a known amount. The response is the pay request
below, with no quote id on the request.

A request that carries a quote id returns that quote while it is valid.
An unknown or expired id is not served as some other amount. The caller
receives the Lightning pay request above, unless an open till charge
fixes the amount.

For a known amount the pay request contains:

| Field | Value |
| --- | --- |
| `tag` | `payRequest` |
| `callback` | URL of the transaction details |
| `minSendable`, `maxSendable` | both the Lightning amount for those sats, in millisats |
| metadata | unchanged |
| recipient | the shop the pay link already names |
| `standard` | `OpenCryptoPay` |
| `displayQr` | `false` |
| `quote.id` | id of this quote |
| `quote.expiration` | expiry |
| `quote.payment` | the fixed amount this quote belongs to |
| `requestedAmount` | those sats, asset BTC |
| `transferAmounts` | Lightning BTC for those sats, then one entry per chain Orchestra quoted, with the USDT amount, the USDC amount, or both |

A chain Orchestra did not quote is absent. A chain whose quote names no
minimum fee is absent. `minFee` is that minimum. Lightning's `minFee` is
the fee the pay link already charges. Amounts are decimal strings.
`available` is true only for a pair the wallet may pay. No other asset is
listed.

The change that builds this chooses the format of `quote.id` and
`quote.payment` in `SPEC.md`. The pay link's path does not change.

### Transaction

The wallet calls `callback` with `quote`, `method`, and `asset`. The
method name is the name in `transferAmounts`. The response is the
transaction detail the standard defines for that method, and it expires
with the quote. Lightning returns the BOLT11 invoice in `pr`. A
stablecoin returns the `uri` Orchestra gave for that chain and asset.
The destination in that `uri` is Orchestra's. 21.gifts does not hold it.

The same detail is returned by one call that sets `method` and `asset`
on the payment-details URL of a known quote. An unknown pair is an error
and creates no payment.

### Proof

The wallet pays the instruction. Where the standard requires a proof for
that method, the wallet calls the callback URL with `/cb` replaced by
`/tx`, and sends `quote`, `method`, and the proof parameter the standard
defines for that method. Lightning sends no proof. It finishes when the
invoice is paid, and that payment does not go through Orchestra.

The api returns success only when the transfer matches the quote and
Orchestra has accepted it: the offered chain, the offered asset, the
quoted amount, and a quote that was still valid. From that moment the
sats stay due. The response does not wait for delivery, and a wallet is
not told to pay again because the bitcoin has not arrived.

Any other transfer is an error. Nothing is due, and the shop is not paid.

## Quote

The api creates the quote. The cashier's phone does not, and the member's
phone does not. The 12 words are not read.

The quote is for the fixed sat amount. It names the shop's Spark address
as the place bitcoin is delivered. That address is the one stored for the
account. It is read from the database. It is not derived from
`spark_pubkey`.

The account stores `spark_pubkey` and `spark_pubkey_verified_at` only.
The change that builds this stores the Spark address on the account and
names the column in `SPEC.md`. A missing address is treated as a missing
Orchestra key: the pay link serves no stablecoin amount, and Lightning
is unchanged. The payment does not ask the phone for the address.

The stablecoin for the named chain and asset is paid to Orchestra.
21.gifts does not receive it and does not hold it. Orchestra delivers
the bitcoin to the stored Spark address. 21.gifts does not hold that
bitcoin. The api does not ask Orchestra to pay the Lightning invoice,
and it does not publish a USDT or USDC address of its own.

The api learns the delivery from Orchestra, not from a phone.

A quote that lapses before acceptance is replaced by a quote for the
same sats. While a till charge is open, the quote also ends when the
charge ends, if that is sooner. After the charge has ended, the sticker
takes a new amount from the next payer and does not keep the charge's
quote.

A quote opened on the payment page, with no till charge, belongs to that
deeplink. It does not pin the pay link, it does not block the next
payer, and it is not a till charge.

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

The till is unchanged, and a charge is not required for the payment
above.

`POST /pos` still takes a sat amount of at least 1, the username, and a
verified receiving address. One unexpired pending charge. Five minutes.
While it is pending, the pay link pins both Lightning sendable bounds to
that amount. The callback and the metadata stay as they are. The
stablecoin amounts for those same sats are added beside the pin.

A lapsed quote is replaced only while the charge is open, and only for
the same sats.

The charge is paid on the first of these: the Spark invoice the api
handed out, a BOLT11 the api handed out, or Orchestra's delivery of the
agreed sats. One charge is paid once.

Sats that arrive after the five minutes still pay that charge when the
transfer was accepted against a quote that was valid for it. A transfer
sent after the charge has ended, with no such quote, does not pay it.
The sticker then takes a new amount from the next payer.

`GET /pos` shows a paid charge for 60 seconds. A paid charge no longer
pins the pay link. No zap, gift, or message is written for a till
payment.

## Unchanged

Lightning settlement is unchanged. The pay link still resolves to the
verified in-app wallet. A Lightning payment of the same sats does not go
through Orchestra.

A gift is still sats to the member's receiving address. Loans are
unchanged.

The 12 words stay on the phone.
