# Staging shop stablecoin harness

Manual check of one live shop payment on staging, and of the return of
those sats to the account that paid. `pay.ts` spends real stablecoin on
the chain the quote names when `SHOP_E2E_PAY=1`. `return.py` spends the
sats that payment left in the shop when `SHOP_E2E_RETURN=1`. Neither file
is part of `bun test` or Playwright, and CI does not run them.

The product behaviour and the release checks stay in
[`docs/shop-stablecoin-payment.md`](../../docs/shop-stablecoin-payment.md).
Automated coverage of the same feature uses stand-ins under
`e2e/shop-payment/` and `src/__tests__/`. This directory is the only place
for a run that talks to a live staging shop and a live chain.

## Layout

| Path        | Role                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `README.md` | How to run the harness, and what it will not do.                          |
| `pay.ts`    | Opens one shop payment and, when asked, pays it.                          |
| `return.py` | Sells the sats that payment left back to the paying account.             |
| `records/`  | One file per live run. The index is `records/README.md`.                  |

A later run adds a file under `records/`. It does not grow `pay.ts`,
`return.py`, or an older record. The dev environment and production are out
of scope. Production stays off until the release checks pass.

A cycle is `pay.ts` with `SHOP_E2E_PAY=1`, then `return.py` with
`SHOP_E2E_RETURN=1` for the same account, chain, asset, and sat amount.
`pay.ts` prints `cycle=open` after the shop is paid. The cycle is closed
when `return.py` prints `return=home`: the shop holds the sat balance it
held before the payment (`SHOP_START_SATS`, usually 0), and the stablecoin
is back on the paying account. Orchestra's quote fee and the network fee
stay spent, so the stablecoin balance is smaller than it was at the start.

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
can take several minutes after the receipt. `cycle=open` means the sats are
in the shop and the cycle is not finished until `return.py` runs.

## Return

`return.py` reads the shop wallet with `breez_sdk_spark` and sells
`SHOP_AMOUNT_SATS` from Spark BTC into the chain and asset named by
`SHOP_CHAIN` and `SHOP_ASSET`. The recipient is `SHOP_PAYER_ADDRESS`, the
account that paid. The shop must hold `SHOP_START_SATS` plus
`SHOP_AMOUNT_SATS`. The usual start is 0. Without `SHOP_E2E_RETURN=1` it
prints `return=skipped`, or `return=home` when the shop is already back at
`SHOP_START_SATS`, and it does not ask for a quote.

The send is one Spark transfer of the whole sat amount into the quote's
deposit. A non-zero Spark fee aborts before the transfer, because the quote
asked for the full amount. The script then polls the order for up to 15
minutes. It finishes with `return=home` only when the order is completed,
the shop balance is `SHOP_START_SATS` again, and the paying account's token
balance grew by the order's `amountOut`.

`SHOP_E2E_STATE` is an absolute path outside this repository. The file must
be readable only by its owner. A retry after a sent payment polls that quote
instead of opening another one. The install of `breez_sdk_spark` is local to
the machine that runs the return. CI does not install it.

```sh
SHOP_AMOUNT_SATS=10000 \
  SHOP_START_SATS=0 \
  SHOP_PAYER_ADDRESS="$SHOP_PAYER_ADDRESS" \
  SHOP_EVM_RPC_URL="$SHOP_EVM_RPC_URL" \
  SHOP_SPARK_MNEMONIC="$SHOP_SPARK_MNEMONIC" \
  SHOP_SPARK_STORAGE="$SHOP_SPARK_STORAGE" \
  BREEZ_API_KEY="$BREEZ_API_KEY" \
  ORCHESTRA_API_KEY="$ORCHESTRA_API_KEY" \
  SHOP_E2E_STATE="$SHOP_E2E_STATE" \
  SHOP_E2E_RETURN=1 \
  python3 scripts/shop-staging-e2e/return.py
```

| Variable              | Required     | Purpose                                                                                          |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `SHOP_AMOUNT_SATS`    | yes          | Sats to sell back. The shop must hold this many above `SHOP_START_SATS`.                        |
| `SHOP_PAYER_ADDRESS`  | yes          | Account that receives the stablecoin. It is the account that paid.                               |
| `SHOP_EVM_RPC_URL`    | yes          | HTTPS JSON-RPC used to read that account's token balance before and after.                      |
| `SHOP_SPARK_MNEMONIC` | yes          | 12 or 24 words of the shop wallet that received the sats.                                       |
| `SHOP_SPARK_STORAGE`  | yes          | Absolute directory, outside this repository, for that wallet's storage.                         |
| `BREEZ_API_KEY`       | yes          | Key the wallet uses to sync.                                                                     |
| `SHOP_START_SATS`     | no           | Sat balance the shop held before the payment. Default `0`.                                      |
| `SHOP_CHAIN`          | no           | Orchestra destination chain. Default `polygon`.                                                 |
| `SHOP_ASSET`          | no           | `USDT` or `USDC`. Default `USDT`.                                                               |
| `SHOP_TOKEN_ADDRESS`  | no           | Overrides the Polygon USDT or USDC contract used for the balance read.                          |
| `ORCHESTRA_BASE_URL`  | no           | Default `https://orchestration.flashnet.xyz`.                                                   |
| `ORCHESTRA_API_KEY`   | to broadcast | Server key. Required when `SHOP_E2E_RETURN=1`.                                                  |
| `SHOP_E2E_STATE`      | to broadcast | Absolute state file outside this repository, owner-only. Required when `SHOP_E2E_RETURN=1`.     |
| `SHOP_E2E_RETURN`     | to broadcast | `1` quotes and sends. Any other value stops after the balance read.                             |
| `SHOP_E2E_USER_AGENT` | no           | Replaces the default User-Agent on the quote calls.                                             |

Do not commit the RPC URL, the mnemonic, the wallet storage, the state file,
or either key. The process prints statuses, amounts, the quote id, the order
id, and the transaction hashes. It does not print the mnemonic, the keys, the
RPC URL, or the deposit address.

Write the result as a new file under `records/`, using the date, the chain,
and the asset. A return is its own file. Copy the release-check table from
the latest record and set each row from that run only.
