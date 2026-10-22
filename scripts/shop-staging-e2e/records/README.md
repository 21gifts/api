# Recorded staging runs

Each file here is one live run of [`pay.ts`](../pay.ts). The name is
`YYYY-MM-DD-<chain>-<asset>.md`. A second attempt on the same day that pays
a different chain or asset gets its own file. Do not append a later run to
an older file.

A record states what that run paid, what it left unpaid, and which release
checks it did not close. The checks themselves stay in
[`docs/shop-stablecoin-payment.md`](../../../docs/shop-stablecoin-payment.md).
A record does not contain an RPC URL, a signing key, a BOLT11, or a deposit
address.

| Date       | Record                                                     | What settled                                                |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 2026-10-22 | [2026-10-22-polygon-usdt.md](./2026-10-22-polygon-usdt.md) | One Polygon USDT transfer from an externally owned account. |
