#!/usr/bin/env python3
"""Spark wallet helper for the live loan cycle.

Reads each party's mnemonic from ``$LOAN_E2E_DIR/<role>.mnemonic`` and the
Breez API key from ``LOAN_E2E_BREEZ_API_KEY``. Never prints either secret.
Roles: funding, borrower, giver-a, giver-b, giver-c.
"""

import asyncio
import os
import sys

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
    OptimizationMode,
    OptimizeLeavesRequest,
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
        return text.replace(secret, "[redacted]")
    return text


def status_name(status: object) -> str:
    return getattr(status, "name", type(status).__name__)


async def open_sdk(role: str, secret: str):
    api_key = os.environ.get("LOAN_E2E_BREEZ_API_KEY", "").strip()
    if api_key == "":
        print("LOAN_E2E_BREEZ_API_KEY is required", file=sys.stderr)
        sys.exit(2)
    os.makedirs(storage_path(role), mode=0o700, exist_ok=True)
    os.chmod(storage_path(role), 0o700)
    config = default_config(network=Network.MAINNET)
    config.api_key = api_key
    return await connect(
        request=ConnectRequest(
            config=config,
            seed=Seed.MNEMONIC(mnemonic=secret, passphrase=None),
            storage_dir=storage_path(role),
        )
    )


async def synced_info(sdk):
    return await sdk.get_info(request=GetInfoRequest(ensure_synced=True))


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
        info = await synced_info(sdk)
        print(f"role={role}")
        print(f"balance_sats={int(info.balance_sats)}")
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


async def command_pay(role: str, request: str, amount: int | None) -> None:
    secret = read_mnemonic(role)
    last = "not tried"
    stagnant = 0
    for attempt in range(1, 7):
        sdk = await open_sdk(role, secret)
        try:
            await sdk.sync_wallet(SyncWalletRequest())
            status = await optimize_full(sdk)
            print(f"optimize {status}", file=sys.stderr)
            if "rounds=0" in status:
                stagnant += 1
            else:
                stagnant = 0
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
            api_key = os.environ.get("LOAN_E2E_BREEZ_API_KEY", "").strip()
            if api_key:
                last = last.replace(api_key, "[redacted]")
            retryable = (
                "select leaves" in last.lower()
                or "leaf optimization did not finish" in last.lower()
            )
            if not retryable:
                print(last, file=sys.stderr)
                sys.exit(3)
            print(f"pay attempt {attempt} {last}", file=sys.stderr)
            if stagnant >= 2 and "select leaves" in last.lower():
                print(last, file=sys.stderr)
                sys.exit(3)
        finally:
            await sdk.disconnect()
        await asyncio.sleep(8)
    print(last, file=sys.stderr)
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

    while True:
        seen = await balance_of(role, secret)
        if seen <= 0:
            print(f"swept amount={moved} fee=0 status=COMPLETED", flush=True)
            return
        print(f"dust balance={seen}", file=sys.stderr)
        sent_amount = await sweep_integers(role, secret, address)
        if sent_amount < 0:
            continue
        if sent_amount == 0 and seen <= 64:
            # One connection already tried every size. A fresh connection
            # per amount is only worth it for a small remainder.
            sent_amount = await sweep_one_fresh(role, secret, address, seen) or 0
        if sent_amount == 0:
            print(f"sweep could not move {seen}", file=sys.stderr)
            sys.exit(3)
        moved += sent_amount


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
            "usage: spark.py ensure|balance|invoice|quote|pay|optimize|sweep <role> ...",
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
        api_key = os.environ.get("LOAN_E2E_BREEZ_API_KEY", "").strip()
        if api_key:
            message = message.replace(api_key, "[redacted]")
        print(message, file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    asyncio.run(main())
