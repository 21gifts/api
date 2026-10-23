# Recorded staging runs

Each file here is one live run of [`pay.ts`](../pay.ts) or of
[`return.py`](../return.py). The name is `YYYY-MM-DD-<chain>-<asset>.md`.
A return on a later day gets its own file, as does a second attempt that
uses a different chain or asset. Do not append a later run to an older file.

A record states what that run paid, what it left unpaid, and which release
checks it did not close. The checks themselves stay in
[`docs/shop-stablecoin-payment.md`](../../../docs/shop-stablecoin-payment.md).
A record does not contain an RPC URL, a signing key, a BOLT11, or a deposit
address.

| Date       | Record                                                                   | What settled                                                                 |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 2026-10-22 | [2026-10-22-polygon-usdt.md](./2026-10-22-polygon-usdt.md)               | One Polygon USDT transfer from an externally owned account.                  |
| 2026-10-23 | [2026-10-23-polygon-usdt-return.md](./2026-10-23-polygon-usdt-return.md) | Those 10000 sats sold back to Polygon USDT on the account that paid.        |
