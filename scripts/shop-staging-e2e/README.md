# Staging shop stablecoin harness

Manual check of one live shop payment on staging. A run with
`SHOP_E2E_PAY=1` is always a full cycle: `pay.ts` reads the shop balance,
pays the quote, and then sells those sats back to the same account through
`return.py`. It does not finish while the shop still holds them. Neither
file is part of `bun test` or Playwright, and CI does not run them.

The product behaviour and the release checks stay in
[`docs/shop-stablecoin-payment.md`](../../docs/shop-stablecoin-payment.md).
Automated coverage of the same feature uses stand-ins under
`e2e/shop-payment/` and `src/__tests__/`. This directory is the only place
for a run that talks to a live staging shop and a live chain.

## Layout

| Path        | Role                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `README.md` | How to run the harness, and what it will not do.                                                       |
| `pay.ts`    | One cycle: read the shop balance, pay, and sell the sats back.                                         |
| `return.py` | The return leg. `pay.ts` runs it. Run it alone only to finish a cycle that stopped after the transfer. |
| `records/`  | One file per live run. The index is `records/README.md`.                                               |

A later run adds a file under `records/`. It does not grow `pay.ts`,
`return.py`, or an older record. The dev environment and production are out
of scope. Production stays off until the release checks pass.

`cycle=home` is the only successful end of a paid run. The shop then holds
the sat balance it held before the payment, and the stablecoin is back on
the paying account. Orchestra's quote fee and the network fee stay spent,
so that balance is smaller than it was at the start. `pay=skipped` is not
a cycle: it does not sign and does not need the return variables.

## Environment

The staging edge rejects a client that sends no User-Agent. The script sends
`21gifts-shop-staging-e2e` unless `SHOP_E2E_USER_AGENT` is set.

| Variable              | Required     | Purpose                                                                                                                           |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SHOP_USERNAME`       | yes          | Shop username, without a domain.                                                                                                  |
| `SHOP_AMOUNT_SATS`    | yes          | Positive integer sats for `POST /pay/:username/payment`.                                                                          |
| `SHOP_APP_BASE`       | no           | Pay-link origin. Default `https://staging.21.gifts`.                                                                              |
| `SHOP_API_BASE`       | no           | Api origin. Default `https://staging-api.21.gifts`.                                                                               |
| `SHOP_METHOD`         | no           | Chain name on the offer. Default `Polygon`.                                                                                       |
| `SHOP_ASSET`          | no           | `USDT` or `USDC`. Default `USDT`.                                                                                                 |
| `SHOP_E2E_USER_AGENT` | no           | Replaces the default User-Agent.                                                                                                  |
| `SHOP_E2E_PAY`        | to broadcast | `1` pays and sells the sats back before the process can exit 0. Any other value stops after the detail URI.                       |
| `SHOP_EVM_RPC_URL`    | to broadcast | HTTPS JSON-RPC URL of the chain named in the detail URI. The return reads the payer balance through it.                           |
| `EVM_PRIVATE_KEY`     | to broadcast | Hex key of the account that holds the stablecoin and the gas coin. A leading `0x` is optional. The return pays that same account. |
| `SHOP_SPARK_MNEMONIC` | to broadcast | 12 or 24 words of the shop wallet that receives the sats.                                                                         |
| `SHOP_SPARK_STORAGE`  | to broadcast | Absolute directory, outside this repository, for that wallet's storage.                                                           |
| `BREEZ_API_KEY`       | to broadcast | Key the shop wallet uses to sync.                                                                                                 |
| `ORCHESTRA_API_KEY`   | to broadcast | Server key for the return quote.                                                                                                  |
| `SHOP_E2E_STATE`      | to broadcast | Absolute state file outside this repository, owner-only, empty or absent at the start.                                            |
| `SHOP_E2E_PYTHON`     | no           | Python that has `breez_sdk_spark` installed. Default `python3`.                                                                   |

Do not commit the RPC URL, the mnemonic, or either key, and do not pass them on a logged
command line if the shell records history. The process prints statuses, the
payment id, the payer address, the chain id, the unit amount, and the
transaction hash. It does not print the BOLT11, the detail URI, the deposit
address, the RPC URL, the mnemonic, or either key.

## Read the offer

This opens a real shop payment and does not send a transaction.

```sh
SHOP_USERNAME=e2e-stg-shop SHOP_AMOUNT_SATS=10000 \
  bun scripts/shop-staging-e2e/pay.ts
```

`pay=skipped` means it stopped before signing. A route-list timeout answers
503 `stablecoin_unavailable` and does not open a payment. The script retries
that response once.

## Pay and return

```sh
SHOP_USERNAME=e2e-stg-shop SHOP_AMOUNT_SATS=10000 \
  SHOP_E2E_PAY=1 \
  SHOP_EVM_RPC_URL="$SHOP_EVM_RPC_URL" \
  EVM_PRIVATE_KEY="$EVM_PRIVATE_KEY" \
  SHOP_SPARK_MNEMONIC="$SHOP_SPARK_MNEMONIC" \
  SHOP_SPARK_STORAGE="$SHOP_SPARK_STORAGE" \
  BREEZ_API_KEY="$BREEZ_API_KEY" \
  ORCHESTRA_API_KEY="$ORCHESTRA_API_KEY" \
  SHOP_E2E_STATE="$SHOP_E2E_STATE" \
  bun scripts/shop-staging-e2e/pay.ts
```

Before it opens a payment, the script checks the return inputs and reads
the shop's sat balance. It refuses a state file that already holds a cycle,
and a state file that is not a JSON object. A missing state file is created,
private to its owner, with a non-empty claim before any network call. An
empty JSON object is claimed the same way, through a private `.claim` file
beside it. The claim and the replacement of that claim both run while this
process holds an exclusive lock on `<state>.lock`. The kernel releases that
lock when the holder exits. A second paid run that cannot take the lock, or
that finds the claim, stops with `state_not_fresh`. The token is checked
again under that lock, and the cycle is written by renaming a flushed
temporary file in the same directory. A claim, a cycle, or a leftover
`.claim` on an empty file is refused.

It then signs an EIP-1559 ERC-20 `transfer` for the units in the detail
URI, waits for a successful receipt, submits `tx` to
`GET /lnurlp/tx/:username`, and polls `GET /lnurlp/wait/:payment` for up to
15 minutes. It exits with `not_paid` when that wait ends first. Settlement
can take several minutes after the receipt.

Once the shop is paid, the same process runs `return.py` and waits until
it prints `return=home`. The destination chain is the lower-case form of
`SHOP_METHOD`. The recipient is the address of `EVM_PRIVATE_KEY`. A
non-zero exit here is `return_failed`. Do not start `pay.ts` again for
that cycle. Run `return.py` with `SHOP_E2E_RETURN=1` and the `startSats`
value stored in the state file. Start a new state file for the next cycle.

## Return

`pay.ts` runs this leg. Run it by hand only when a paid `pay.ts` stopped
after the transfer. It reads the shop wallet with `breez_sdk_spark` and
sells `SHOP_AMOUNT_SATS` from Spark BTC into the chain and asset named by
`SHOP_CHAIN` and `SHOP_ASSET`. The recipient is `SHOP_PAYER_ADDRESS`, the
account that paid. Pass the `startSats` value from the state file. Without
`SHOP_E2E_RETURN=1` it prints `return=skipped`, or `return=home` when the
shop is already back at `SHOP_START_SATS`, and it does not ask for a quote.
With `SHOP_E2E_RETURN=1` the script takes the same `<state>.lock` before it
reads the state file or opens a network call, and it holds that lock until
it exits. A second return that cannot take the lock stops with
`state_not_fresh` and does not ask for a quote. The stored `amount` and
`startSats` must be integers equal to `SHOP_AMOUNT_SATS` and
`SHOP_START_SATS`. A boolean does not pass. The shop balance must be that
stored start or that start plus the stored amount. A stored payer balance,
when present, must be an integer too. When it is absent, the fresh read is
stored before the shop is contacted, and a later quote or payout check uses
that integer.
With the shop still at `SHOP_START_SATS`, the script stops with
`shop_not_credited` and does not open or fund a quote, unless the saved
idempotency key already has a completed Spark payment. That payment is
recorded and the order is polled. `return=home` still requires a completed
order.

The send is one Spark transfer of the whole sat amount into the quote's
deposit. A non-zero Spark fee aborts before the transfer, because the quote
asked for the full amount. An empty quote id aborts before that transfer.
The transfer is recorded only when the Spark payment is completed. The
quote's expiry is stored with the quote. A later run funds that deposit
only when the shop balance is the stored start plus the stored amount, and
only when more than `SHOP_REPLACE_BEFORE_MS` remains. That margin is the
export in `src/lib/shop-payment.ts`. A quote with that many milliseconds
left, or fewer, is not sent. When the saved idempotency key already has a
completed Spark payment, that payment is recorded and the order is polled.
When that key has a payment that is not completed, the run stops with
`send_not_completed` and does not send. When the key has no payment, the
balance is still the stored start plus the stored amount, and the quote is
no longer fundable, the script stores a new quote and a new idempotency
key before it sends. An uncertain lookup stops with `send_unconfirmed` and
does not send. The script then polls the order for
up to 15 minutes, and a transport error during that wait is retried until
the deadline. That deadline starts when the poll starts. It is the same
fifteen minutes as the paid run's wait on `GET /lnurlp/wait/:payment`, with
the same fifteen-second pause. It is not `SHOP_ORDER_WATCH_MS` and not
`SHOP_HISTORY_INTERVAL_MS`. Those clocks keep the shop reading an offer's
history until thirty minutes after `expiresAt`, and they keep those reads
at least ten seconds apart. This poll does not extend a shop offer.
It finishes with `return=home` only when the order is
completed, the shop balance is `SHOP_START_SATS` again, and the paying
account's token balance grew by the order's `amountOut`.

`SHOP_E2E_STATE` is an absolute path outside this repository. The file must
be readable only by its owner. The state file is replaced by renaming a
flushed temporary file in the same directory, and the previous contents
stay until that rename succeeds. A retry after a sent payment polls that
quote instead of opening another one. The install of `breez_sdk_spark` is
local to the machine that runs the return. CI does not install it.

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

| Variable              | Required     | Purpose                                                                                     |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `SHOP_AMOUNT_SATS`    | yes          | Sats to sell back. The shop must hold this many above `SHOP_START_SATS`.                    |
| `SHOP_PAYER_ADDRESS`  | yes          | Account that receives the stablecoin. It is the account that paid.                          |
| `SHOP_EVM_RPC_URL`    | yes          | HTTPS JSON-RPC used to read that account's token balance before and after.                  |
| `SHOP_SPARK_MNEMONIC` | yes          | 12 or 24 words of the shop wallet that received the sats.                                   |
| `SHOP_SPARK_STORAGE`  | yes          | Absolute directory, outside this repository, for that wallet's storage.                     |
| `BREEZ_API_KEY`       | yes          | Key the wallet uses to sync.                                                                |
| `SHOP_START_SATS`     | no           | Sat balance the shop held before the payment. Default `0`.                                  |
| `SHOP_CHAIN`          | no           | Orchestra destination chain. Default `polygon`.                                             |
| `SHOP_ASSET`          | no           | `USDT` or `USDC`. Default `USDT`.                                                           |
| `SHOP_TOKEN_ADDRESS`  | no           | Overrides the Polygon USDT or USDC contract used for the balance read.                      |
| `ORCHESTRA_BASE_URL`  | no           | Default `https://orchestration.flashnet.xyz`.                                               |
| `ORCHESTRA_API_KEY`   | to broadcast | Server key. Required when `SHOP_E2E_RETURN=1`.                                              |
| `SHOP_E2E_STATE`      | to broadcast | Absolute state file outside this repository, owner-only. Required when `SHOP_E2E_RETURN=1`. |
| `SHOP_E2E_RETURN`     | to broadcast | `1` quotes and sends. Any other value stops after the balance read.                         |
| `SHOP_E2E_USER_AGENT` | no           | Replaces the default User-Agent on the quote calls.                                         |

Do not commit the RPC URL, the mnemonic, the wallet storage, the state file,
or either key. The process prints statuses, amounts, the quote id, the order
id, and the transaction hashes. It does not print the mnemonic, the keys, the
RPC URL, or the deposit address.

Write the result as a new file under `records/`, using the date, the chain,
and the asset. A return is its own file. Copy the release-check table from
the latest record and set each row from that run only.
