/**
 * Fixed loopback ports of the `shop-payment` Playwright project
 * (`docs/shop-stablecoin-payment.md`, Implementation › Tests).
 *
 * The api listens on plain HTTP behind a TLS front, because the api only
 * accepts `https` for Orchestra and the RPC endpoints, and an LNURL-pay
 * callback must be `https` (`src/lib/lnurlp.ts`). `PUBLIC_BASE_URL` is the
 * front, so every URL the api hands to a wallet is the front's.
 */

/** TLS front that forwards to the api; `PUBLIC_BASE_URL` of the shop api. */
export const FRONT_PORT = 3410;
/** The shop api (`bun src/index.ts`, in memory). */
export const API_PORT = 3411;
/** Orchestra stand-in (TLS). */
export const ORCHESTRA_PORT = 3412;
/** EVM JSON-RPC stand-ins (TLS), one per Tether 1.11.0 rail. */
export const RPC_PORTS: Readonly<Record<1 | 137 | 42161, number>> = {
  1: 3413,
  137: 3414,
  42161: 3415,
};
/** LNURL server stand-in (the Breez LNURL server API the api calls; plain HTTP). */
export const LNURL_PORT = 3416;
/** Test control of every stand-in (`/__control/...`; plain HTTP). */
export const CONTROL_PORT = 3417;

/** Loopback host of every server. */
export const HOST = '127.0.0.1';

/** `PUBLIC_BASE_URL` of the shop api. */
export const PUBLIC_BASE_URL = `https://${HOST}:${FRONT_PORT}`;
/** Base URL of the control endpoint. */
export const CONTROL_URL = `http://${HOST}:${CONTROL_PORT}`;
/** Direct api URL (health check, debug routes). */
export const API_URL = `http://${HOST}:${API_PORT}`;

/** Server key the shop api sends to the Orchestra stand-in. */
export const ORCHESTRA_API_KEY = 'fn_e2e_shop_payment_key';
/** `SHOP_REFUND_ADDRESS` of the shop api. */
export const REFUND_ADDRESS = '0x2121212121212121212121212121212121212121';
/** Debug bearer of the shop api (same value as the default project). */
export const DEBUG_TOKEN = 'e2e-debug-token';
/** Browser origin the passkey ceremony of the fixture uses. */
export const WEBAUTHN_ORIGIN = `http://localhost:${API_PORT}`;
