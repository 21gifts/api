# Shop payment in USDT and USDC

Status: **concept only**. Decided 2026-10-01. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

The shop QR stays the OpenCryptoPay link it already is. A customer who pays
USDT or USDC through that same QR still leaves the shop with bitcoin on the
shop's own Spark wallet. The shop does not hold USDT or USDC.

## Decision

One QR. The string does not grow a second address, and the window sticker
does not change.

The QR is `https://<domain>/pl/?lightning=<LNURL>`. That LNURL is the shop's
existing pay link: `https://<domain>/.well-known/lnurlp/<username>`. Lightning
wallets keep paying it as LNURL-pay. An OpenCryptoPay wallet reads the same
link and, while a till charge is open, also sees rows for USDT and USDC.

Each row is one chain and one asset. USDT on Tron is not USDT on Ethereum,
and USDC is not USDT. A transfer on the wrong chain is not a payment.

The shop typed a number of sats on the till (`POST /pos`, one pending amount,
five minutes). Those sats are what must arrive. The customer's stablecoin
amount comes from a quote for that sat amount and includes the provider fee
and spread. The shop's sat figure does not move after they enter it. The
quote is shorter than the till charge. When it lapses, the customer is shown
a new stablecoin amount for the same sats. A payment at a stale amount is
not silently accepted as a different number of sats.

The customer sends the stablecoin to the swap provider, Orchestra (Flashnet).
Orchestra delivers bitcoin to the shop's Spark address. 21.gifts does not
hold the stablecoin and does not hold the bitcoin.

The till shows paid only when those sats are on the shop's Spark wallet.
The customer's wallet may report success earlier, when the stablecoin
transfer has been accepted. That is not paid.

Too little, too much, or a price move past the quote refunds the customer.
The charge stays unpaid.

Without an open till charge, this document changes nothing. Gifts over the
same Lightning address stay as they are.

## The wallet

The Spark wallet is 21.gifts' own Breez wallet. It is not Wallet of Satoshi,
and it is not a second seed.

The 12 words already exist. The phone derives them and never sends them:

1. WebAuthn PRF `eval.first`.
2. HKDF-SHA256, salt = UTF-8 `21gifts-seed-derivation`, info = UTF-8
   `mnemonic-v1`, 128 bits.
3. BIP-39 English, 12 words.

That derivation is `mnemonicFromPrfFirst` in the app. The api already records
that this seed passkey exists: `POST /auth/passkey/seed/begin` and
`POST /auth/passkey/seed/finish` set `walletRequired`. This document does
not change either of those.

The Breez SDK is not called yet. Connecting it, and receiving on Spark, are
part of building this, not part of what already runs.

The Spark address is produced on the device from those 12 words. The server
may learn the address. It must not learn the words. The quote names that
address as the place bitcoin is delivered.

## What this does not do

- No second QR and no USDT or USDC balance for the shop.
- No sticker address that accepts any amount at the rate of the moment.
  Only an open till charge has a stablecoin price, and only for the sats
  on that charge.
- No change to today's Lightning settlement. The pay link still resolves
  to Wallet of Satoshi until a later change says otherwise.
- No new phrase and no phrase stored on the server.
- No payment marked paid because the stablecoin transaction was seen.
- No route, table, or response field. Those belong to the change that
  builds this.
