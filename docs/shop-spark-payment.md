# Shop payment in USDT and USDC

Status: **concept only**. Decided 2026-10-01. Corrected 2026-10-10: a missing
till charge is not a stop. Not implemented. No HTTP path in this document is
reserved. The change that builds this adds its routes and fields to `SPEC.md`
in that same change. Nothing here changes runtime behaviour.

The shop QR stays the OpenCryptoPay link it already is. USDT or USDC paid
through that same QR still leaves the shop with bitcoin on the shop's own
Spark wallet. The shop does not hold USDT or USDC. The member sees an
ordinary bitcoin payment. Gifts, the till, and loans stay in satoshis.

## Decision

One QR. It belongs to the shop and the cashier. It does not change for a
quote, an amount, or a payment. The string does not grow a second address,
and the window sticker does not change.

The QR is `https://<domain>/pl/?lightning=<LNURL>`. That LNURL is the shop's
existing pay link: `https://<domain>/.well-known/lnurlp/<username>`. It is
the only QR. It is printed on the sticker at the shop.

A Lightning wallet keeps paying that LNURL as today. A browser that opens the
same QR shows the payment page below. An OpenCryptoPay wallet that reads the
same link sees the same payment, including USDT and USDC, once the amount is
known.

The cashier does not have to be online, and does not have to have saved a sat
amount. The sticker, this page, and the api are enough. An open till charge
fixes the amount when one exists. It is not a prerequisite.

## The page a browser opens

Opening the QR in a normal browser loads `/pl/?lightning=<LNURL>`. That page
is the payer's path. It is not an error when no till charge is open.

The page shows the recipient. Then it shows the amount:

- An unexpired till charge fixes the amount. The page shows that amount and
  does not let the payer change it. This is the same lock the pay link already
  uses for Lightning.
- No till charge: the payer enters the amount on this page, in bitcoin or in
  the viewer's fiat, within the pay link's minimum and maximum, the same way
  the page already asks for a Lightning amount. That entry is what fixes the
  sat amount. The cashier does not enter it.

The sat amount does not move after it is fixed. The stablecoin figures are a
quote for those sats. They include the provider fee and spread. A later price
move does not change the sats.

Once the amount is known, the page shows the payment methods for those sats.
Each payable option is one chain and one asset, with its own amount. USDT on
Tron is not USDT on Ethereum, and USDC is not USDT. A transfer on the wrong
chain is not a payment. The page may group the chains of one asset under one
label. The amount that must be paid is still the amount of that chain and
that asset.

The page shows no QR. A wallet reaches this payment in one of two ways.
It scans the sticker at the shop, or the person opens this page from that
sticker and the page opens the wallet by a deeplink. Both ways use the one
link above. There is no second QR.

The page reads and shows what the api returns. It does not ask Orchestra
itself, it does not hold a key, and it does not mark the payment paid.

## What the wallet reads

A compatible wallet decodes the `lightning` parameter to the pay-link URL and
fetches it.

Before an amount is known, that response is today's Lightning pay request:
a minimum and a maximum, and no fixed stablecoin amounts. It is not an error.
The browser page above is where the payer names the amount.

Once the amount is known, the pay request for that amount includes today's
Lightning payment for those sats and one stablecoin amount per chain and
asset, as on the page. The wallet pays one of those options. Paying a
different chain, a different asset, or a different amount is not that payment.

## Quote and delivery

The api creates the quote. The cashier's phone does not. The member's phone
does not. The 12 words are not part of this loop.

The api asks Orchestra (Flashnet) for a quote for the fixed sat amount. The
quote names the shop's Spark address as the place bitcoin is delivered. That
address is the one stored for the account. The quote reads it from the
database. It does not encode an address from `spark_pubkey`.

Today the account stores `spark_pubkey` and `spark_pubkey_verified_at` only.
The change that builds this stores the Spark address on the account and names
that column in `SPEC.md`. A missing stored address is the same as a missing
Orchestra key: no stablecoin amounts, and Lightning stays as it is. The
payment does not ask the phone for the address, and it must not learn the
12 words.

The stablecoin for the named chain and asset is paid to Orchestra. 21.gifts
does not receive the stablecoin and does not hold it.

Orchestra delivers bitcoin to the shop's stored Spark address. 21.gifts does
not hold that bitcoin. This is not Orchestra paying the Lightning invoice,
and it is not a USDT or USDC address that 21.gifts keeps.

The api learns that delivery from Orchestra. It does not learn it from the
phone.

A quote expires. The page shows that expiry. When a quote lapses before it
has been accepted, the next quote is for the same sats, not for a different
sat amount. For an open till charge, the quote also ends when the charge
ends, if that is sooner. After the charge has ended, the standing QR still
takes a new payer-chosen amount. It does not keep offering the charge's
quote.

If the Orchestra key is not configured, the api serves no stablecoin amounts.
Lightning stays as it is.

## Paid

Paid means the quoted sats are on the shop's stored Spark address. The api
records that when Orchestra has delivered them. Nothing else marks it paid.

Until Orchestra has delivered those sats, too little, too much, the wrong
chain, a stale amount, or a transfer with no quote that was still valid for
it leaves the payment unpaid. A stale amount is not a different number of
sats.

Once Orchestra has accepted the transfer against a quote that was still
valid, those sats stay due. A later price move does not change the sat
amount.

The api records the result. The member's app shows that record. It shows an
ordinary incoming bitcoin payment of those sats. It does not show a USDT or
USDC balance, and it does not show the stablecoin. The app does not create
the quote, watch the swap, or report the payment. The payment counts while
the phone is off.

No zap, gift, or message is written for this payment.

## When a till charge is open

Today's till is unchanged, and it is not required for the payment above.

`POST /pos` with a sat amount of at least 1 still needs the username and a
verified receiving address. One unexpired pending charge. Five minutes.
While it is pending, the pay link pins both Lightning sendable bounds to
that amount. The callback and the metadata stay as they are.

The stablecoin quote for that charge is for those same sats. The shop's sat
figure does not move. A lapsed quote is replaced only while the charge is
still open, and only for the same sats.

The charge is paid when the first of these is confirmed: the Spark invoice
the api handed out, a BOLT11 the api handed out, or the Orchestra delivery
of the agreed sats. The first confirmation wins. One charge is paid once.

Sats that arrive after the five minutes still pay that charge when the
transfer was accepted against a quote that was valid for it. A transfer sent
after the charge has ended, with no such quote, is not a payment of that
charge. The standing QR can still take a new amount from the next payer.

`GET /pos` shows a paid charge for 60 seconds, and a paid charge no longer
pins the pay link. No zap, gift, or message is written for a till payment.

## What this does not do

- No second QR, on the page or anywhere else. The only QR is the sticker
  at the shop. It does not change per quote or per payment.
- No USDT or USDC balance for the shop or the member.
- No phone in the quote, the delivery, or the paid mark. The 12 words stay
  on the phone and are not read for this payment. The delivery address is
  not computed from the stored pubkey.
- No change to today's Lightning settlement. The pay link still resolves to
  the verified in-app wallet. A Lightning payment of the same sats does not
  go through Orchestra.
- No change to gifts or loans. A gift is still sats over the member's
  receiving address.
- No route or response field is reserved here. The stored Spark address is
  required. The change that builds this names the column in `SPEC.md`.
