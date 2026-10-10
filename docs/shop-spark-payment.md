# Shop payment in USDT and USDC

Status: **concept only**. Decided 2026-10-01. Corrected 2026-10-10. Not
implemented. No HTTP path in this document is reserved. The change that
builds this adds its routes, fields, and id formats to `SPEC.md` in that
same change. Nothing here changes runtime behaviour.

The shop QR stays the OpenCryptoPay link it already is. USDT or USDC paid
through that same QR still leaves the shop with bitcoin on the shop's own
Spark wallet. The shop does not hold USDT or USDC. The member sees an
ordinary bitcoin payment. Gifts, the till, and loans stay in satoshis.

## Two different things

OpenCryptoPay is the conversation with the wallet. What the provider does
with the coins afterwards is not part of that standard. DFX.swiss and
21.gifts both follow the standard. Their backends are different, and both
are a complete implementation. Do not copy one into the other.

The standard is only this:

1. The wallet reads the QR and decodes the `lightning` parameter (LUD-01)
   to the pay-link URL.
2. It fetches the payment details for a known amount.
3. It chooses one chain and one asset and fetches the transaction details
   for that pair and that quote.
4. It pays, and where the standard requires a proof, it sends that proof
   back. A success response means the wallet's OpenCryptoPay payment was
   accepted.

Steps 2 and 3 may be one call: the payment-details URL with `method` and
`asset` returns the transaction details, or an error if that pair is not
offered.

DFX.swiss, the provider used as the example in the standard, holds the
payer's coin and settles its merchant in fiat. It keeps one pending fiat
amount on the cash register and, when none is open, the wallet call waits
and then returns 404. That is that provider's backend. It is not a rule
for 21.gifts. Do not port its payment row, its sell route, its asset
catalog, or that 404.

21.gifts is the other backend. The stablecoin is paid to Orchestra
(Flashnet). Orchestra delivers bitcoin to the Spark address stored for the
shop. The member's app shows that bitcoin. Spark in the standard's example
is a way for the payer to send bitcoin. That is not this settlement. Here
Spark is where the shop receives bitcoin after the swap.

## The sticker

One QR. It belongs to the shop and the cashier. It does not change for a
quote, an amount, or a payment. The string does not grow a second address,
and the window sticker does not change.

The QR is `https://<domain>/pl/?lightning=<LNURL>`. That LNURL is the shop's
existing pay link: `https://<domain>/.well-known/lnurlp/<username>`. It is
the only QR. It is printed on the sticker at the shop.

The same sticker has two uses. They are not two payments and not two QRs.

- A phone camera opens the page below.
- A wallet decodes the link and calls the api.

The cashier does not have to be online, and does not have to have saved a
sat amount. The sticker, this page, and the api are enough. An open till
charge fixes the amount when one exists. It is not a prerequisite.

## The page a camera opens

Opening the QR in a normal browser loads `/pl/?lightning=<LNURL>`. That
page is the payer's path. It is not an error when no till charge is open.
The wallet's HTTP call is not this page.

The page shows the recipient. Then it shows the amount:

- An unexpired till charge fixes the amount. The page shows that amount and
  does not let the payer change it. This is the same lock the pay link
  already uses for Lightning.
- No till charge: the payer enters the amount on this page, in bitcoin or
  in the viewer's fiat, within the pay link's minimum and maximum, the same
  way the page already asks for a Lightning amount. Fiat entered here is
  converted to sats the same way that Lightning amount already is. That
  result is what fixes the sat amount. The cashier does not enter it.

The sat amount does not move after it is fixed. The stablecoin figures are
a quote for those sats. They include the provider fee and spread. A later
price move does not change the sats.

Once the amount is known, the page asks the api for the quote and shows the
payment methods for those sats. Each payable option is one chain and one
asset, with its own amount. USDT on Tron is not USDT on Ethereum, and USDC
is not USDT. A transfer on the wrong chain is not a payment. The page may
group the chains of one asset under one label. The amount that must be paid
is still the amount of that chain and that asset.

The page shows that quote's expiry. When it lapses before it has been
accepted, the page asks for the next quote for the same sats.

The page shows no QR. It opens a compatible wallet by a deeplink for the
quote the api just returned. The deeplink is not printed and not shown as a
code. The wallet's first call is the payment-details request for that
quote, not a new unbounded Lightning request. The request carries the
`quote` id. A call that does not carry it does not receive another payer's
quote.

The page reads and shows what the api returns. It does not ask Orchestra
itself, it does not hold a key, and it does not mark the payment paid.

## What the wallet reads

A compatible wallet decodes the `lightning` parameter to the pay-link URL
and fetches it. This section is that call. It is not the page above.

Before an amount is known, the response is today's Lightning pay request:
a minimum and a maximum, today's metadata, and no fixed stablecoin amounts.
It is not an error, and it is not a 404. The page above is where the payer
names the amount. A wallet that only scans the sticker does not see a quote
another payer just opened on the page.

An open till charge is a known amount. The response is the pay request for
those sats, as below, without a `quote` id on the request.

A request that carries a `quote` id returns that quote while it is still
valid. An unknown or expired id is not served as a different amount. The
caller gets today's Lightning pay request instead, unless an open till
charge fixes the amount.

Once the amount is known, the pay request contains:

- `tag` of `payRequest`
- `callback`, the URL for the transaction details
- `minSendable` and `maxSendable`, both the Lightning amount for those sats,
  in millisats
- today's metadata
- the shop as recipient, the same shop the pay link already names
- `standard` of `OpenCryptoPay`
- `displayQr` false
- `quote.id`, `quote.expiration`, and `quote.payment`
- `requestedAmount` of those sats in BTC
- `transferAmounts`: Lightning BTC for those sats, then one entry per chain
  Orchestra quoted, each with the USDT amount, the USDC amount, or both

A chain Orchestra did not quote is absent. A chain whose quote has no
minimum fee is absent. `minFee` is the minimum that quote requires. The
Lightning `minFee` stays the fee the pay link already charges. Amounts are
decimal strings. `available` is true only for a pair the wallet may pay.
No other asset is listed. The example catalog in the standard (the other
coins, and bitcoin sent by the payer on Spark) is not this list.

The id format of `quote.id` and `quote.payment` is chosen in `SPEC.md` by
the change that builds this. It is not another provider's prefix.

The wallet then chooses one offered chain and one offered asset and calls
`callback` with `quote`, `method`, and `asset`. The method name is the name
from `transferAmounts`. The response is the transaction details the
standard defines for that method, with the same expiry as the quote. For
Lightning that is the BOLT11 invoice in `pr`. For a stablecoin it is the
`uri` Orchestra gave for that chain and asset. That destination is
Orchestra's. It is not an address 21.gifts holds.

The wallet pays that instruction. Where the standard requires a proof for
that method, the wallet calls the callback URL with `/cb` replaced by
`/tx`, and sends `quote`, `method`, and the proof parameter the standard
defines for that method. Lightning sends no proof. It is finished when the
invoice is paid, and that payment does not go through Orchestra.

The same transaction details are returned by one call that puts `method`
and `asset` on the payment-details URL of a known quote. An unknown pair
is an error and creates no payment.

A success response to the wallet means the transfer matched the quote and
Orchestra accepted it: the right chain, the right asset, the right amount,
and a quote that was still valid. The quoted sats stay due. A later price
move does not change them. The shop is not marked paid by this response.
Delivery is still to come. Do not answer the wallet with an error merely
because the bitcoin has not arrived yet, and do not send the wallet back
to pay again.

A wrong chain, a wrong asset, a wrong amount, an expired quote, or a
transfer Orchestra rejects is an error to the wallet. Nothing is due, and
the shop stays unpaid.

## Quote and delivery

The api creates the quote. The cashier's phone does not. The member's phone
does not. The 12 words are not part of this loop.

The api asks Orchestra for a quote for the fixed sat amount. The quote
names the shop's Spark address as the place bitcoin is delivered. That
address is the one stored for the account. The quote reads it from the
database. It does not encode an address from `spark_pubkey`.

Today the account stores `spark_pubkey` and `spark_pubkey_verified_at`
only. The change that builds this stores the Spark address on the account
and names that column in `SPEC.md`. A missing stored address is the same
as a missing Orchestra key: no stablecoin amounts, and Lightning stays as
it is. The payment does not ask the phone for the address, and it must not
learn the 12 words.

The stablecoin for the named chain and asset is paid to Orchestra. 21.gifts
does not receive the stablecoin and does not hold it.

Orchestra delivers bitcoin to the shop's stored Spark address. 21.gifts
does not hold that bitcoin. This is not Orchestra paying the Lightning
invoice, and it is not a USDT or USDC address that 21.gifts keeps.

The api learns that delivery from Orchestra. It does not learn it from the
phone.

A quote expires. When a quote lapses before it has been accepted, the next
quote is for the same sats, not for a different sat amount. For an open
till charge, the quote also ends when the charge ends, if that is sooner.
After the charge has ended, the standing QR still takes a new payer-chosen
amount. It does not keep offering the charge's quote.

A quote opened from the page, with no till charge, belongs to that page's
deeplink only. It does not pin the pay link. It does not block the next
payer. It is not a till charge.

If the Orchestra key is not configured, the api serves no stablecoin
amounts. Lightning stays as it is.

## Paid

Paid means the quoted sats are on the shop's stored Spark address. The api
records that when Orchestra has delivered them. Nothing else marks it paid.
Acceptance, the wallet's success response, a proof, and the page do not.

Until Orchestra has delivered those sats, too little, too much, the wrong
chain, a stale amount, or a transfer with no quote that was still valid for
it leaves the payment unpaid. A stale amount is not a different number of
sats.

The api records the result. The member's app shows that record. It shows an
ordinary incoming bitcoin payment of those sats. It does not show a USDT or
USDC balance, and it does not show the stablecoin. The app does not create
the quote, watch the swap, report the payment, or grow a new receive step.
The payment counts while the phone is off.

No zap, gift, or message is written for this payment.

## When a till charge is open

Today's till is unchanged, and it is not required for the payment above.

`POST /pos` with a sat amount of at least 1 still needs the username and a
verified receiving address. One unexpired pending charge. Five minutes.
While it is pending, the pay link pins both Lightning sendable bounds to
that amount. The callback and the metadata stay as they are. The stablecoin
amounts for that charge are added beside that pin. They do not move the
sat figure.

A lapsed quote is replaced only while the charge is still open, and only
for the same sats.

The charge is paid when the first of these is confirmed: the Spark invoice
the api handed out, a BOLT11 the api handed out, or the Orchestra delivery
of the agreed sats. The first confirmation wins. One charge is paid once.

Sats that arrive after the five minutes still pay that charge when the
transfer was accepted against a quote that was valid for it. A transfer
sent after the charge has ended, with no such quote, is not a payment of
that charge. The standing QR can still take a new amount from the next
payer.

`GET /pos` shows a paid charge for 60 seconds, and a paid charge no longer
pins the pay link. No zap, gift, or message is written for a till payment.

## What the build adds

The change that implements this does all of the following, and names every
new field in `SPEC.md` in that same change:

- Store the shop Spark address on the account. Read it for the quote. Do
  not derive it from `spark_pubkey`.
- When the key and the address are both present and the amount is known,
  fill `transferAmounts` from Orchestra's quote. Otherwise leave the pay
  link as it is today.
- Serve the callback and the proof call for an offered pair. Return the
  wallet a success only after Orchestra has accepted the matching transfer.
- Record the shop paid only when Orchestra has delivered those sats to the
  stored address. A page-entered amount that is not a till charge is still
  that same bitcoin payment. It does not create a till row.
- On the page: the amount, the methods, the expiry, and the deeplink. No QR.
- On an open till charge: Orchestra's delivery is a third way the charge
  becomes paid. The first confirmation still wins.

The member's app only shows the bitcoin payment the api recorded.

## What this does not do

- No second QR, on the page or anywhere else. The only QR is the sticker
  at the shop. It does not change per quote or per payment.
- No 404, and no wait, when the sticker has no open amount. That response
  stays today's Lightning pay request.
- No copy of another provider's pending fiat row, sell route, custody of
  the stablecoin, or asset list.
- No USDT or USDC balance for the shop or the member.
- No phone in the quote, the delivery, or the paid mark. The 12 words stay
  on the phone and are not read for this payment. The delivery address is
  not computed from the stored pubkey.
- No change to today's Lightning settlement. The pay link still resolves to
  the verified in-app wallet. A Lightning payment of the same sats does not
  go through Orchestra.
- No change to gifts or loans. A gift is still sats over the member's
  receiving address.
- No route is reserved here. The stored Spark address is required. The
  change that builds this names the column in `SPEC.md`.
