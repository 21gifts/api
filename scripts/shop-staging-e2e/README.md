# Staging shop stablecoin payment

Manual check of one live shop payment. It is not part of `bun test` or
Playwright, and it is not run in CI. Broadcasting spends real stablecoin on
the chain the quote names. The recorded run is
[`docs/shop-stablecoin-staging-e2e.md`](../../docs/shop-stablecoin-staging-e2e.md).

The staging edge rejects a client that sends no User-Agent. The script sends
`21gifts-shop-staging-e2e` unless `SHOP_E2E_USER_AGENT` is set.

## Read the offer

This opens a real shop payment and does not send a transaction.

```sh
SHOP_USERNAME=e2e-stg-shop SHOP_AMOUNT_SATS=10000 \
  bun scripts/shop-staging-e2e/pay.ts
```

`SHOP_APP_BASE` defaults to `https://staging.21.gifts` and `SHOP_API_BASE` to
`https://staging-api.21.gifts`. `SHOP_METHOD` defaults to `Polygon` and
`SHOP_ASSET` to `USDT`. The process prints statuses, the payment id, and the
offered methods. It does not print the BOLT11, the detail URI, or a deposit
address. `pay=skipped` means it stopped before signing.

A route-list timeout answers 503 `stablecoin_unavailable` and does not open a
payment. The script retries that response once.

## Pay

Set `SHOP_E2E_PAY=1`, `SHOP_EVM_RPC_URL` to the HTTPS JSON-RPC URL of the
quoted chain, and `EVM_PRIVATE_KEY` to the hex key of the account that holds
the stablecoin and the gas coin. The key may start with `0x`. Do not commit
either value, and do not pass them on a logged command line if the shell
records history.

```sh
SHOP_USERNAME=e2e-stg-shop SHOP_AMOUNT_SATS=10000 \
  SHOP_E2E_PAY=1 \
  SHOP_EVM_RPC_URL="$SHOP_EVM_RPC_URL" \
  EVM_PRIVATE_KEY="$EVM_PRIVATE_KEY" \
  bun scripts/shop-staging-e2e/pay.ts
```

The script signs an EIP-1559 ERC-20 `transfer` for the units in the detail
URI, waits for a successful receipt, submits `tx` to
`GET /lnurlp/tx/:username`, and polls `GET /lnurlp/wait/:payment` for up to
15 minutes. It exits with `not_paid` when that wait ends first. Orchestra can
take several minutes after the receipt.
