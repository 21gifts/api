# Live loan end-to-end harness

This harness runs a real-sats loan cycle with one borrower and three givers. The default API path
registers the parties, posts and funds the loan, completes every repayment, verifies the ledger,
and returns all sats. With `LOAN_E2E_UI=1`, the screen path drives the same cycle through the app
and uses the local control server to pay the invoices created by the screens.

## Prerequisites

- Python 3.10 or newer with the exact versions in `requirements.txt`
- Bun 1.3 or newer
- `psql` and `docker` on `PATH`
- Node on `PATH` for the local helpers (both paths); Node 22 or newer for the screen path

Create a dedicated environment and install the pinned Python dependencies:

```sh
python3 -m venv <venv>
<venv>/bin/pip install -r scripts/loan-e2e/requirements.txt
```

The funding wallet holds the cycle's 1000 sats. The harness moves them only among its test wallets;
after the cycle, all sats are swept back to funding and its leaves are consolidated.

## Environment

<!-- prettier-ignore -->
| Variable | Purpose |
| --- | --- |
| `LOAN_E2E_DIR` | Private working directory for wallets, state, logs, and test secrets. |
| `LOAN_E2E_BREEZ_API_KEY` | API key; alternatively store it in `<dir>/breez.key`. |
| `LOAN_E2E_PYTHON` | Python executable from the prepared environment; defaults to `python3`. |
| `LOAN_E2E_BUN` | Bun executable; defaults to `bun`. |
| `LOAN_E2E_NODE` | Node executable used by the local helpers; defaults to `node`. |
| `LOAN_E2E_FRESH` | Set to `1` to discard stale database and loan state before starting. |
| `LOAN_E2E_UI` | Set to `1` to use the screen path instead of the API path. |
| `LOAN_E2E_APP` | App directory containing the screen-path test setup. |
| `LOAN_E2E_DAYS` | Positive term that divides 20, 8, and 4; defaults to 4. |

The harness gives the loopback API `TEST_INVOICE_BURST_CAP=100` and
`TEST_INVOICE_HOUR_CAP=100000`. These test settings are honoured only when the API binds to a
loopback address and `WEBAUTHN_RP_ID=localhost`.

## Run

API path:

```sh
LOAN_E2E_DIR=<dir> \
LOAN_E2E_PYTHON=<venv>/bin/python \
bun scripts/loan-e2e/run.mjs
```

Screen path:

```sh
LOAN_E2E_DIR=<dir> \
LOAN_E2E_PYTHON=<venv>/bin/python \
LOAN_E2E_UI=1 \
LOAN_E2E_APP=<app-dir> \
bun scripts/loan-e2e/run.mjs
```

The wallet helper turns off the SDK's background leaf optimizer. That optimizer starts a swap after
every payment, and a helper process that disconnects mid-swap leaves the swapped leaves reserved for
about five minutes, during which no payment from that wallet can select them. Optimization runs only
where a command waits for it to finish. If a wallet still has reserved leaves, a payment retry or a
sweep waits for the reservation to end, within the command's own time limit (it stops starting new
work after 540 s, below the harness's 600 s limit per wallet command); after three unreadable leaf
reads in a row it stops waiting and tries anyway.

After a finished cycle the harness sweeps every party back to the funding wallet; a wallet that
still holds sats gets up to two more rounds, 30 s apart, and the cycle only passes when every wallet
ends at 0 and the funding wallet holds at least 1000 sats again. After a failed cycle, once the
wallets are set up, the same sweep runs as a best effort and logs any wallet it could not empty. In
both cases the harness then consolidates the funding wallet, removes the test database, and clears
stale session state. Wallet files remain for the next run.
