# Daily payouts across the in-app wallet release

Status: **release check**. Decided 2026-10-16. Measured on production data on
2026-10-16. This document records why every member who was paid before the
release keeps being paid after it, on the in-app wallet only, and what must be
true on release day for that to hold.

## Decision

- Wallet of Satoshi is removed completely. After the release, every daily
  grant payout and every moderator stipend goes only to the member's in-app
  wallet `<username>@<host of PUBLIC_BASE_URL>`. No payout goes to a stored
  external Lightning Address.
- There is no intermediate stage. The release is one API pull request and one
  app pull request, each released `staging → develop` and then
  `develop → main`. After the `main` deploy of both, the switch is complete.
- No manual step is part of the release. Anything that has to change in data
  changes at boot (see [Roster move at boot](#roster-move-at-boot)).

## How a payout is triggered

A payout is not paid on a timer. It follows the member's own action:

| Payout            | Trigger                                                                                                                                            | Code (staging)                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Daily grant       | The member publishes a top-level forum post with a photo or video. The API pings spend with the member's receiving address.                        | `src/routes/messages.ts` (spend ping after `POST /messages`), `src/lib/spend-ping.ts` |
| Moderator stipend | A moderator sends a message in the moderator group conversation. The API pings spend with `kind: "moderator"`.                                     | `src/routes/conversations.ts`, `src/lib/spend-ping.ts`                                |
| Daily run (spend) | Spend asks `POST /spend/daily-instruction` for each roster address. The API pays only a member with a passkey, a live media post, and eligibility. | `src/routes/spend-instruction-route.ts`, `src/lib/spend-instruction.ts`               |

The amount comes from the daily roster when the address is listed there, and
from `DAILY_ROSTER_DEFAULT_AMOUNT_USD` (1 USD) for an unlisted admitted or
trial grant. Moderator stipends are paid only to listed moderator rows.

The API roster (`daily_roster`, `daily_roster_entry`) is the master copy.
Spend's `POST /funding/daily-roster/document` import writes only when the
roster has never been written; after that it returns the stored document, and
spend pays the addresses it returns. Spend's own local list (what
`gifts-debug spend` prints) is not used for payment decisions once the API
roster exists.

## What changes with the release

On staging, every payout address comes from `receivingAddress`
(`src/lib/receiving-address.ts`). It returns `<username>@<host>` only for an
account with a verified wallet (`sparkPubkeyVerifiedAt` set) and `null`
otherwise. `accountByReceivingAddress` resolves only addresses on the
`PUBLIC_BASE_URL` host. A stored Wallet of Satoshi address no longer resolves
to any account.

Posting is gated the same way. `forum.post` requires the `lightning-address`
field (`src/lib/auth/requirements.ts`), and `accountMissing`
(`src/lib/auth/account-setup.ts`) reports it missing until the wallet is
verified. A member without a verified wallet cannot post, and without a post
there is no daily payout.

The wallet is verified when the app registers it: `PUT /me/wallet` stores the
identity key, then the LNURL register call through `POST /lnurlpay/:pubkey`
succeeds and `markSparkPubkeyVerified` sets `spark_pubkey_verified_at`
(`src/routes/lnurl-server.ts`).

## Production data (2026-10-16)

Read with `gifts-debug db gift`, `gifts-debug db account`,
`gifts-debug db message`, `gifts-debug db conversation_message`,
`gifts-debug db passkey_credential`, and `gifts-debug spend --raw`. No member
data is copied into this document beyond counts.

### Who was paid

Outbound gifts from 2026-10-13 to 2026-10-15 (UTC), kinds `daily` and
`moderator`, all from source wallet `lightning.space`:

| Day        | Daily recipients | Moderator recipients |
| ---------- | ---------------- | -------------------- |
| 2026-10-13 | 57               | 6                    |
| 2026-10-14 | 57               | 6                    |
| 2026-10-15 | 55               | 6                    |

- 216 payouts: 198 daily and 18 moderator.
- 58 distinct people. Every one has an account and a username (matched by the
  local part of `account.lightning_address` against
  `gift.recipient_wos_user`).
- Roles: 51 `verified`, 6 `moderator`, 1 `founder`.

### What triggered each payout

Every one of the 216 payouts follows an action by the same person: a live
top-level media post for a daily payout, or a moderator-group message for a
stipend.

| Time from the action to the payout | Payouts |
| ---------------------------------- | ------- |
| under 2 minutes                    | 186     |
| 2 minutes to 6 hours               | 2       |
| 6 hours or more                    | 28      |

All 30 payouts more than 2 minutes after the action were paid on 2026-10-13
between 13:44 and 14:03 UTC. That was a one-off catch-up run for posts of the
same day, not the regular flow. In the regular flow, a member is paid only
after opening the app and posting.

### Wallet state

- The production `account` table has no `spark_pubkey` or
  `spark_pubkey_verified_at` column yet. No member has an in-app wallet before
  the release.
- All 58 people have a passkey (`passkey_credential`).
- 57 have `wallet_required = true`: the passkey seed already exists, so the
  app can derive the wallet without a new passkey ceremony.
- 1 has `wallet_required = false`. Find that member with the account query
  above (payees of the last three days with `wallet_required = false`).

### Daily roster

Spend's live list on 2026-10-16: 16 recipients and 6 moderators, every
address on `walletofsatoshi.com`. Amounts: recipients 9 × 3 USD, 3 × 2 USD,
2 × 2.5 USD, 2 × 1 USD; moderators 6 × 5 USD. Matched against
`account.lightning_address`: 15 recipients and all 6 moderators belong to an
account with a username; 1 recipient address belongs to no account.

## First open of the new app

The app is a web app (Next.js). `public/sw.js` handles push only and caches no
assets, and there is no native wrapper, so a reload or reopen loads the new
build. A tab left open keeps the old JavaScript until it reloads.

For a member with `wallet_required = true`:

1. The app holds the stored session back, because the recovery phrase lives
   only in tab memory, and shows the wallet login card.
2. The member taps **Log in** and confirms the passkey prompt. The login reads
   the passkey PRF output and derives the phrase. If the member signed in with
   a passkey other than the seed passkey, a second prompt appears.
3. The background wallet setup starts by itself (`WalletSync`,
   `listenForWalletSetup`). It connects the SDK, calls `PUT /me/wallet`,
   registers `<username>@<host>`, and reloads `GET /me`. It retries after 2 s,
   5 s, and 15 s. There is no backup screen in this flow.
4. Once `sparkWalletVerified` is true, the member can post, and the post's
   payout goes to the in-app wallet.

If the member taps post before step 3 has finished, the post overlay shows the
wallet requirement with a link to `/wallet`. Leaving the forum screen there
drops the draft; the member writes it again. Closing the overlay after the
setup finished and posting again works.

For the member with `wallet_required = false`, a blocking passkey renew dialog
appears. Confirming it runs the passkey seed ceremony, returns
`walletRequired: true`, and the background setup above follows.

## Roster move at boot

Without a data change, every roster row would still hold a Wallet of Satoshi
address. Pings and the daily run look rows up by the receiving address, so no
row would match: listed recipients would fall back to the 1 USD default, and
moderators would get no stipend.

`moveDailyRosterToWalletAddresses` (`src/lib/daily-roster-store.ts`) runs in
`openBootStores` right after `migrateDailyRosterSchema`, when
`resolveLnurlServerConfig` resolves:

- A row already on the host stays.
- A row whose address equals an account's legacy `lightning_address`
  (trimmed, case-insensitive) becomes `<username>@<host>`, the same string
  `receivingAddress` returns. The amount and bucket stay.
- Every other row is deleted (no account, or no username), and so is a row
  that would repeat an address already kept in the same bucket.
- A second boot changes nothing. The log line `daily_roster.wallet_move`
  carries the two counts only.

On the 2026-10-16 roster this rewrites 15 recipients and 6 moderators and
deletes 1 recipient.

## Result

After the `main` release of both pull requests, every one of the 58 people
paid from 2026-10-13 to 2026-10-15 keeps being paid without a gap, on the
in-app wallet only, when all of these hold:

1. The API release includes the roster move at boot.
2. The API and the app go live together. The new API with the old app would
   block posting for everyone, because the old app cannot create a wallet.
3. Production has `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` set for the API and
   `NEXT_PUBLIC_BREEZ_API_KEY` set for the app. Without them no wallet can be
   created or verified, and nobody can post.

The 57 members with `wallet_required = true` need one **Log in** tap and one
passkey confirmation. The one member with `wallet_required = false` confirms
the passkey renew dialog once.

## Risks

- **No PRF on the device.** The login card shows that the wallet is not
  supported on this device, and the member cannot use the signed-in app there.
  The 57 members with a seed already passed a PRF ceremony on at least one
  device.
- **Passkey renew fails** for the member with `wallet_required = false`.
  Dismissing the failed step hides the dialog, and the app has no other path
  to a wallet. That member then needs help.
- **Draft lost** when a member follows the wallet link from the post overlay
  before setup finished.
- **Open tab** on the old build until it reloads.

## Check again before release

Repeat the counts above with the same `gifts-debug` reads on release day, and
check the three settings in the production deployment configuration.
