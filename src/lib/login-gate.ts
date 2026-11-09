/**
 * Server-side login controls: the operator login switch (with allowlist and
 * platform account) and the required app build on session-creating requests.
 */

import type { Account } from '@/lib/auth/store';
import type { LoginGateStore } from '@/lib/login-gate-store';

/** Stable `code` when a session-creating request is refused because logins are closed. */
export const LOGINS_CLOSED_CODE = 'logins_closed';

/** `error` text sent with {@link LOGINS_CLOSED_CODE}. */
export const LOGINS_CLOSED_ERROR = 'Logins are paused for an update. Try again later.';

/** Stable `code` when a session-creating request carries no or another app build. */
export const APP_OUTDATED_CODE = 'app_outdated';

/** `error` text sent with {@link APP_OUTDATED_CODE}. */
export const APP_OUTDATED_ERROR = 'A new app version is ready. Reload the page.';

/** Request header the app sends its build id in. */
export const APP_BUILD_HEADER = 'x-app-build';

/** Where the current switch value comes from. */
export type LoginsOpenSource = 'stored' | 'default';

/** Current switch as the operator sees it. */
export interface LoginGateState {
  /** `true` when every account may start a session. */
  open: boolean;
  /** `stored` once the operator set the switch; `default` before that. */
  source: LoginsOpenSource;
  /** Boot default from `LOGINS_OPEN_DEFAULT`. */
  defaultOpen: boolean;
}

/**
 * Read `LOGINS_OPEN_DEFAULT`: the switch value used until the operator stores one.
 *
 * @param env - Process environment.
 * @returns `true` for unset, blank, or `open`; `false` for `closed` (trimmed, any case).
 * @throws Error when the variable is set to any other value, so a typo cannot open logins.
 */
export function resolveLoginsOpenDefault(env: Record<string, string | undefined>): boolean {
  const raw = (env['LOGINS_OPEN_DEFAULT'] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'open') {
    return true;
  }
  if (raw === 'closed') {
    return false;
  }
  throw new Error('LOGINS_OPEN_DEFAULT must be "open" or "closed"');
}

/**
 * Read `APP_BUILD_REQUIRED`: the app build id every session-creating request must carry.
 *
 * @param env - Process environment.
 * @returns The trimmed build id, or `null` when unset or blank (no build check).
 */
export function resolveRequiredAppBuild(env: Record<string, string | undefined>): string | null {
  const raw = (env['APP_BUILD_REQUIRED'] ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * Whether a request's app build passes the build check.
 *
 * @param required - Result of {@link resolveRequiredAppBuild}.
 * @param sent - Raw {@link APP_BUILD_HEADER} value, or `undefined` when absent.
 * @returns `true` when no build is required or the trimmed header equals it exactly.
 */
export function appBuildAccepted(required: string | null, sent: string | undefined): boolean {
  if (required === null) {
    return true;
  }
  return sent !== undefined && sent.trim() === required;
}

/**
 * Decides whether an account may start a session under the operator login switch.
 * Existing sessions are never checked here.
 */
export class LoginGate {
  /** Switch and allowlist persistence. */
  readonly store: LoginGateStore;
  readonly #defaultOpen: boolean;

  /**
   * @param store - Switch and allowlist persistence.
   * @param defaultOpen - Result of {@link resolveLoginsOpenDefault}.
   */
  constructor(store: LoginGateStore, defaultOpen: boolean) {
    this.store = store;
    this.#defaultOpen = defaultOpen;
  }

  /**
   * Current switch: the stored value, or the boot default when none is stored.
   *
   * @returns Open flag, its source, and the boot default.
   */
  async state(): Promise<LoginGateState> {
    const stored = await this.store.loginsOpen();
    return stored === null
      ? { open: this.#defaultOpen, source: 'default', defaultOpen: this.#defaultOpen }
      : { open: stored, source: 'stored', defaultOpen: this.#defaultOpen };
  }

  /**
   * Whether a session may be created for this account now.
   *
   * @param account - The account the session would authenticate, or `null` for
   *   an account that does not exist yet (new registration).
   * @returns `true` while open; while closed only for the platform account and
   *   allowlisted accounts (never for a new registration).
   */
  async admits(account: Pick<Account, 'id' | 'isPlatform'> | null): Promise<boolean> {
    if ((await this.state()).open) {
      return true;
    }
    if (account === null) {
      return false;
    }
    if (account.isPlatform === true) {
      return true;
    }
    return this.store.isAllowlisted(account.id);
  }
}
