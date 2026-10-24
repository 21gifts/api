#!/usr/bin/env python3
"""Return the sats a staging shop payment left in the shop wallet.

Sells that many sats for the same stablecoin, on the same chain, to the
account that paid. Quote and network fees stay spent. Nothing is sent
unless SHOP_E2E_RETURN is 1. This file is not part of bun test or CI.

How to run it is in README.md next to this file.
"""

from __future__ import annotations

import asyncio
import errno
import fcntl
import http.client
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

RECIPIENT_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SPARK_ADDRESS = re.compile(r"^spark1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$")
DEPOSIT_ADDRESS = re.compile(r"^(spark1|sp1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$")
# Polygon contracts from docs/shop-stablecoin-payment.md. Six decimals.
POLYGON_TOKENS = {
    "USDT": "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    "USDC": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
}


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def fail(code: str) -> None:
    warn(code)
    raise SystemExit(1)


def env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed if trimmed != "" else None


def required(name: str) -> str:
    value = env(name)
    if value is None:
        fail(f"missing_{name}")
    return value


def redact(text: str) -> str:
    cleaned = text
    for name in (
        "SHOP_SPARK_MNEMONIC",
        "BREEZ_API_KEY",
        "ORCHESTRA_API_KEY",
        "EVM_PRIVATE_KEY",
        "SHOP_EVM_RPC_URL",
    ):
        value = env(name)
        if value:
            cleaned = cleaned.replace(value, "[redacted]")
    cleaned = re.sub(r"fn_[A-Za-z0-9_-]+", "[redacted]", cleaned)
    cleaned = re.sub(r"https://[^\s\"']+", "[redacted-url]", cleaned)
    cleaned = re.sub(
        r"\b(?:spark1|sp1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}\b",
        "[redacted-address]",
        cleaned,
    )
    cleaned = re.sub(
        r"\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b",
        "[redacted-invoice]",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned


def http_json(url: str, method: str, body: dict | None, headers: dict) -> tuple[int, dict | str]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw[:300]
        return error.code, parsed


def token_address(chain: str, asset: str) -> str:
    override = env("SHOP_TOKEN_ADDRESS")
    if override is not None:
        if not RECIPIENT_RE.match(override):
            fail("token_invalid")
        return override
    if chain == "polygon" and asset in POLYGON_TOKENS:
        return POLYGON_TOKENS[asset]
    fail("token_unknown")
    return ""


def read_units(rpc_url: str, token: str, holder: str) -> int:
    data = "0x70a08231" + "0" * 24 + holder[2:].lower()
    code, payload = http_json(
        rpc_url,
        "POST",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": token, "data": data}, "latest"],
        },
        {"content-type": "application/json"},
    )
    if code != 200 or not isinstance(payload, dict) or "result" not in payload:
        fail("balance_read_failed")
    return int(payload["result"], 16)


_LOCKS: list[int] = []


def acquire_cycle_lock(path: str) -> None:
    lock_path = path + ".lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.chmod(lock_path, 0o600)
        if stat.S_IMODE(os.stat(lock_path).st_mode) & 0o077:
            fail("state_not_private")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
            fail("state_not_fresh")
        raise
    except SystemExit:
        os.close(fd)
        raise
    _LOCKS.append(fd)


def load_state(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        fail("state_not_private")
    with open(path, encoding="utf-8") as handle:
        loaded = json.load(handle)
    if not isinstance(loaded, dict):
        fail("state_invalid")
    return loaded


def save_state(path: str, state: dict) -> None:
    directory = os.path.dirname(path) or "."
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{uuid.uuid4().hex}.tmp")
    payload = json.dumps(state, indent=2, sort_keys=True) + "\n"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    dirfd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)
    os.chmod(path, 0o600)


def funding_margin_ms() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    source = os.path.join(root, "src", "lib", "shop-payment.ts")
    try:
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        fail("margin_missing")
    match = re.search(r"^export const SHOP_REPLACE_BEFORE_MS = ([0-9_]+);$", text, re.M)
    if match is None:
        fail("margin_missing")
    margin = int(match.group(1).replace("_", ""))
    if margin <= 0:
        fail("margin_missing")
    return margin


def seconds_left(expires: str) -> float | None:
    try:
        expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        return None
    if expiry.tzinfo is None:
        return None
    return (expiry - datetime.now(timezone.utc)).total_seconds()


def quote_fundable(state: dict) -> bool:
    expires = state.get("expiresAt")
    if not isinstance(expires, str) or expires == "":
        return False
    left = seconds_left(expires)
    if left is None:
        return False
    return left * 1000 > funding_margin_ms()


def stored_quote(
    view: dict, idempotency: str, amount: int, start: int, units_before: int
) -> dict:
    expires = view["expiresAt"]
    if not isinstance(expires, str) or expires == "":
        fail("quote_expiry")
    return {
        "quoteId": view["quoteId"],
        "depositAddress": view["depositAddress"],
        "expiresAt": expires,
        "idempotency": idempotency,
        "amount": amount,
        "startSats": start,
        "payerUnitsBefore": units_before,
        "paymentId": None,
    }


def state_path() -> str:
    raw = required("SHOP_E2E_STATE")
    if not os.path.isabs(raw):
        fail("state_not_absolute")
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if os.path.abspath(raw).startswith(repo + os.sep):
        fail("state_inside_repo")
    return raw


def orchestra_headers(api_key: str, idempotency: str | None = None) -> dict:
    headers = {
        "authorization": "Bearer " + api_key,
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": env("SHOP_E2E_USER_AGENT") or "21gifts-shop-staging-e2e",
    }
    if idempotency is not None:
        headers["x-idempotency-key"] = idempotency
    return headers


def public_quote(quote: dict) -> dict:
    source = quote.get("source") if isinstance(quote.get("source"), dict) else {}
    destination = quote.get("destination") if isinstance(quote.get("destination"), dict) else {}
    return {
        "quoteId": quote.get("quoteId"),
        "amountIn": quote.get("amountIn"),
        "estimatedOut": quote.get("estimatedOut"),
        "feeAmount": quote.get("feeAmount"),
        "feeAsset": quote.get("feeAsset"),
        "feeBps": quote.get("feeBps"),
        "expiresAt": quote.get("expiresAt"),
        "depositAddress": quote.get("depositAddress"),
        "sourceChain": source.get("chain"),
        "sourceAsset": source.get("asset"),
        "destinationChain": destination.get("chain"),
        "destinationAsset": destination.get("asset"),
    }


def assert_quote(quote: dict, own_spark: str, amount: int, chain: str, asset: str, estimate_out: int) -> dict:
    view = public_quote(quote)
    quote_id = view["quoteId"]
    if not isinstance(quote_id, str) or quote_id == "":
        fail("quote_missing")
    if view["sourceChain"] != "spark" or view["sourceAsset"] != "BTC":
        fail("quote_source")
    if view["destinationChain"] != chain or view["destinationAsset"] != asset:
        fail("quote_destination")
    if str(view["amountIn"]) != str(amount):
        fail("quote_amount")
    estimated = int(str(view["estimatedOut"]))
    if estimated <= 0:
        fail("quote_output")
    if estimate_out > 0 and estimated * 100 < estimate_out * 95:
        fail("quote_below_estimate")
    fee_bps = view["feeBps"]
    if not isinstance(fee_bps, int) or fee_bps > 150:
        fail("quote_fee")
    deposit = str(view["depositAddress"] or "")
    if not DEPOSIT_ADDRESS.match(deposit) or deposit == own_spark:
        fail("quote_deposit")
    expires = view["expiresAt"]
    left = seconds_left(expires) if isinstance(expires, str) else None
    if left is None or left * 1000 <= funding_margin_ms():
        fail("quote_expiry")
    warn(
        f"quote={view['quoteId']} in_sats={view['amountIn']} "
        f"est_units={view['estimatedOut']} fee_units={view['feeAmount']} "
        f"fee_asset={view['feeAsset']} fee_bps={view['feeBps']}"
    )
    warn(f"deposit_prefix={deposit[:8]} deposit_len={len(deposit)}")
    return view


def estimate_out(base: str, api_key: str, amount: int, chain: str, asset: str, recipient: str) -> int:
    query = urllib.parse.urlencode(
        {
            "sourceChain": "spark",
            "sourceAsset": "BTC",
            "destinationChain": chain,
            "destinationAsset": asset,
            "amount": str(amount),
            "amountMode": "exact_in",
            "recipientAddress": recipient,
        }
    )
    code, payload = http_json(
        base + "/v1/orchestration/estimate?" + query,
        "GET",
        None,
        orchestra_headers(api_key),
    )
    if code != 200 or not isinstance(payload, dict) or "estimatedOut" not in payload:
        fail("estimate_failed")
    return int(str(payload["estimatedOut"]))


def create_quote(
    base: str,
    api_key: str,
    amount: int,
    chain: str,
    asset: str,
    recipient: str,
    own_spark: str,
    estimate: int,
) -> dict:
    code, payload = http_json(
        base + "/v1/orchestration/quote",
        "POST",
        {
            "sourceChain": "spark",
            "sourceAsset": "BTC",
            "destinationChain": chain,
            "destinationAsset": asset,
            "amount": str(amount),
            "amountMode": "exact_in",
            "recipientAddress": recipient,
            "refundAddress": own_spark,
            "tag": "shop-staging-return",
        },
        orchestra_headers(api_key, str(uuid.uuid4())),
    )
    if code != 200 or not isinstance(payload, dict) or "quoteId" not in payload:
        fail("quote_failed")
    return assert_quote(payload, own_spark, amount, chain, asset, estimate)


def order_of(payload: dict | str) -> dict | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("order"), dict):
        return payload["order"]
    if isinstance(payload.get("operation"), dict):
        return payload["operation"]
    if "status" in payload:
        return payload
    return None


def poll_order(base: str, api_key: str, quote_id: str) -> dict:
    deadline = time.time() + 15 * 60
    headers = orchestra_headers(api_key)
    while time.time() < deadline:
        try:
            code, payload = http_json(
                base + "/v1/orchestration/order?" + urllib.parse.urlencode({"quoteId": quote_id}),
                "GET",
                None,
                headers,
            )
        except (
            urllib.error.URLError,
            json.JSONDecodeError,
            TimeoutError,
            OSError,
            http.client.HTTPException,
        ) as error:
            warn("order_poll_retry=" + redact(str(error))[:120])
            time.sleep(15)
            continue
        if code != 200:
            warn(f"order_http={code} status=")
            time.sleep(15)
            continue
        current = order_of(payload)
        status = current.get("status") if isinstance(current, dict) else None
        warn(f"order_http={code} status={status or ''}")
        if isinstance(current, dict) and status in (
            "completed",
            "failed",
            "refunded",
            "expired",
            "fallback_delivered",
        ):
            return current
        time.sleep(15)
    fail("order_open")
    return {}


async def connect_shop(storage: str):
    try:
        from breez_sdk_spark import (
            ConnectRequest,
            GetInfoRequest,
            Network,
            ReceivePaymentMethod,
            ReceivePaymentRequest,
            Seed,
            connect,
            default_config,
        )
    except ImportError:
        fail("dependency_missing")
    api_key = required("BREEZ_API_KEY")
    mnemonic = required("SHOP_SPARK_MNEMONIC")
    words = mnemonic.split()
    if len(words) not in (12, 24):
        fail("mnemonic_invalid")
    os.makedirs(storage, mode=0o700, exist_ok=True)
    os.chmod(storage, 0o700)
    config = default_config(network=Network.MAINNET)
    config.api_key = api_key
    config.leaf_optimization_config.auto_enabled = False
    try:
        sdk = await connect(
            request=ConnectRequest(
                config=config,
                seed=Seed.MNEMONIC(mnemonic=mnemonic, passphrase=None),
                storage_dir=storage,
            )
        )
    except Exception as error:
        fail(redact(str(error))[:180] or "connect_failed")
    info = await sdk.get_info(request=GetInfoRequest(ensure_synced=True))
    received = await sdk.receive_payment(
        request=ReceivePaymentRequest(payment_method=ReceivePaymentMethod.SPARK_ADDRESS())
    )
    own_spark = str(received.payment_request).strip()
    if not SPARK_ADDRESS.match(own_spark):
        await sdk.disconnect()
        fail("spark_address")
    return sdk, int(info.balance_sats), own_spark


async def send_deposit(sdk, deposit: str, amount: int, idempotency: str) -> tuple[str, int, int]:
    from breez_sdk_spark import (
        FeePolicy,
        PaymentRequest,
        PaymentStatus,
        PrepareSendPaymentRequest,
        SendPaymentRequest,
    )

    prepared = await sdk.prepare_send_payment(
        request=PrepareSendPaymentRequest(
            payment_request=PaymentRequest.INPUT(deposit),
            amount=amount,
            fee_policy=FeePolicy.FEES_INCLUDED,
        )
    )
    method = prepared.payment_method
    if not method.is_SPARK_ADDRESS():
        fail("prepared_method")
    if str(method.address) != deposit:
        fail("prepared_destination")
    if int(method.fee) != 0 or int(prepared.amount) != amount:
        fail("prepared_amount")
    warn(f"prepared_sats={int(prepared.amount)} spark_fee={int(method.fee)}")
    sent = await sdk.send_payment(
        request=SendPaymentRequest(prepare_response=prepared, idempotency_key=idempotency)
    )
    payment = sent.payment
    if payment.status != PaymentStatus.COMPLETED:
        fail("send_not_completed")
    return str(payment.id), int(payment.amount), int(payment.fees)


def _payment_absent(error: Exception) -> bool:
    return "query returned no rows" in str(error).lower()


async def find_completed_send(sdk, idempotency: str):
    from breez_sdk_spark import (
        GetPaymentRequest,
        ListPaymentsRequest,
        PaymentStatus,
        PaymentType,
    )

    payment = None
    absent = False
    try:
        response = await sdk.get_payment(request=GetPaymentRequest(payment_id=idempotency))
        payment = response.payment
    except Exception as error:
        if not _payment_absent(error):
            fail("send_unconfirmed")
        absent = True
    if payment is None:
        try:
            listed = await sdk.list_payments(
                request=ListPaymentsRequest(
                    type_filter=[PaymentType.SEND],
                    limit=50,
                    sort_ascending=False,
                )
            )
        except Exception:
            fail("send_unconfirmed")
        rows = list(listed.payments or [])
        matched = [row for row in rows if str(row.id) == idempotency]
        if len(matched) > 1 or (len(matched) == 0 and not absent and len(rows) >= 50):
            fail("send_unconfirmed")
        if len(matched) == 0:
            return None
        payment = matched[0]
    if str(payment.id) != idempotency:
        fail("send_unconfirmed")
    if payment.status != PaymentStatus.COMPLETED:
        fail("send_not_completed")
    return payment


async def main() -> None:
    chain = (env("SHOP_CHAIN") or "polygon").lower()
    asset = env("SHOP_ASSET") or "USDT"
    recipient = required("SHOP_PAYER_ADDRESS")
    if not RECIPIENT_RE.match(recipient):
        fail("payer_invalid")
    amount_text = required("SHOP_AMOUNT_SATS")
    if not re.fullmatch(r"[0-9]+", amount_text) or amount_text == "0":
        fail("amount_invalid")
    amount = int(amount_text)
    start_text = env("SHOP_START_SATS") or "0"
    if not re.fullmatch(r"[0-9]+", start_text):
        fail("start_invalid")
    start = int(start_text)
    storage = required("SHOP_SPARK_STORAGE")
    if not os.path.isabs(storage):
        fail("storage_not_absolute")
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if os.path.abspath(storage).startswith(repo + os.sep):
        fail("storage_inside_repo")
    rpc_url = required("SHOP_EVM_RPC_URL")
    token = token_address(chain, asset)
    returning = env("SHOP_E2E_RETURN") == "1"
    path = state_path() if returning else None
    state: dict = {}
    if returning:
        if not isinstance(path, str):
            fail("state_missing")
        acquire_cycle_lock(path)
        state = load_state(path)
        recorded_amount = state.get("amount")
        if type(recorded_amount) is not int:
            fail("state_invalid")
        if recorded_amount != amount:
            fail("amount_mismatch")
        recorded_start = state.get("startSats")
        if type(recorded_start) is int and recorded_start != start:
            fail("start_mismatch")
    units_before = read_units(rpc_url, token, recipient)
    warn(f"payer_units_before={units_before}")

    try:
        sdk, balance, own_spark = await connect_shop(storage)
    except SystemExit:
        raise
    except Exception as error:
        fail(redact(str(error))[:180] or "connect_failed")
    warn(f"shop_balance_sats={balance}")
    warn(f"shop_spark_prefix={own_spark[:8]}")
    try:
        if env("SHOP_E2E_RETURN") == "probe":
            warn("return=probe")
            return
        if not returning:
            if balance == start:
                warn("return=home")
            elif balance < start or balance - start != amount:
                fail("balance_mismatch")
            else:
                warn("return=skipped")
            return
        if balance != start and balance != start + amount:
            fail("balance_mismatch")

        if not isinstance(path, str):
            fail("state_missing")
        base = (env("ORCHESTRA_BASE_URL") or "https://orchestration.flashnet.xyz").rstrip("/")
        api_key = required("ORCHESTRA_API_KEY")
        if not api_key.startswith("fn_"):
            fail("orchestra_key_invalid")

        if not state.get("paymentId"):
            if state.get("depositAddress") and (
                not isinstance(state.get("idempotency"), str)
                or state.get("idempotency") == ""
                or not isinstance(state.get("quoteId"), str)
                or state.get("quoteId") == ""
            ):
                fail("state_invalid")
            if state.get("depositAddress"):
                found = await find_completed_send(sdk, str(state["idempotency"]))
                if found is not None:
                    state["paymentId"] = str(found.id)
                    state["paymentAmount"] = int(found.amount)
                    state["paymentFees"] = int(found.fees)
                    save_state(path, state)
                elif balance != start + amount:
                    fail("shop_not_credited")
                elif not quote_fundable(state):
                    kept = state.get("payerUnitsBefore")
                    baseline = kept if isinstance(kept, int) else units_before
                    estimate = estimate_out(base, api_key, amount, chain, asset, recipient)
                    warn(f"estimate_units={estimate}")
                    view = create_quote(
                        base, api_key, amount, chain, asset, recipient, own_spark, estimate
                    )
                    state = stored_quote(view, str(uuid.uuid4()), amount, start, baseline)
                    save_state(path, state)
            if not state.get("paymentId") and not state.get("depositAddress"):
                if balance != start + amount:
                    fail("shop_not_credited")
                estimate = estimate_out(base, api_key, amount, chain, asset, recipient)
                warn(f"estimate_units={estimate}")
                view = create_quote(
                    base, api_key, amount, chain, asset, recipient, own_spark, estimate
                )
                state = stored_quote(view, str(uuid.uuid4()), amount, start, units_before)
                save_state(path, state)
            if not state.get("paymentId"):
                if balance != start + amount:
                    fail("shop_not_credited")
                if not quote_fundable(state):
                    fail("quote_expiry")
                if not isinstance(state.get("quoteId"), str) or state.get("quoteId") == "":
                    fail("quote_missing")
                payment_id, paid, fees = await send_deposit(
                    sdk,
                    str(state["depositAddress"]),
                    amount,
                    str(state["idempotency"]),
                )
                state["paymentId"] = payment_id
                state["paymentAmount"] = paid
                state["paymentFees"] = fees
                save_state(path, state)
                warn(f"sent={payment_id} amount={paid} fees={fees}")

        quote_id = state.get("quoteId")
        if not isinstance(quote_id, str) or quote_id == "":
            fail("quote_missing")
        order = poll_order(base, api_key, quote_id)
        status = str(order.get("status"))
        warn(
            "order="
            + json.dumps(
                {
                    "id": order.get("id"),
                    "status": status,
                    "amountIn": order.get("amountIn"),
                    "amountOut": order.get("amountOut"),
                    "feeAmount": order.get("feeAmount"),
                    "feeAsset": order.get("feeAsset"),
                    "sourceTxHash": order.get("sourceTxHash"),
                    "destinationTxHash": order.get("destinationTxHash"),
                    "completedAt": order.get("completedAt"),
                },
                sort_keys=True,
            )
        )
        units_after = read_units(rpc_url, token, recipient)
        warn(f"payer_units_after={units_after}")
        from breez_sdk_spark import GetInfoRequest

        info = await sdk.get_info(request=GetInfoRequest(ensure_synced=True))
        warn(f"shop_balance_sats_after={int(info.balance_sats)}")
        if status != "completed":
            fail("order_" + status)
        if int(info.balance_sats) != start:
            fail("shop_not_home")
        baseline = state.get("payerUnitsBefore")
        if not isinstance(baseline, int):
            fail("state_invalid")
        raw_out = order.get("amountOut")
        text_out = "" if isinstance(raw_out, bool) or raw_out is None else str(raw_out)
        if not re.fullmatch(r"[0-9]+", text_out) or text_out == "0":
            fail("payout_mismatch")
        amount_out = int(text_out)
        if units_after != baseline + amount_out:
            fail("payout_mismatch")
        warn("return=home")
    finally:
        await sdk.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception as error:
        fail(redact(str(error))[:180] or "unexpected")
