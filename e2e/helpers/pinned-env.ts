/**
 * Optional services the default boot pins off (shared by both api boots).
 */
export const PINNED_OFF = {
  LNURL_ZAP_NSEC_HEX: '',
  SPARK_OPERATOR_URL: '',
  TEST_INVOICE_BURST_CAP: '',
  TEST_INVOICE_HOUR_CAP: '',
  DATABASE_URL: '',
  NOSTR_NSEC_KEK: '',
  RECOVERY_SHARE_KEK: '',
  NOSTR_PUBLISH: '',
  NOSTR_PUBLISH_PUBLIC: '',
  NOSTR_RELAY_URL: '',
  NOSTR_RELAY_SPACE: '',
  NOSTR_RELAY_PUBLIC: '',
  SPEND_API_TOKEN: '',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
  TRANSLATE_URL: '',
  TRANSLATE_API_KEY: '',
  OCP_MAP_BASE_URL: '',
  OCP_PLACE_INGEST_TOKEN: '',
  LOGINS_OPEN_DEFAULT: '',
  APP_BUILD_REQUIRED: '',
  RECOVERY_SHARE_REQUIRED_FROM: '',
  LNURL_WEBHOOK_SECRET: '',
  // Refused port: GET /fx/spot stays the empty result, independent of the network.
  BTC_FIAT_SPOT_URL: 'http://127.0.0.1:9/',
  DEBUG_READ_TOKEN: '',
  WEBAUTHN_RP_ID: 'localhost',
} as const;

/**
 * Default-boot overrides beyond {@link PINNED_OFF}, shared by the Playwright
 * default server and the fresh wallet-stats server.
 */
export const DEFAULT_BOOT_ENV = {
  LNURL_SERVER_URL: '',
  // The shop stablecoin payment stays off: each new route answers its default.
  ORCHESTRA_BASE_URL: '',
  ORCHESTRA_API_KEY: '',
  SHOP_EVM_RPC: '',
  SHOP_REFUND_ADDRESS: '',
} as const;
