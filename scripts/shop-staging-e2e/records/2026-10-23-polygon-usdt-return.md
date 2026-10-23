# 2026-10-23 Polygon USDT return

Recorded 2026-10-23 against the shop paid on
[2026-10-22](./2026-10-22-polygon-usdt.md). This file is the return leg of
that cycle. It does not close the
[release checks](../../../docs/shop-stablecoin-payment.md#release-checks).
The harness that repeats a return is [`return.py`](../return.py). How to
invoke it is in the [harness readme](../README.md).

## Where the funds went back

The shop wallet that held the 10000 sats is the one named in the payment
record: Spark identity
`037eff145e8952a369be59d514e5cee94f9bcbaf3b9c7fb153394967d2f93a7828`,
Spark address
`spark1pgssxlhlz30gj54rdxl9n4g5uh8wjnumewhnh8rlk9fnjjt86tun57pg64pmpc`.
Before this return it held 10000 sats. After a sync it held 0 sats, which
is the balance it had before that payment.

The paying account is
`0xeD159038C9E80E4badfAA8797ddDbD8b382125D6` on Polygon. Immediately before
this return it held 1653464 base units of USDT
(`0xc2132d05d31c914a87c6611c10748aeb04b58e8f`), which is 1.653464 USDT.
Adding the 8346536 units that account paid on 2026-10-22 gives 10000000
units, 10 USDT. That is the balance the payment left from. After this
return the account held 9777762 units, 9.777762 USDT.

## The swap

10000 sats of Spark BTC were sold for Polygon USDT, exact in, to that
account. Orchestra quote `q_01a1686a-e00c-7375-98ea-a9ce13fa0db8` estimated
8120000 units out, with a fee of 10602 USDC base units (0.010602 USDC) at
13 bps. The quote expired at 2026-10-23T11:01:57.065Z.

The shop sent 10000 sats in one Spark transfer. The Spark fee was 0.
Payment `dd6da870-16b5-458d-921a-2fb0a25d9f09` completed in the wallet.
Sparkscan:
https://sparkscan.io/tx/dd6da870-16b5-458d-921a-2fb0a25d9f09?network=mainnet.

Orchestra order `ord_01a1686a-e8e2-757a-9680-d8e0bb9b11a0` completed at
2026-10-23T11:00:28.608Z. `amountIn` was 10000 sats. `amountOut` was
8124298 units, which is 8.124298 USDT. The fee was 10603 USDC base units,
which is 0.010603 USDC. There was no error and no refund.

The Polygon receipt is status success in block 96031903. The USDT
`Transfer` of 8124298 units lands on the paying account.
https://polygonscan.com/tx/0xd8473bf3b726f48f5351e8e60e8396d8ba2e65d249c6faa17bbf79dec22a74d5.

The 8346536 units paid on 2026-10-22 and the 8124298 units returned differ
by 222238 units, 0.222238 USDT. That difference is the round trip. It stays
spent. The sats are no longer in the shop.

## Release checks

| Check                                                                                                | Result                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. Tether Wallet on Android, USDT on Polygon, Arbitrum, and Ethereum, including one ERC-4337 deposit | Not run. This file is the return of the 2026-10-22 Polygon USDT payment.                  |
| 2. `amountIn` equals `transaction.data` on each offered pair                                         | Not run.                                                                                   |
| 3. BOLT11 lifetime at least 1020 s                                                                   | Not run.                                                                                   |
| 4. Late deposit and `409 quote_expired`                                                              | Not run.                                                                                   |
| 5. Parallel quotes for one BOLT11                                                                    | Not run.                                                                                   |
| 6. Two submits of one deposit                                                                        | Not run.                                                                                   |
| 7. Rate limits at the watcher budgets                                                                | Not run.                                                                                   |
| 8. Production routes `/lnurlp/*` to the api                                                          | Not run. This return used the shop wallet and Orchestra, not a production route.          |
| 9. One bundle paying two quotes                                                                      | Not run.                                                                                   |
| 10. History by the payment's BOLT11                                                                  | Not run.                                                                                   |
| 11. Two quotes, two deposit addresses, submit without `sourceAddress`                                | Not run.                                                                                   |

Stablecoin rows stay off in production until these checks pass on staging.
