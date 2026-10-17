# Daily payouts across the in-app wallet release

Status: **release check**. Decided 2026-10-16. Measured on production data on
2026-10-16. This document records why every member paid from 2026-10-13 to
2026-10-15 keeps being paid after the release, on the in-app wallet only, and
what must be true on release day for that to hold.

## In short

- **Where do payouts go after the release?** Every daily grant payout and
  every moderator stipend goes only to the member's own in-app wallet
  `<username>@21.gifts`. Nothing is paid to Wallet of Satoshi any more.
- **Does anyone lose a payout?** No. All 58 people paid from 2026-10-13 to
  2026-10-15 keep being paid without a gap on every day they are eligible for
  a grant, when these five conditions hold:
  1. The API release includes the roster move at boot, so listed amounts and
     moderator stipends keep matching.
  2. The API and the app go live together.
  3. Production has `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` (API) and
     `NEXT_PUBLIC_BREEZ_API_KEY` (app) set.
  4. The API roster (`daily_roster_entry`) holds the same rows as spend's
     live list counted below, both payment switches in `daily_roster` are
     on, and its comment is not `Welcome`. All three held on 2026-10-16;
     read them again on release day (see
     [Check again before release](#check-again-before-release)).
  5. Production runs exactly the released API and app heads: in each
     repository every production deploy run has completed, and the one that
     finished last succeeded on the release merge commit (see
     [Check again before release](#check-again-before-release)).
- **What does a member do?** Open the app, tap **Log in**, confirm the
  passkey. The wallet sets itself up in a few seconds, then they post as
  before. One of the 58 members first confirms a passkey renew dialog once.
- **How does it ship?** The API change and the app change each go through the
  release pull requests `staging → develop` and `develop → main` of their
  repository, and both go live together.

The rest of this document is the evidence.

## Decision

- Wallet of Satoshi is removed completely. After the release, every daily
  grant payout and every moderator stipend goes only to the member's in-app
  wallet `<username>@<host of PUBLIC_BASE_URL>`. No payout goes to a stored
  external Lightning Address.
- There is no intermediate stage. The API change and the app change each ship
  through the release pull requests `staging → develop` and `develop → main`
  of their repository. After the `main` deploy of both, the switch is
  complete.
- No manual step is part of the release. Anything that has to change in data
  changes at boot (see [Roster move at boot](#roster-move-at-boot)).

## How a payout is triggered

A daily payout or stipend is not paid on a timer. It follows the member's own forum post or moderator-group message, a staff decision on a `pending` grant, or spend's daily run. The one-time welcome gift and an operator replay are listed too:

| Payout            | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Code (staging)                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily grant       | The member publishes a top-level forum post with a photo or video (`POST /messages`), or a top-level note that is paid through a zap (no media check on that path). The API pings spend with the member's receiving address. When staff move a `pending` grant to `trial` or `admitted`, the API pings spend for the member's newest live top-level media post of that UTC day (for a member who was still `pending` when posting, this is the first ping); a move from an active `trial` to `admitted` does not ping.                                                                                                     | `src/routes/messages.ts` (spend ping after `POST /messages`), `src/lib/nostr/zap-index.ts` (zap-paid note), `src/routes/funding.ts` (`pingTodayMedia`), `src/lib/spend-ping.ts` |
| Moderator stipend | A moderator sends a message in the moderator group conversation and has a live public top-level post on that UTC day. The API pings spend with `kind: "moderator"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `src/routes/conversations.ts` (`hasLivingRoomPostOnUtcDay`), `src/lib/spend-ping.ts`                                                                                            |
| Daily run (spend) | Spend asks `POST /spend/daily-instruction` for each roster address. The API pays only a member with a passkey, a live media post, and eligibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/routes/spend-instruction-route.ts`, `src/lib/spend-instruction.ts`                                                                                                         |
| Welcome gift      | Once per `verified` account: when it has a live top-level photo or video (including About me) and no welcome yet, the API pings spend with `kind: "welcome"` on a new top-level post, an About-me save, a verification by a moderator, at boot and every 15 minutes. A platform `Welcome` reply under one of its notes, or a welcome gift recorded under its username after its wallet was verified, counts as received. Spend pays 1 USD while `payments_enabled` is on. A daily payout on the same UTC day is then skipped (`welcome_paid`) unless the roster comment is `Welcome`; moderator stipends are not affected. | `src/lib/welcome-media.ts`, `src/routes/messages.ts`, `src/routes/me.ts`, `src/routes/trust.ts`, `src/index.ts` (`welcomeCatchUp`), `src/lib/spend-instruction.ts`              |
| Operator replay   | Not a member trigger: an operator with `DEBUG_TOKEN` books the daily ping for a live top-level media post on that post's UTC day (`POST /debug/spend-ping`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/routes/debug-payments.ts` (`pingOnDay`)                                                                                                                                    |

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

| Day        | Daily payouts | Daily people | Moderator payouts | Moderator people |
| ---------- | ------------- | ------------ | ----------------- | ---------------- |
| 2026-10-13 | 86            | 57           | 6                 | 6                |
| 2026-10-14 | 57            | 57           | 6                 | 6                |
| 2026-10-15 | 55            | 55           | 6                 | 6                |

- 216 payouts: 198 daily and 18 moderator. On 2026-10-13, 29 people received
  a second daily payout in the catch-up run described below; on the other two
  days every person received exactly one.
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
between 13:44 and 14:03 UTC (25 × 1 USD, 4 × 3 USD, 1 × 2 USD). For 29 of
them it was that person's second daily payout of the day, for 1 the only
one. That was a one-off catch-up run for posts of the
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

### Passkey rows

30 accounts in production have two `passkey_credential` rows, and none has
more (23 of them are among the 58 people paid). On the device that ran the
renew, each of these members has one passkey for 21.gifts:

- The second row comes from the passkey renew. The API side ("Add a recovery
  phrase without replacing the login passkey", api#271) reached `main` on
  2026-09-24 (release #274). The app dialog that asks members without a seed
  to renew their passkey (app#447) reached `main` on 2026-09-29 at 08:41 UTC
  (release app#455). `addSeedPasskeyCredential` inserts the new seed passkey, keeps
  the old row, and sets `wallet_required = true`. It runs at most once per
  account, because it refuses an account that already has
  `wallet_required = true`.
- 22 of the 30 second rows were created on 2026-09-29 and 2026-09-30, right
  after the app dialog went live. Two are from 2026-09-24, the rest followed
  one by one as members confirmed the dialog.
- Registration and renew use the same WebAuthn user handle, the account id
  (`userID` in `src/lib/auth/passkey.ts`). A passkey provider (iCloud
  Keychain, Google Password Manager, the device itself) that creates a passkey
  for the same RP ID and user handle replaces the one it held. In that
  provider only the new, wallet-capable passkey exists.
- The server keeps both rows and accepts a login with either
  (`getPasskeyCredential` in `src/lib/auth/passkey.ts`). The older passkey can
  still sign only where a different provider that did not run the renew still
  holds it, for example a second device that does not sync with the first.
  Signing in with it is the case in which the app asks for the seed passkey a
  second time (see [First open of the new app](#first-open-of-the-new-app)).

### Daily roster

The daily roster holds only payees with a fixed amount and the moderators. Of
the 58 people paid from 2026-10-13 to 2026-10-15, 17 are on it (15 recipient
rows and 6 moderator rows; 4 people are in both buckets). The other 41 are on
no roster: they are paid the default amount, and the wallet release itself
sends their payouts to `<username>@21.gifts`.

Spend's live list on 2026-10-16 (`gifts-debug spend --raw`): 16 recipient rows
and 6 moderator rows, every address on `walletofsatoshi.com`. The API's own rows
(`gifts-debug db daily_roster_entry`), which the roster move works on (see
[How a payout is triggered](#how-a-payout-is-triggered)), held exactly the same
22 addresses, amounts and buckets on 2026-10-16. In `daily_roster` the roster
comment is not `Welcome`, and both `payments_enabled` (daily payouts and the
welcome gift) and `moderator_payments_enabled` (moderator stipends) were
`true`; a switch that is off pays nothing on its path
(`src/lib/spend-instruction.ts`). Amounts: recipients 9 × 3 USD, 3 × 2 USD,
2 × 2.5 USD, 2 × 1 USD; moderators 6 × 5 USD. Matched against
`account.lightning_address`: 15 recipient rows and all 6 moderator rows belong
to an account with a username. 1 recipient row belongs to no account; that
address received 99 daily payouts from 2026-05-28 to 2026-09-28 and none since.

## First open of the new app

The app is a web app (Next.js). `public/sw.js` handles push only and caches no
assets, and there is no native wrapper, so a reload or reopen loads the new
build. A tab left open keeps the old JavaScript until it reloads.

For a member with `wallet_required = true`:

1. The app holds the stored session back, because the recovery phrase lives
   only in tab memory, and shows the wallet login card. This happens on every
   new open of the app, not only the first.
2. The member taps **Log in** and confirms the passkey prompt once. The login
   reads the passkey PRF output and derives the phrase. A second prompt for
   the seed passkey appears only when the member signed in with an older
   passkey that still exists in another provider the renew did not replace
   (see [Passkey rows](#passkey-rows)).
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
`openBootStores` after `migrateDbChangeSchema` and `repairGiftKind`, so
`db_change` records every DELETE and UPDATE it makes, when
`resolveLnurlServerConfig` resolves:

- A row on the host (exactly one `@`, the part after it equals the host)
  keeps its address, trimmed and lower-cased.
- A row whose address equals an account's legacy `lightning_address`
  (trimmed, case-insensitive) becomes `<username>@<host>`, the same string
  `receivingAddress` returns. The amount and bucket stay.
- Every other row is deleted (no account, or no username).
- Per bucket and target address one row stays: the one already holding that
  exact address, else a row on the host, else the oldest. The others are
  deleted, so no row is ever rewritten to an address another row holds.
- It is one SQL statement (`DAILY_ROSTER_WALLET_MOVE_SQL`), so it applies
  completely or not at all, and all its `db_change` rows share one
  transaction.
- A second boot changes nothing. The log line `daily_roster.wallet_move`
  carries the two counts only.
- Until the wallet is verified, a member may still change the username.
  With a database, `POST /me/username` writes that change and moves the
  member's roster rows from `<old>@<host>` to `<new>@<host>` in one
  transaction under the account row lock (a concurrent rename waits; a
  failure changes nothing and the request fails with 500). Without a
  database (in-memory) they are two steps: one atomic username write that
  reports the replaced username, then `renameAddress` as a second step so
  the fixed amount follows the new receiving address; if that second step
  fails, the request fails with 500 and `daily_roster.address.rename_failed`
  names the old and the new username so an operator can rename the roster row by hand.

On the roster of 2026-10-16 this rewrites 15 recipient rows and 6 moderator
rows and deletes 1 recipient row.

## Result

The release does not change who is eligible. `eligibleToday`
(`src/lib/funding.ts`) is identical on `main` and `staging`: a payout needs a
role other than `basis`, and an `admitted` grant or a `trial` grant on the
current UTC day. The grant requirement has applied since 2026-10-01
(`FUNDING_REQUIRED_FROM_UTC`). Daily payouts and moderator stipends both pass
through it. The 58 people had the roles `verified`, `moderator` and
`founder` on 2026-10-16. A member who is not eligible on a day is not paid that
day, before and after the release alike.

The welcome gift does not cut a payout for these 58. 50 of the 51 `verified`
people already have the platform `Welcome` reply, so no welcome ping is sent
for them. The one `verified` person without it has never received a welcome
gift and has no row in the API roster, so that person's daily payout is
`DAILY_ROSTER_DEFAULT_AMOUNT_USD`, 1 USD (`src/lib/daily-roster-store.ts`). The one-time 1 USD welcome replaces that day's 1 USD daily payout once the welcome is booked in the gift ledger; if the daily ping is decided before that, both are paid. Either way the person receives at least the 1 USD daily amount.
Moderators and the founder never get a welcome ping, and moderator stipends are
never skipped for a welcome.

After the `main` release of both changes, every one of the 58 people paid
from 2026-10-13 to 2026-10-15 keeps being paid without a gap on every day
they are eligible, on the in-app wallet only, when all of these hold:

1. The API release includes the roster move at boot.
2. The API and the app go live together. The new API with the old app would
   block posting for everyone, because the old app cannot create a wallet.
3. Production has `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` set for the API and
   `NEXT_PUBLIC_BREEZ_API_KEY` set for the app. Without them no wallet can be
   created or verified, and nobody can post.
4. The API roster (`daily_roster_entry`) holds the same addresses, amounts and
   buckets as spend's live list in [Daily roster](#daily-roster). Every legacy
   row then belongs to an account with a username, except the one recipient
   without an account, and the move keeps every listed amount. A row that is
   only in the API roster and belongs to no account would be deleted. Both payment switches in `daily_roster` (`payments_enabled`, `moderator_payments_enabled`) are on, and its comment is not `Welcome`, which would let a daily payout through on a welcome day and mark payments as welcome payments.
5. Production runs the released heads: in each repository every
   `deploy-prd.yaml` run has status `completed`, and the run that finished
   last, whatever its result, succeeded and is on the `main` merge commit of
   the release. The workflow pushes the movable tag `latest`
   before it waits for the deploy, so a later run that failed or was
   cancelled may already have moved `latest`, and a re-run of an older run
   keeps its creation time but pushes `latest` again.

The 57 members with `wallet_required = true` need one **Log in** tap and one
passkey confirmation, or a second one in the case described under
[Passkey rows](#passkey-rows). The one member with `wallet_required = false` confirms
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

Repeat the counts above with the same `gifts-debug` reads on release day.
Read the API roster with `gifts-debug db daily_roster_entry` and compare it
with `gifts-debug spend --raw`: same addresses, amounts and buckets, and every
non-host address equal to an account's `lightning_address` with a username,
except rows that belong to no account (on 2026-10-16 one recipient), which the
roster move deletes. Read `gifts-debug db daily_roster`: both `payments_enabled` and `moderator_payments_enabled` must be `true`, and `comment` must not be `Welcome`.
Read the grants of the 58 people with `gifts-debug db funding_grant` and their
roles with `gifts-debug db account` to know who is eligible on release day
(role not `basis`, and `admitted`, or `trial` for that UTC day).
Check the three settings in the production deployment configuration.
After both `develop → main` merges, list every production deploy of each
repository:
`gh run list -R 21gifts/api --workflow deploy-prd.yaml -L 1000 --json headSha,status,conclusion,createdAt,updatedAt`
and the same for `21gifts/app`. The list must hold every run: its length
equals `total_count` of
`gh api "repos/21gifts/api/actions/workflows/deploy-prd.yaml/runs?per_page=1"`
(on 2026-10-16: 128 runs for the api, 145 for the app). Every run must have
`status` `completed`. The run with the latest `updatedAt`, whatever its
conclusion, must have `conclusion` `success` and the release merge commit as
`headSha`. Each run pushes `latest` and then waits for the infrastructure run
titled `image-published 21gifts/api:latest <sha>` or
`image-published 21gifts/app:latest <sha>`, so that last completed run shows
which merge commit `latest` points to. A re-run keeps its creation time, which
is why the whole list is read and not only its newest rows.
