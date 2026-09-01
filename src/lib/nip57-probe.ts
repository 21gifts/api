import type { EventTemplate } from 'nostr-tools/pure';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { buildZapProbeRequest } from '@/lib/nostr/zap-request';

/** Outcome of a NIP-57 mint probe (never pays; never writes message_invoice). */
export type Nip57ProbeResult = 'ok' | 'not_zap' | 'unreachable';

/** 400 body when the address cannot mint a NIP-57 description_hash invoice. */
export const LIGHTNING_ADDRESS_NOT_ZAP =
  'This Wallet of Satoshi address cannot receive these Bitcoin payments';

/**
 * Probe whether a Lightning Address mints a NIP-57 (`description_hash`) invoice.
 *
 * Resolves LNURL-pay, builds a throwaway kind:9734 (`p` = signer pubkey),
 * requests an invoice without paying, and checks `description_hash` against
 * the signed zap request JSON.
 *
 * @param args - Address, signer pubkey, sign helper, fetch, env for relays.
 * @returns `ok`, `not_zap`, or `unreachable` (resolve/callback failure).
 */
export async function probeNip57Mint(args: {
  address: string;
  recipientPubkey: string;
  sign: (unsigned: EventTemplate) => Promise<Record<string, unknown>>;
  fetchImpl: FetchFn;
  env?: Record<string, string | undefined>;
}): Promise<Nip57ProbeResult> {
  const resolved = await resolveLnurlp({
    address: args.address,
    fetchImpl: args.fetchImpl,
  });
  if (!resolved.ok) {
    return 'unreachable';
  }
  const metadata = resolved.metadata;
  if (metadata.allowsNostr !== true || metadata.nostrPubkey === undefined) {
    return 'unreachable';
  }
  if (metadata.nostrPubkey.trim() === '') {
    return 'unreachable';
  }
  const amountMsat = Math.max(metadata.minSendable, 1000);
  if (amountMsat > metadata.maxSendable) {
    return 'unreachable';
  }
  const relays = resolveZapRelays(args.env ?? process.env);
  const unsigned = buildZapProbeRequest({
    recipientPubkey: args.recipientPubkey,
    amountMsat,
    relays,
  });
  let signed: Record<string, unknown>;
  try {
    signed = await args.sign(unsigned);
  } catch {
    return 'unreachable';
  }
  const zapRequestJson = JSON.stringify(signed);
  const zap = await requestZapInvoice({
    address: args.address,
    amountMsat,
    zapRequestJson,
    fetchImpl: args.fetchImpl,
  });
  if (!zap.ok) {
    return zap.reason === 'noZap' ? 'not_zap' : 'unreachable';
  }
  const inspected = inspectBolt11(zap.pr);
  const descriptionHash = inspected?.descriptionHash ?? null;
  if (!isNip57Invoice(descriptionHash, zapRequestJson)) {
    return 'not_zap';
  }
  return 'ok';
}
