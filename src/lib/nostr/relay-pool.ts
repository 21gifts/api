/**
 * One long-lived WebSocket per relay URL, shared by every Nostr query and
 * publish of the process.
 *
 * Opening a socket per call trips per-IP connection rate limits at a relay's
 * edge. The pool connects lazily on the first call for a URL, multiplexes REQ
 * subscriptions by subscription id and matches OK frames by event id. A
 * dropped socket fails every call still waiting on it; the next call
 * reconnects after an exponential backoff. A connection with no call for
 * `idleMs` is closed and forgotten, so relays used once do not stay open.
 */

import type { WebSocketFactory, WebSocketLike } from '@/lib/nostr/publish';

/** Tunables for {@link NostrRelayPool}. Every field has a production default. */
export interface NostrRelayPoolOptions {
  /** Socket factory. Default opens `new WebSocket(url)`. */
  createSocket?: WebSocketFactory;
  /** First reconnect delay after a drop, in milliseconds. Default 1 000. */
  backoffBaseMs?: number;
  /** Upper bound of the doubling reconnect delay, in milliseconds. Default 60 000. */
  backoffMaxMs?: number;
  /** A socket that is not open after this many milliseconds is dropped. Default 10 000. */
  connectTimeoutMs?: number;
  /** A connection with no call for this many milliseconds is closed. Default 120 000. */
  idleMs?: number;
}

/** Resolved {@link NostrRelayPoolOptions}. */
interface PoolSettings {
  createSocket: WebSocketFactory;
  backoffBaseMs: number;
  backoffMaxMs: number;
  connectTimeoutMs: number;
  idleMs: number;
}

/** One query or publish waiting on a relay connection. */
class PendingCall {
  /** Whether {@link frame} went out on the current socket. */
  sent = false;
  /** Frames received on the socket when {@link frame} went out. */
  receivedAtSend = 0;
  /** Deadline timer, armed by the connection. */
  timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param frame - Frame to send once the socket is open.
   * @param onSettle - Runs once with the outcome.
   */
  constructor(
    readonly frame: string,
    private readonly onSettle: (ok: boolean) => void,
  ) {}

  /**
   * Settle: `true` on EOSE, CLOSED or OK true; `false` otherwise. Each path
   * that settles first removes the call from the connection, so this runs once.
   *
   * @param ok - Outcome.
   */
  settle(ok: boolean): void {
    clearTimeout(this.timer);
    this.onSettle(ok);
  }
}

/**
 * Default socket factory: the runtime's global `WebSocket`.
 *
 * @param url - Relay WebSocket URL.
 * @returns A socket narrowed to {@link WebSocketLike}.
 */
function openWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Close a socket and ignore a throw from it.
 *
 * @param socket - Socket to close.
 */
function closeQuietly(socket: WebSocketLike): void {
  try {
    socket.close();
  } catch {
    // The socket is already unusable.
  }
}

/** The single shared socket to one relay URL and the calls waiting on it. */
class RelayConnection {
  private socket: WebSocketLike | undefined;
  private open = false;
  /** Drops since the last frame received from the relay. */
  private failures = 0;
  /** Earliest time (ms) the next connect may start. */
  private retryAt = 0;
  /** Frames received over the life of this connection. */
  private received = 0;
  private serial = 0;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly calls = new Set<PendingCall>();
  private readonly subscriptions = new Map<
    string,
    { call: PendingCall; onEvent: (payload: unknown) => void }
  >();
  private readonly publishes = new Map<string, Set<PendingCall>>();

  /**
   * @param url - Relay WebSocket URL.
   * @param settings - Pool settings.
   * @param onIdle - Called after the idle close so the pool forgets this connection.
   */
  constructor(
    private readonly url: string,
    private readonly settings: PoolSettings,
    private readonly onIdle: (connection: RelayConnection) => void,
  ) {}

  /**
   * Send one REQ and hand each EVENT payload for it to `onEvent`.
   *
   * @param filter - NIP-01 filter.
   * @param timeoutMs - Deadline for EOSE, counted from this call.
   * @param onEvent - Receives the raw third element of each matching EVENT frame.
   * @returns Resolves on EOSE, CLOSED, timeout, drop, or pool close; never rejects.
   */
  subscribe(
    filter: Record<string, unknown>,
    timeoutMs: number,
    onEvent: (payload: unknown) => void,
  ): Promise<void> {
    this.serial += 1;
    const subId = `q-${this.serial}`;
    return new Promise((resolve) => {
      const call = new PendingCall(JSON.stringify(['REQ', subId, filter]), () => {
        this.subscriptions.delete(subId);
        this.calls.delete(call);
        if (call.sent && this.open) {
          this.sendOrDrop(JSON.stringify(['CLOSE', subId]));
        }
        this.armIdle();
        resolve();
      });
      this.subscriptions.set(subId, { call, onEvent });
      this.start(call, timeoutMs);
    });
  }

  /**
   * Send one EVENT and wait for the OK frame with its id.
   *
   * @param event - Signed event with a string `id`.
   * @param eventId - The event's id.
   * @param timeoutMs - Deadline for OK, counted from this call.
   * @returns `true` only for `["OK", id, true]`; never rejects.
   */
  publish(event: Record<string, unknown>, eventId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiting = this.publishes.get(eventId) ?? new Set<PendingCall>();
      const call = new PendingCall(JSON.stringify(['EVENT', event]), (ok) => {
        waiting.delete(call);
        if (waiting.size === 0) {
          this.publishes.delete(eventId);
        }
        this.calls.delete(call);
        this.armIdle();
        resolve(ok);
      });
      waiting.add(call);
      this.publishes.set(eventId, waiting);
      this.start(call, timeoutMs);
    });
  }

  /** Fail every waiting call, close the socket, and stop all timers. */
  shutdown(): void {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.detach();
    if (socket !== undefined) {
      closeQuietly(socket);
    }
    this.failAll();
  }

  /**
   * Track a call: arm its deadline, connect if needed, send when open.
   *
   * @param call - New call, already registered for routing.
   * @param timeoutMs - Deadline in milliseconds.
   */
  private start(call: PendingCall, timeoutMs: number): void {
    clearTimeout(this.idleTimer);
    this.calls.add(call);
    call.timer = setTimeout(() => {
      // A socket that sent nothing since this frame went out may be half-open.
      const silent = call.sent && this.open && this.received === call.receivedAtSend;
      call.settle(false);
      if (silent) {
        this.drop(this.socket);
      }
    }, timeoutMs);
    if (this.open) {
      this.transmit(call);
      return;
    }
    this.ensureConnecting();
  }

  /** Start a connect now, or schedule it at the backoff deadline. */
  private ensureConnecting(): void {
    if (this.socket !== undefined || this.retryTimer !== undefined) {
      return;
    }
    const wait = this.retryAt - Date.now();
    if (wait > 0) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.connect();
      }, wait);
      return;
    }
    this.connect();
  }

  /** Open the socket when a call still waits for it. */
  private connect(): void {
    if (this.calls.size === 0) {
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = this.settings.createSocket(this.url);
    } catch {
      this.drop(undefined);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      this.drop(socket);
    }, this.settings.connectTimeoutMs);
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      clearTimeout(this.connectTimer);
      this.open = true;
      for (const call of [...this.calls]) {
        if (this.socket !== socket) {
          return;
        }
        if (!call.sent) {
          this.transmit(call);
        }
      }
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) {
        this.onMessage(event.data);
      }
    });
    socket.addEventListener('error', () => {
      this.drop(socket);
    });
    socket.addEventListener('close', () => {
      this.drop(socket);
    });
  }

  /**
   * Send a call's frame on the open socket.
   *
   * @param call - Call whose frame is not sent yet.
   */
  private transmit(call: PendingCall): void {
    call.sent = true;
    call.receivedAtSend = this.received;
    this.sendOrDrop(call.frame);
  }

  /**
   * Send one frame; a throwing socket is treated as dropped.
   *
   * @param frame - Text frame.
   */
  private sendOrDrop(frame: string): void {
    const socket = this.socket!;
    try {
      socket.send(frame);
    } catch {
      this.drop(socket);
    }
  }

  /**
   * Route one relay frame to the waiting subscription or publishes.
   *
   * @param data - Raw frame data.
   */
  private onMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    this.received += 1;
    this.failures = 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'string') {
      return;
    }
    const [type, key] = parsed as [unknown, string];
    if (type === 'OK') {
      for (const call of [...(this.publishes.get(key) ?? [])]) {
        call.settle(parsed[2] === true);
      }
      return;
    }
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) {
      return;
    }
    if (type === 'EVENT') {
      subscription.onEvent(parsed[2]);
    } else if (type === 'EOSE' || type === 'CLOSED') {
      subscription.call.settle(true);
    }
  }

  /**
   * Handle a lost socket: fail waiting calls and push the next connect back.
   *
   * @param socket - Socket that failed; ignored when it is not the current one.
   */
  private drop(socket: WebSocketLike | undefined): void {
    if (socket !== this.socket) {
      return;
    }
    this.detach();
    if (socket !== undefined) {
      closeQuietly(socket);
    }
    this.failures += 1;
    const delay = Math.min(
      this.settings.backoffMaxMs,
      this.settings.backoffBaseMs * 2 ** (this.failures - 1),
    );
    this.retryAt = Date.now() + delay;
    this.failAll();
  }

  /** Forget the current socket so its late events are ignored. */
  private detach(): void {
    clearTimeout(this.connectTimer);
    this.socket = undefined;
    this.open = false;
  }

  /** Settle every waiting call with failure. */
  private failAll(): void {
    for (const call of [...this.calls]) {
      call.settle(false);
    }
  }

  /** Close this connection after `idleMs` without a call. */
  private armIdle(): void {
    if (this.stopped || this.calls.size > 0) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.shutdown();
      this.onIdle(this);
    }, this.settings.idleMs);
  }
}

/**
 * Process-wide pool of relay connections, one socket per relay URL.
 *
 * Calls never reject. A query resolves after EOSE, CLOSED, its timeout, a
 * drop, or {@link close}; a publish resolves `true` only for a matching
 * `["OK", id, true]`. After {@link close}, every call fails at once.
 */
export class NostrRelayPool {
  private readonly settings: PoolSettings;
  private readonly connections = new Map<string, RelayConnection>();
  private closed = false;

  /**
   * @param options - Socket factory and timing; see {@link NostrRelayPoolOptions}.
   */
  constructor(options: NostrRelayPoolOptions = {}) {
    this.settings = {
      createSocket: options.createSocket ?? openWebSocket,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      idleMs: options.idleMs ?? 120_000,
    };
  }

  /**
   * Run one REQ on the shared connection to `url`.
   *
   * @param filter - NIP-01 filter.
   * @param url - Relay WebSocket URL.
   * @param timeoutMs - Deadline for EOSE in milliseconds.
   * @param onEvent - Receives the raw payload of each EVENT for this REQ.
   * @returns Resolves when the REQ ends; never rejects.
   */
  query(
    filter: Record<string, unknown>,
    url: string,
    timeoutMs: number,
    onEvent: (payload: unknown) => void,
  ): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    return this.connection(url).subscribe(filter, timeoutMs, onEvent);
  }

  /**
   * Send one EVENT on the shared connection to `url` and wait for its OK.
   *
   * @param event - Signed event object.
   * @param url - Relay WebSocket URL.
   * @param timeoutMs - Deadline for OK in milliseconds.
   * @returns `true` when the relay accepted the event; `false` on rejection,
   *   timeout, drop, a missing string `id`, or a closed pool.
   */
  publish(event: Record<string, unknown>, url: string, timeoutMs: number): Promise<boolean> {
    const eventId = event['id'];
    if (this.closed || typeof eventId !== 'string') {
      return Promise.resolve(false);
    }
    return this.connection(url).publish(event, eventId, timeoutMs);
  }

  /** Close every connection and fail every waiting call. Later calls fail at once. */
  close(): void {
    this.closed = true;
    for (const connection of this.connections.values()) {
      connection.shutdown();
    }
    this.connections.clear();
  }

  /**
   * The connection for `url`, created on first use.
   *
   * @param url - Relay WebSocket URL.
   * @returns Shared connection.
   */
  private connection(url: string): RelayConnection {
    const existing = this.connections.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const created = new RelayConnection(url, this.settings, (idle) => {
      if (this.connections.get(url) === idle) {
        this.connections.delete(url);
      }
    });
    this.connections.set(url, created);
    return created;
  }
}

let sharedPool: NostrRelayPool | undefined;

/**
 * The pool every default {@link NostrRelayPool} user in this process shares.
 *
 * @returns The process-wide pool, created on first call with default options.
 */
export function sharedNostrRelayPool(): NostrRelayPool {
  sharedPool ??= new NostrRelayPool();
  return sharedPool;
}
