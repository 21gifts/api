# Staging shop stablecoin payment run

Recorded 2026-10-22 against `https://staging.21.gifts` and
`https://staging-api.21.gifts`. This is one live payment of a staging shop.
It does not close the [release checks](./shop-stablecoin-payment.md#release-checks).
The repeatable script is [`scripts/shop-staging-e2e`](../scripts/shop-staging-e2e/README.md).

## Shop

| Fact | Value |
| --- | --- |
| Username | `e2e-stg-shop` |
| Lightning address | `e2e-stg-shop@staging.21.gifts` |
| Spark identity | `037eff145e8952a369be59d514e5cee94f9bcbaf3b9c7fb153394967d2f93a7828` |
| Spark address | `spark1pgssxlhlz30gj54rdxl9n4g5uh8wjnumewhnh8rlk9fnjjt86tun57pg64pmpc` |
| Balance after settlement | 10000 sats, read from that wallet after a sync |

The shop had a verified in-app wallet before the payment. The page
`GET /pay/e2e-stg-shop` answered 200 with `minSats` 1 and `maxSats` 4000000.

## What was paid

`POST /pay/e2e-stg-shop/payment` with `{ "amountSats": 10000 }` answered 200.
Payment `ff4a0bf5-49e2-4f4f-a57b-693a7f89f163` opened at
2026-10-22T15:37:14.945Z. Its five-minute window ended at
2026-10-22T15:42:14.940Z.

The pay link offered Lightning BTC, Arbitrum USDT, Arbitrum USDC, Polygon
USDT, and Polygon USDC. Ethereum was not in that offer list. The paid option
was Polygon USDT. The quote id was `b0810063-11e6-4e24-a75b-ab1592656487`.
The displayed amount was 8.346536 USDT, which is 8346536 base units of
`0xc2132d05d31c914a87c6611c10748aeb04b58e8f` on chain 137.

An externally owned account, not an ERC-4337 account, signed one EIP-1559
`transfer` of those units.

| Fact | Value |
| --- | --- |
| Payer | `0xeD159038C9E80E4badfAA8797ddDbD8b382125D6` |
| Transaction | `0x9d02a8907f66acae223fa2b979a47aca67b80aaad6007ffaac704ea76fd4c2f6` |
| Explorer | https://polygonscan.com/tx/0x9d02a8907f66acae223fa2b979a47aca67b80aaad6007ffaac704ea76fd4c2f6 |
| Receipt | status success |

`GET /lnurlp/tx/e2e-stg-shop` with that `tx`, the quote, `method=Polygon`, and
`asset=USDT` accepted the proof. Orchestra order
`ord_01a16442-dfe2-7256-be74-264044a88012` (quote
`q_01a16442-5ac3-717d-8a11-c4ab666bbc9d`) completed at
2026-10-22T15:44:50.466Z. `amountIn` was 8346536, `amountOut` was 10000 sats,
the fee was 50562 USDC, and there was no error and no refund.

`GET /lnurlp/wait/ff4a0bf5-49e2-4f4f-a57b-693a7f89f163` then returned
`status` Completed and `paymentStatus` paid.

The shop's Spark receipt is
https://sparkscan.io/tx/01a16449-4a2d-70a3-a107-483a36b5c246?network=mainnet.
Sparkscan shows a confirmed Lightning payment of 10000 sats at
2026-10-22T15:44:47.304Z. The payment hash is
`c8ea6287e95ea7752f76d5377971374dad86d4373f984c1d70c821f4e868d79a`. Sparkscan
lists the receiver as anonymous, so the address page of the Spark address
above shows no transaction for this credit. The wallet balance is the record
of the credit.

## What this run did not pay

Arbitrum USDT, Arbitrum USDC, Polygon USDC, and Lightning were offered and
were not sent. USDC was not in the paying account.

## Attempts that did not pay

A request for 1000 sats did not offer a stablecoin. Orchestra's required
USDT was more than 5 % above the sats at the fresh USD spot, so the pair
failed the check in [Offer checks](./shop-stablecoin-payment.md#offer-checks).
That response is `stablecoin_unavailable`. It does not mean the payment is
unmounted.

The first request for 10000 sats also answered 503 `stablecoin_unavailable`,
from a route-list timeout, and did not keep a payment. The retry above is the
payment that was paid. A route-list timeout does not start the 60 s no-pair
wait.

## Release checks

| Check | Result |
| --- | --- |
| 1. Tether Wallet on Android, USDT on Polygon, Arbitrum, and Ethereum, including one ERC-4337 deposit | Not run. This run is one Polygon USDT transfer from an externally owned account. |
| 2. `amountIn` equals `transaction.data` on each offered pair | Not recorded pair by pair. The paid transfer used the 8346536 units from the Polygon USDT detail URI. |
| 3. BOLT11 lifetime at least 1020 s | Not measured on this invoice. |
| 4. Late deposit and `409 quote_expired` | Not run. |
| 5. Parallel quotes for one BOLT11 | Not run. |
| 6. Two submits of one deposit | Not run. |
| 7. Rate limits at the watcher budgets | Not run. |
| 8. Production routes `/lnurlp/*` to the api | Not run. This run used staging only. |
| 9. One bundle paying two quotes | Not run. |
| 10. History by the payment's BOLT11 | Not run. |
| 11. Two quotes, two deposit addresses, submit without `sourceAddress` | Not run. |

Stablecoin rows stay off in production until these checks pass on staging.
