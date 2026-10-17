/**
 * Shapes of the stand-ins' `/__control` endpoint, shared by the server and
 * the test fixtures.
 */

/** How Orchestra reacts to a deposit it sees on chain before any submit. */
export type DetectMode = 'none' | 'running' | 'completed';

/** Per-shop behaviour of the Orchestra stand-in (keyed by the shop's username). */
export interface ShopBehaviour {
  /**
   * `accept`: every submit of a verified deposit returns its order.
   * `fail-first`: the first submit per quote answers 503
   * `xchain_deposit_pending`; later submits (same key or not) accept.
   */
  submit: 'accept' | 'fail-first';
  /**
   * An order created by a submit completes (and pays the BOLT11) after this
   * many milliseconds; `null` keeps it `processing`.
   */
  completeAfterMs: number | null;
  /** Lifetime of a quote (`expiresAt` minus creation); Orchestra's is 2 minutes. */
  quoteTtlMs: number;
  /** Pairs whose quote answers 400 `unsupported_route`, as `<sourceChain>:<asset>`. */
  refusePairs: string[];
}

/** Body of `POST /__control/transfer`: one ERC-20 transfer through the payer's bundler. */
export interface TransferRequest {
  chainId: number;
  /** Token contract. */
  token: string;
  /** Recipient (a deposit address). */
  to: string;
  /** Amount in token units, decimal string. */
  amount: string;
  /** Payer's smart account; random when omitted. */
  from?: string;
  /** The bundler's receipt carries neither `hash` nor `transactionHash`. */
  userOpOnly?: boolean;
  /** Orchestra's own detection of this deposit. Default `none`. */
  detect?: DetectMode;
}

/** Answer of `POST /__control/transfer`. */
export interface TransferResult {
  /** Bundle transaction hash. */
  txHash: string;
  /** ERC-4337 user-operation hash. */
  userOpHash: string;
  /** What the bundler returned to the wallet after waiting for inclusion. */
  receipt: { transactionHash?: string };
  /** Order Orchestra created by detection, when any. */
  orderId: string | null;
}

/** One Orchestra order as the control endpoint reports it. */
export interface ControlOrder {
  id: string;
  quoteId: string;
  status: string;
  sourceTxHash: string;
  viaSubmit: boolean;
}

/** One Orchestra quote as the control endpoint reports it. */
export interface ControlQuote {
  quoteId: string;
  sourceChain: string;
  chainId: number;
  asset: string;
  token: string;
  depositAddress: string;
  amountIn: string;
  tag: string;
  expiresAt: string;
}

/** `GET /__control/shops/:username`. */
export interface ShopState {
  behaviour: ShopBehaviour;
  quotes: ControlQuote[];
  orders: ControlOrder[];
  submits: Array<{ quoteId: string; txHash: string; status: number }>;
  statusReads: Record<string, number>;
  historyReads: number;
  invoices: Array<{ paymentHash: string; amountMsat: number; settled: boolean }>;
  /** Receipt reads (`eth_getTransactionReceipt` and `eth_getUserOperationReceipt`) per hash. */
  receiptReads: Record<string, number>;
}
