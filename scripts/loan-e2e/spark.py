#!/usr/bin/env python3
"""Spark wallet helper for the live loan cycle (Python 3.10 or newer).

Reads each party's mnemonic from ``$LOAN_E2E_DIR/<role>.mnemonic`` and the
Breez API key from ``LOAN_E2E_BREEZ_API_KEY``. Never prints either secret.
Roles: funding, borrower, giver-a, giver-b, giver-c.

Commands inspect balances, create and pay invoices, consolidate fragmented
wallets, and sweep every party back to the funding wallet.
"""

import asyncio
import glob
import os
import shutil
import sqlite3
import sys
import tempfile

from breez_sdk_spark import (
    ConnectRequest,
    FeePolicy,
    GetInfoRequest,
    Network,
    PaymentRequest,
    PaymentStatus,
    PrepareSendPaymentRequest,
    ReceivePaymentMethod,
    ReceivePaymentRequest,
    Seed,
    SendPaymentRequest,
    SyncWalletRequest,
    OptimizeLeavesRequest,
    OptimizationMode,
    connect,
    default_config,
)

ROLES = ("funding", "borrower", "giver-a", "giver-b", "giver-c")


def directory() -> str:
    raw = os.environ.get("LOAN_E2E_DIR", "").strip()
    if raw == "":
        print("LOAN_E2E_DIR is required", file=sys.stderr)
        sys.exit(2)
    return os.path.expanduser(raw)


def mnemonic_path(role: str) -> str:
    return os.path.join(directory(), f"{role}.mnemonic")


def storage_path(role: str) -> str:
    return os.path.join(directory(), role)


def read_mnemonic(role: str) -> str:
    path = mnemonic_path(role)
    if not os.path.exists(path):
        if role == "funding":
            print("funding mnemonic is missing", file=sys.stderr)
            sys.exit(2)
        from mnemonic import Mnemonic

        generated = Mnemonic("english").generate(strength=128)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(generated + "\n")
        os.chmod(path, 0o600)
    with open(path, encoding="utf-8") as handle:
        secret = handle.read().strip()
    if secret == "":
        print(f"empty mnemonic for {role}", file=sys.stderr)
        sys.exit(2)
    return secret


def redact(text: str, secret: str) -> str:
    if secret and secret in text:
        text = text.replace(secret, "[redacted]")
    api_key = os.environ.get("LOAN_E2E_BREEZ_API_KEY", "").strip()
    if api_key:
        text = text.replace(api_key, "[redacted]")
    return text


def status_name(status: object) -> str:
    return getattr(status, "name", type(status).__name__)


async def open_sdk(role: str, secret: str, multiplicity: int | None = None):
    api_key = os.environ.get("LOAN_E2E_BREEZ_API_KEY", "").strip()
    if api_key == "":
        print("LOAN_E2E_BREEZ_API_KEY is required", file=sys.stderr)
        sys.exit(2)
    os.makedirs(storage_path(role), mode=0o700, exist_ok=True)
    os.chmod(storage_path(role), 0o700)
    config = default_config(network=Network.MAINNET)
    config.api_key = api_key
    # No background optimizer. It starts a swap after every change to the
    # leaf set, and this helper disconnects right after its command. A swap
    # cut off that way leaves its leaves reserved until the reservation
    # expires, and every send fails leaf selection until then. Optimization
    # runs only where a command awaits it (optimize_full, consolidate).
    config.leaf_optimization_config.auto_enabled = False
    if multiplicity is not None:
        config.leaf_optimization_config.multiplicity = multiplicity
    return await connect(
        request=ConnectRequest(
            config=config,
            seed=Seed.MNEMONIC(mnemonic=secret, passphrase=None),
            storage_dir=storage_path(role),
        )
    )


async def synced_info(sdk):
    return await sdk.get_info(request=GetInfoRequest(ensure_synced=True))


def leaf_values(role: str, reserved: bool = False) -> list[int] | None:
    """Read available leaf values from an unlocked copy of the wallet database.

    ``reserved`` selects the leaves an unfinished swap or send still holds;
    those cannot be selected for a payment until the reservation ends.
    """
    temporary = ""
    try:
        matches = glob.glob(os.path.join(storage_path(role), "mainnet", "*", "storage.sql"))
        if len(matches) != 1:
            return None
        # The copy stays next to the wallet in LOAN_E2E_DIR, readable only by
        # this user, and is removed below.
        fd, temporary = tempfile.mkstemp(
            prefix=".leaves-", suffix=".sql", dir=storage_path(role)
        )
        os.close(fd)
        shutil.copyfile(matches[0], temporary)
        os.chmod(temporary, 0o600)
        # A reservation written by an open connection may still be in the
        # write-ahead log only.
        if os.path.exists(matches[0] + "-wal"):
            shutil.copyfile(matches[0] + "-wal", temporary + "-wal")
            os.chmod(temporary + "-wal", 0o600)
        with sqlite3.connect(temporary) as database:
            rows = database.execute(
                "SELECT value FROM brz_tree_leaves WHERE status = ?"
                " AND (reservation_id IS NOT NULL) = ?",
                ('"Available"', 1 if reserved else 0),
            ).fetchall()
        return sorted((int(row[0]) for row in rows), reverse=True)
    except Exception:
        return None
    finally:
        for path in (temporary, temporary + "-wal", temporary + "-shm") if temporary else ():
            try:
                os.unlink(path)
            except OSError:
                pass


def leaf_text(role: str) -> str:
    """Free and reserved leaves for an error message."""
    free = leaf_values(role)
    held = leaf_values(role, reserved=True)
    return (
        f"leaves={'unread' if free is None else free} "
        f"reserved={'unread' if held is None else held}"
    )


# A reservation ends about five minutes after it was made. Each command
# shares one budget so it stays inside the caller's 600 s per-command limit.
PAY_RESERVATION_WAIT_S = 330
SWEEP_RESERVATION_WAIT_S = 360


async def wait_unreserved(role: str, secret: str, budget: int) -> int:
    """Wait until no leaf of this wallet is held by an unfinished swap or send.

    The wallet only drops an expired reservation while it is connected and
    refreshing, about five minutes after the reservation was made. Retrying
    a payment inside that window fails leaf selection every time.
    Returns the seconds slept, at most ``budget``; the syncs in between are
    not counted.
    """
    waited = 0
    while waited < budget:
        held = leaf_values(role, reserved=True)
        if not held:
            return waited
        print(f"waiting for reserved leaves {held} of {role}", file=sys.stderr)
        step = min(20, budget - waited)
        await asyncio.sleep(step)
        waited += step
        sdk = await open_sdk(role, secret)
        try:
            await sdk.sync_wallet(SyncWalletRequest())
        finally:
            await sdk.disconnect()
    return waited


def fee_of(prepared) -> int:
    method = prepared.payment_method
    fee = getattr(method, "fee", 0)
    return int(fee)


async def prepare(sdk, request: str, amount: int | None):
    return await sdk.prepare_send_payment(
        request=PrepareSendPaymentRequest(
            payment_request=PaymentRequest.INPUT(input=request),
            amount=amount,
            token_identifier=None,
            conversion_options=None,
            fee_policy=FeePolicy.FEES_EXCLUDED,
        )
    )


async def send_prepared(sdk, prepared) -> None:
    sent = await sdk.send_payment(
        request=SendPaymentRequest(
            prepare_response=prepared,
            options=None,
            idempotency_key=None,
        )
    )
    payment = sent.payment
    name = status_name(payment.status)
    print(f"sent amount={int(payment.amount)} fee={int(payment.fees)} status={name}")
    if payment.status != PaymentStatus.COMPLETED:
        sys.exit(3)


async def command_ensure(role: str) -> None:
    secret = read_mnemonic(role)
    sdk = await open_sdk(role, secret)
    try:
        info = await synced_info(sdk)
        received = await sdk.receive_payment(
            request=ReceivePaymentRequest(
                payment_method=ReceivePaymentMethod.SPARK_ADDRESS()
            )
        )
        address = received.payment_request
        if not str(address).startswith("spark1"):
            print("unexpected address", file=sys.stderr)
            sys.exit(3)
        print(f"role={role}")
        print(f"address={address}")
        print(f"identity={info.identity_pubkey}")
        print(f"balance_sats={int(info.balance_sats)}")
    finally:
        await sdk.disconnect()


async def command_balance(role: str) -> None:
    secret = read_mnemonic(role)
    sdk = await open_sdk(role, secret)
    try:
        reads: list[int] = []
        for read_index in range(6):
            if read_index > 0:
                await asyncio.sleep(2)
            await sdk.sync_wallet(SyncWalletRequest())
            info = await synced_info(sdk)
            reads.append(int(info.balance_sats))
            if len(reads) >= 2 and reads[-1] == reads[-2]:
                print(f"role={role}")
                print(f"balance_sats={reads[-1]}")
                return
        print(f"balance of {role} did not settle: {reads}", file=sys.stderr)
        sys.exit(3)
    finally:
        await sdk.disconnect()


async def command_invoice(role: str, amount: int) -> None:
    secret = read_mnemonic(role)
    sdk = await open_sdk(role, secret)
    try:
        received = await sdk.receive_payment(
            request=ReceivePaymentRequest(
                payment_method=ReceivePaymentMethod.SPARK_INVOICE(
                    amount=amount,
                    token_identifier=None,
                    expiry_time=None,
                    description=None,
                    sender_public_key=None,
                )
            )
        )
        print(received.payment_request)
    finally:
        await sdk.disconnect()


async def command_quote(role: str, request: str, amount: int | None) -> None:
    secret = read_mnemonic(role)
    sdk = await open_sdk(role, secret)
    try:
        prepared = await prepare(sdk, request, amount)
        print(f"quote_fee={fee_of(prepared)}")
        print(f"quote_amount={int(prepared.amount)}")
    finally:
        await sdk.disconnect()


def optimization_busy(error: BaseException) -> bool:
    return type(error).__name__ in ("OptimizationAlreadyRunning", "OptimizationCancelled")


async def optimize_full(sdk) -> str:
    """Run a full leaf optimization and wait until that run finishes.

    A payment can start the background optimizer. Sending while it holds
    the leaves fails selection, so this waits for a completed run instead
    of paying over the top of it.
    """
    for _ in range(12):
        try:
            response = await sdk.optimize_leaves(
                OptimizeLeavesRequest(mode=OptimizationMode.FULL)
            )
            rounds = getattr(response.outcome, "rounds_executed", None)
            if rounds is None:
                await asyncio.sleep(3)
                continue
            return f"done rounds={rounds}"
        except Exception as error:
            if not optimization_busy(error):
                raise
            await asyncio.sleep(3)
    raise RuntimeError("leaf optimization did not finish")


async def consolidate(role: str, secret: str) -> str:
    sdk = await open_sdk(role, secret, multiplicity=0)
    try:
        await sdk.sync_wallet(SyncWalletRequest())
        await optimize_full(sdk)
        info = await synced_info(sdk)
        balance = int(info.balance_sats)
    finally:
        await sdk.disconnect()
    leaves = leaf_values(role)
    count = "unread" if leaves is None else str(len(leaves))
    return f"consolidated role={role} balance={balance} leaves={count}"


async def command_consolidate(role: str) -> None:
    secret = read_mnemonic(role)
    print(await consolidate(role, secret))


async def command_pay(role: str, request: str, amount: int | None) -> None:
    secret = read_mnemonic(role)
    last = "not tried"
    consolidated = False
    attempts = 5
    wait_budget = PAY_RESERVATION_WAIT_S
    for attempt in range(1, attempts + 1):
        if consolidated:
            sdk = await open_sdk(role, secret, multiplicity=0)
        else:
            sdk = await open_sdk(role, secret)
        retryable = False
        try:
            await sdk.sync_wallet(SyncWalletRequest())
            status = await optimize_full(sdk)
            print(f"optimize {status}", file=sys.stderr)
            prepared = await prepare(sdk, request, amount)
            fee = fee_of(prepared)
            if fee != 0:
                print(f"refusing non-zero spark fee {fee}", file=sys.stderr)
                sys.exit(4)
            await send_prepared(sdk, prepared)
            print("status=COMPLETED", flush=True)
            return
        except SystemExit:
            raise
        except Exception as error:
            last = redact(f"{type(error).__name__}: {error}", secret)
            retryable = (
                "select leaves" in last.lower()
                or "leaf optimization did not finish" in last.lower()
            )
            if not retryable:
                print(last, file=sys.stderr)
                sys.exit(3)
            print(f"pay attempt {attempt} {last}", file=sys.stderr)
        finally:
            await sdk.disconnect()

        if retryable and not consolidated:
            consolidated = True
            try:
                print(await consolidate(role, secret), file=sys.stderr)
            except Exception as error:
                message = redact(f"{type(error).__name__}: {error}", secret)
                print(f"consolidation of {role} failed: {message}", file=sys.stderr)
        if attempt < attempts:
            await asyncio.sleep(8 * (2 ** (attempt - 1)))
            wait_budget -= await wait_unreserved(role, secret, wait_budget)

    try:
        balance: int | str = await balance_of(role, secret)
    except Exception:
        balance = "unread"
    amount_text = str(amount) if amount is not None else "the invoice amount"
    print(
        f"{role} cannot pay {amount_text} sats after {attempts} attempts: {last}; "
        f"balance={balance} {leaf_text(role)}",
        file=sys.stderr,
    )
    sys.exit(3)


async def command_optimize(role: str) -> None:
    secret = read_mnemonic(role)
    sdk = await open_sdk(role, secret)
    try:
        await sdk.sync_wallet(SyncWalletRequest())
        status = await optimize_full(sdk)
        print(f"optimized {role} {status}")
    finally:
        await sdk.disconnect()


def sweep_amounts(balance: int) -> list[int]:
    """Whole balance first, then smaller power-of-two chunks.

    A wallet that has only ever received tiny payments can fail to spend
    its whole balance at once. A smaller chunk still moves the coins.
    """
    amounts = [balance]
    chunk = 1 << (balance.bit_length() - 1)
    while chunk >= 1:
        if chunk < balance:
            amounts.append(chunk)
        chunk //= 2
    return amounts


async def send_amount(sdk, address: str, amount: int) -> bool:
    """Send one amount. False when the leaves cannot make it or the fee is not zero."""
    try:
        prepared = await prepare(sdk, address, amount)
        fee = fee_of(prepared)
        if fee != 0:
            print(f"skip amount={amount} fee={fee}", file=sys.stderr)
            return False
        await send_prepared(sdk, prepared)
        return True
    except Exception as error:
        if "select leaves" not in str(error).lower():
            raise
        print(f"skip amount={amount} select-leaves", file=sys.stderr)
        return False


async def command_sweep(role: str, address: str) -> None:
    secret = read_mnemonic(role)
    moved = 0
    wait_budget = SWEEP_RESERVATION_WAIT_S
    wait_budget -= await wait_unreserved(role, secret, wait_budget)
    sdk = await open_sdk(role, secret)
    try:
        await sdk.sync_wallet(SyncWalletRequest())
        print(f"optimize {await optimize_full(sdk)}", file=sys.stderr)
        while True:
            info = await synced_info(sdk)
            balance = int(info.balance_sats)
            if balance <= 0:
                print(f"swept amount={moved} fee=0 status=COMPLETED", flush=True)
                return
            sent = False
            for amount in sweep_amounts(balance):
                if await send_amount(sdk, address, amount):
                    moved += amount
                    sent = True
                    break
            if not sent:
                # Powers of two are not the only size the remaining leaves
                # can make. Try every integer on a new connection.
                break
    finally:
        await sdk.disconnect()

    for _ in range(8):
        seen = await balance_of(role, secret)
        if seen <= 0:
            print(f"swept amount={moved} fee=0 status=COMPLETED", flush=True)
            return
        print(f"dust balance={seen}", file=sys.stderr)
        wait_budget -= await wait_unreserved(role, secret, wait_budget)
        sent_amount = await sweep_integers(role, secret, address)
        if sent_amount < 0:
            continue
        if sent_amount == 0 and leaf_values(role, reserved=True):
            # A refused size started a swap that now holds the leaves.
            continue
        if sent_amount == 0 and seen <= 64:
            # One connection already tried every size. A fresh connection
            # per amount is only worth it for a small remainder.
            sent_amount = await sweep_one_fresh(role, secret, address, seen) or 0
            if sent_amount == 0 and leaf_values(role, reserved=True):
                continue
        if sent_amount == 0:
            print(f"sweep could not move {seen}; {leaf_text(role)}", file=sys.stderr)
            sys.exit(3)
        moved += sent_amount
    print(f"sweep could not empty {role}; {leaf_text(role)}", file=sys.stderr)
    sys.exit(3)


async def sweep_integers(role: str, secret: str, address: str) -> int:
    """Send one chunk on a single connection, trying every amount.

    Returns the sats sent, 0 when nothing could be sent, or -1 when the
    wallet was already empty.
    """
    sdk = await open_sdk(role, secret)
    try:
        await sdk.sync_wallet(SyncWalletRequest())
        info = await synced_info(sdk)
        balance = int(info.balance_sats)
        if balance <= 0:
            return -1
        for amount in range(balance, 0, -1):
            if await send_amount(sdk, address, amount):
                return amount
            if leaf_values(role, reserved=True):
                return 0
        return 0
    finally:
        await sdk.disconnect()


async def sweep_one_fresh(role: str, secret: str, address: str, seen: int) -> int | None:
    for amount in range(seen, 0, -1):
        if await send_fresh(role, secret, address, amount):
            return amount
    return None


async def balance_of(role: str, secret: str) -> int:
    sdk = await open_sdk(role, secret)
    try:
        info = await synced_info(sdk)
        return int(info.balance_sats)
    finally:
        await sdk.disconnect()


async def send_fresh(role: str, secret: str, address: str, amount: int) -> bool:
    sdk = await open_sdk(role, secret)
    try:
        await sdk.sync_wallet(SyncWalletRequest())
        return await send_amount(sdk, address, amount)
    finally:
        await sdk.disconnect()


def parse_amount(raw: str | None) -> int | None:
    if raw is None:
        return None
    if not raw.isdigit() or int(raw) < 1:
        print("amount must be a positive integer", file=sys.stderr)
        sys.exit(2)
    return int(raw)


async def main() -> None:
    argv = sys.argv[1:]
    if len(argv) < 2:
        print(
            "usage: spark.py ensure|balance|invoice|quote|pay|optimize|consolidate|sweep "
            "<role> ...",
            file=sys.stderr,
        )
        sys.exit(2)
    command, role = argv[0], argv[1]
    if role not in ROLES:
        print("unknown role", file=sys.stderr)
        sys.exit(2)
    secret = ""
    try:
        if command == "ensure":
            await command_ensure(role)
        elif command == "balance":
            await command_balance(role)
        elif command == "invoice":
            amount = parse_amount(argv[2] if len(argv) > 2 else None)
            if amount is None:
                print("invoice needs an amount", file=sys.stderr)
                sys.exit(2)
            await command_invoice(role, amount)
        elif command == "quote":
            if len(argv) < 3:
                print("quote needs a payment request", file=sys.stderr)
                sys.exit(2)
            await command_quote(role, argv[2], parse_amount(argv[3] if len(argv) > 3 else None))
        elif command == "pay":
            if len(argv) < 3:
                print("pay needs a payment request", file=sys.stderr)
                sys.exit(2)
            await command_pay(role, argv[2], parse_amount(argv[3] if len(argv) > 3 else None))
        elif command == "optimize":
            await command_optimize(role)
        elif command == "consolidate":
            await command_consolidate(role)
        elif command == "sweep":
            if len(argv) < 3 or not argv[2].startswith("spark1"):
                print("sweep needs a spark address", file=sys.stderr)
                sys.exit(2)
            await command_sweep(role, argv[2])
        else:
            print("unknown command", file=sys.stderr)
            sys.exit(2)
    except SystemExit:
        raise
    except Exception as error:
        try:
            secret = read_mnemonic(role)
        except SystemExit:
            secret = ""
        message = redact(f"{type(error).__name__}: {error}", secret)
        print(message, file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    asyncio.run(main())
