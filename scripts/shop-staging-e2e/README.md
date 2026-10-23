# Staging shop stablecoin harness

Manual check of one live shop payment on staging. It spends real stablecoin
on the chain the quote names when `SHOP_E2E_PAY=1`. It is not part of
`bun test` or Playwright, and CI does not run it.

The product behaviour and the release checks stay in
[`docs/shop-stablecoin-payment.md`](../../docs/shop-stablecoin-payment.md).
Automated coverage of the same feature uses stand-ins under
`e2e/shop-payment/` and `src/__tests__/`. This directory is the only place
for a run that talks to a live staging shop and a live chain.

## Layout

| Path        | Role                                                     |
| ----------- | -------------------------------------------------------- |
| `README.md` | How to run the harness, and what it will not do.         |
| `pay.ts`    | The only entrypoint.                                     |
| `records/`  | One file per live run. The index is `records/README.md`. |

A later run adds a file under `records/`. It does not grow `pay.ts` and it
does not grow an older record. The dev environment and production are out of
scope. Production stays off until the release checks pass.

## Environment

The staging edge rejects a client that sends no User-Agent. The script sends
`21gifts-shop-staging-e2e` unless `SHOP_E2E_USER_AGENT` is set.

| Variable              | Required     | Purpose                                                                                        |
| --------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `SHOP_USERNAME`       | yes          | Shop username, without a domain.                                                               |
| `SHOP_AMOUNT_SATS`    | yes          | Positive integer sats for `POST /pay/:username/payment`.                                       |
| `SHOP_APP_BASE`       | no           | Pay-link origin. Default `https://staging.21.gifts`.                                           |
| `SHOP_API_BASE`       | no           | Api origin. Default `https://staging-api.21.gifts`.                                            |
| `SHOP_METHOD`         | no           | Chain name on the offer. Default `Polygon`.                                                    |
| `SHOP_ASSET`          | no           | `USDT` or `USDC`. Default `USDT`.                                                              |
| `SHOP_E2E_USER_AGENT` | no           | Replaces the default User-Agent.                                                               |
| `SHOP_E2E_PAY`        | to broadcast | `1` signs and sends. Any other value stops after the detail URI.                               |
| `SHOP_EVM_RPC_URL`    | to broadcast | HTTPS JSON-RPC URL of the chain named in the detail URI.                                       |
| `EVM_PRIVATE_KEY`     | to broadcast | Hex key of the account that holds the stablecoin and the gas coin. A leading `0x` is optional. |

Do not commit the RPC URL or the key, and do not pass them on a logged
command line if the shell records history. The process prints statuses, the
payment id, the payer address, the chain id, the unit amount, and the
transaction hash. It does not print the BOLT11, the detail URI, the deposit
address, the RPC URL, or the key.

## Read the offer

This opens a real shop payment and does not send a transaction.

```sh
SHOP_USERNAME=e2e-stg-shop SHOP_AMOUNT_SATS=10000 \
  bun scripts/shop-staging-e2e/pay.ts
```

`pay=skipped` means it stopped before signing. A route-list timeout answers
503 `stablecoin_unavailable` and does not open a payment. The script retries
that response once.

## Pay

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
15 minutes. It exits with `not_paid` when that wait ends first. Settlement
can take several minutes after the receipt.

Write the result as a new file under `records/`, using the date, the chain,
and the asset. Copy the release-check table from the latest record and set
each row from that run only.
