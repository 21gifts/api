# Daily payouts across the in-app wallet release

Status: **release check**. Decided 2026-10-16. Measured on production data on
2026-10-16. This document records why every member paid from 2026-10-13 to
2026-10-15 keeps being paid after the release, on the in-app wallet only, and
what must be true on release day for that to hold.

## In short

- **Where do payouts go after the release?** Every daily grant payout and
  every moderator stipend goes only to the member's own in-app wallet
  `<username>@21.gifts`. Nothing is paid to Wallet of Satoshi any more.
- **Does anyone lose a payout?** Only a member in the grant program who has
  not set up social recovery once its start day has come (`RECOVERY_SHARE_REQUIRED_FROM`,
  unset until an operator picks the day). All 58 people paid from
  2026-10-13 to 2026-10-15 keep being paid without a gap on every day they are
  eligible for a grant, when these seven conditions hold:
  1. The API release includes the roster account link at boot, so listed
     amounts and moderator stipends keep matching.
  2. The API and the app go live together.
  3. Production has `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` (API) and
     `NEXT_PUBLIC_BREEZ_API_KEY` (app) set. Once social recovery is on
     `main`, the API also has `RECOVERY_SHARE_KEK` (64 lowercase hex,
     different from `NOSTR_NSEC_KEK`) set, or it does not boot.
  4. The API roster (`daily_roster_entry`) holds the same rows as spend's
     live list counted below, both payment switches in `daily_roster` are
     on, and its comment is not `Welcome`. All three held on 2026-10-16;
     read them again on release day (see
     [Check again before release](#check-again-before-release)).
  5. Production runs exactly the released API and app heads: in each
     repository every production deploy run has completed, and the one that
     finished last succeeded on the release merge commit (see
     [Check again before release](#check-again-before-release)).
  6. From the UTC day `RECOVERY_SHARE_REQUIRED_FROM` (unset or blank: not yet), with
     social recovery ([docs/social-recovery.md](social-recovery.md)) on `main`:
     the member has stored the 21.gifts recovery share of their current verified
     wallet. From that day a member in the grant program without it is not paid
     until they set up social recovery (see [Result](#result)).
  7. From deployment of the Spark viewer change, the member's own wallet has
     at least one completed server-verified payment to a live 21.gifts shop on
     the payout UTC day or the day before. There is no start-date setting for
     this condition. It applies to daily grants and moderator stipends, not to
     the one-time welcome gift.
- **What does a member do?** Open the app, tap **Log in**, confirm the
  passkey. The wallet sets itself up in a few seconds, then they post as
  before. One of the 58 members first confirms a passkey renew dialog once.
  From the start day `RECOVERY_SHARE_REQUIRED_FROM`, a member in the grant program also needs
  social recovery set up once (**Mein Konto absichern**) to be paid.
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
- No manual data step is part of the release. Anything that has to change in
  data changes at boot (see
  [Roster account link at boot](#roster-account-link-at-boot)).
- Two manual steps are part of the release. The first is a setting: when
  social recovery reaches `main` in this release, an operator sets
  `RECOVERY_SHARE_KEK` in production before the `develop → main` merge,
  because the API with social recovery does not boot without it.
- The second is the welcome sweep. Every boot starts it off, so after the
  deploy, and again after every restart, an operator reads
  `GET /debug/welcome-sweep` (a dry-run: `wouldPing` lists the accounts the
  sweep would ping, nobody is pinged) and turns the sweep on with
  `PUT /debug/welcome-sweep` and body `{"enabled":true}` only when that list
  holds no account that was welcomed before (see
  [Check again before release](#check-again-before-release)).
- The start day of the recovery share is a setting, not a release step:
  `RECOVERY_SHARE_REQUIRED_FROM` stays unset at the release, so payouts continue while
  members set up social recovery. An operator sets the day in production's
  environment when it is decided and restarts the API; no code changes. A
  value that is not an ISO date stops the boot. See
  [The recovery share period](#the-recovery-share-period).

## How a payout is triggered

A daily payout or stipend is not paid on a timer. It follows the member's own forum post or moderator-group message, a staff decision on a `pending` grant, or spend's daily run. The one-time welcome gift and an operator replay are listed too:

| Payout            | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Code (staging)                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily grant       | The member publishes a top-level forum post with a photo or video (`POST /messages`), or a top-level note that is paid through a zap (no media check on that path). The API pings spend with the member's receiving address only after the recent verified shop-payment condition is met. When staff move a `pending` grant to `trial` or `admitted`, the API pings spend for the member's newest live top-level media post of that UTC day (for a member who was still `pending` when posting, this is the first ping); a move from an active `trial` to `admitted` does not ping. The first recovery share of the current wallet (`PUT /me/recovery-share`) sends the same ping. If the member posts before paying a shop, the viewer worker sends the catch-up ping when it first stores today's completed shop payment.                                   | `src/routes/messages.ts` (spend ping after `POST /messages`), `src/lib/nostr/zap-index.ts` (zap-paid note), `src/routes/funding.ts` (trial and admit ping), `src/routes/me.ts` (first recovery share), `src/lib/wallet-transfer-worker.ts` (shop-payment catch-up), `src/lib/funding-ping.ts` (`pingTodayMedia`), `src/lib/spend-ping.ts` |
| Moderator stipend | A moderator sends a message in the moderator group conversation and has a live public top-level post on that UTC day. The API pings spend with `kind: "moderator"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/routes/conversations.ts` (`hasLivingRoomPostOnUtcDay`), `src/lib/spend-ping.ts`                                                                                                                                                                                                                                                      |
| Daily run (spend) | Spend asks `POST /spend/daily-instruction` for each roster row's payout address. The API pays only a member with a passkey, a live media post, and eligibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/routes/spend-instruction-route.ts`, `src/lib/spend-instruction.ts`                                                                                                                                                                                                                                                                   |
| Welcome gift      | Once per `verified` account: when it has a live top-level photo or video (including About me) and no welcome yet, the API pings spend with `kind: "welcome"` on a new top-level post, an About-me save, a verification by a moderator, and, every 15 minutes while an operator has turned the welcome sweep on (`PUT /debug/welcome-sweep`; it starts off on every boot, so the run at boot pings nobody). A platform `Welcome` reply under one of its notes, a welcome gift paid to its legacy external address, or a welcome gift with description `21gifts welcome` recorded under its username at or after its wallet verification, counts as received. Spend pays 1 USD while `payments_enabled` is on. A daily payout on the same UTC day is then skipped (`welcome_paid`) unless the roster comment is `Welcome`; moderator stipends are not affected. | `src/lib/welcome-media.ts`, `src/routes/messages.ts`, `src/routes/me.ts`, `src/routes/trust.ts`, `src/index.ts` (`welcomeCatchUp`), `src/lib/spend-instruction.ts`                                                                                                                                                                        |
| Operator replay   | Not a member trigger: an operator with `DEBUG_TOKEN` books the daily ping for a live top-level media post on that post's UTC day (`POST /debug/spend-ping` with `messageId`), or replays every live top-level media post, moderator-group message, `/trial`, `/admit`, and welcome trigger of a time window: each daily payout and moderator stipend on the event's own UTC day, once per member, kind, and day, and each welcome through the welcome path, once per account (`POST /debug/spend-ping` with `from`, `to`, and optional `dryRun`).                                                                                                                                                                                                                                                                                                             | `src/routes/debug-payments.ts` (`pingOnDay`), `src/lib/cutover-replay.ts`                                                                                                                                                                                                                                                                 |

The amount comes from the daily roster when the account is listed there, and
from `DAILY_ROSTER_DEFAULT_AMOUNT_USD` (1 USD) for an unlisted admitted or
trial grant. Moderator stipends are paid only to listed moderator rows.

The API roster (`daily_roster`, `daily_roster_entry`) is the master copy.
Spend's `POST /funding/daily-roster/document` import writes only when the
roster has never been written; after that it returns the stored document, and
spend pays the addresses it returns. Each row's address is the account's
receiving address at that moment (`<username>@<host>` once its wallet is
verified, `null` before, and `null` without a username or with the LNURL
server off). Spend's own local list (what
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
identity key and its Spark address (`spark_address`), then the LNURL register
call through `POST /lnurlpay/:pubkey`
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
(`gifts-debug db daily_roster_entry`), which the account link works on (see
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

## Roster account link at boot

Every roster row held a Wallet of Satoshi address. Rows are now keyed by
account (`daily_roster_entry.account_id`, one row per account and bucket), and
the payout address is not stored: whoever reads a row for a payout resolves
it from the account through `receivingAddress`, so it is `<username>@<host>`
once the wallet is verified, also when that happens after the release, and
no address before.

`linkDailyRosterAccounts` (`src/lib/daily-roster-store.ts`) runs in
`openBootStores` after `migrateDbChangeSchema` and `repairGiftKind`, so
`db_change` records every row it links:

- A row without an account whose address equals an account's legacy
  `lightning_address` (trimmed, case-insensitive) is linked to that account.
  With the LNURL server configured, an address `<username>@<host>` links to
  that username's account too. A row whose two matches name different
  accounts links to neither and stays without an account.
- Per account and bucket one row is linked (the oldest); a bucket that
  already holds the account links none.
- Amounts, buckets, and addresses do not change, and no row is deleted. A row
  that matches no account keeps no account: it is in no document and is never
  paid.
- It is one SQL statement (`DAILY_ROSTER_ACCOUNT_LINK_SQL`). A second boot
  changes nothing. The log line `daily_roster.accounts_linked` carries the
  two counts only.
- `GET /funding/daily-roster/links` (operator token,
  `gifts-debug daily-roster-links`) lists every stored row count, the linked
  count, the rows without an account by address and amount, and the count and
  USD sums per bucket over all rows and over the linked rows.
- A username change before the wallet is verified needs no roster change,
  because rows name the account.

On the roster of 2026-10-16 this links 15 recipient rows and 6 moderator rows
and leaves 1 recipient row without an account.

## Result

The wallet release moved payout addresses; social recovery and the later
server-verified shop-payment rule add payout conditions (below). `eligibleToday`
(`src/lib/funding.ts`) was identical on `main` and `staging` on 2026-10-16: a
payout needs a role other than `basis`, and an `admitted` grant or a `trial`
grant on the current UTC day. The grant requirement has applied since
2026-10-01 (`FUNDING_REQUIRED_FROM_UTC`). Daily payouts and moderator
stipends both pass through it. The 58 people had the roles `verified`,
`moderator` and `founder` on 2026-10-16. A member who is not eligible on a
day is not paid that day, before and after the release alike.

Since social recovery ([docs/social-recovery.md](social-recovery.md)),
`eligibleToday` also needs a stored 21.gifts recovery share for the member's
current verified wallet from the UTC day `RECOVERY_SHARE_REQUIRED_FROM` on. From that
day a member in the grant program without
that share is not paid that day, with the same answers as for a missing
grant; the staff trial and admit pings are skipped too. From that day, storing the first
share of the current wallet pings that UTC day's newest media post, so later
triggers that day pay as usual.

The member's own grant page receives one server-computed explanation for
today, never a list of simultaneous reasons. A recorded daily gift today is
shown as paid first; if none exists, a same-day welcome gift is shown as paid
because it replaces that day's daily payout. Otherwise the payout conditions
are checked lazily in this fixed order:

1. The member must be confirmed in real life: the live role is not `basis`
   (`verify`).
2. The member must be admitted, or on trial on today's UTC day
   (`admission`).
3. The member must have a verified in-app wallet (`wallet`).
4. On a day `recoveryShareRequired` applies, the current verified wallet must
   have its stored 21.gifts recovery share (`recovery_share`).
5. The member's wallet must have a completed server-verified payment to a live
   21.gifts shop today or yesterday UTC (`shop_payment`).
6. The member must have a live top-level photo or video note on today's UTC
   day (`media_post`).

When all six hold and no payout is recorded yet, the result is due. Its only
possible reason is `payments_paused` when `daily_roster.payments_enabled` is
off; otherwise the reason is null. A store failure makes the explanation
unknown (`null`) without failing the rest of `GET /me`.

### The recovery share period

`RECOVERY_SHARE_REQUIRED_FROM` (ISO date, UTC) is read at boot in each environment.
Unset or blank means the share is not required yet; any other value that is
not a calendar day stops the boot. It is the start day of the share condition
only: a verified wallet and the grant program stay required every day.

| Where the rule is used                                                                                                 | Before the start day, or unset                                   | From the start day                             |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `POST /invoices` (`src/routes/invoices.ts`, through `src/lib/payout-eligibility.ts`)                                   | The share is not read; a grant passes                            | 403 `Funding grant required` without the share |
| `GET /invoices/eligible`, `POST /spend/daily-instruction`                                                              | `eligible: true` / `pay` for a grant without a share             | `eligible: false` / `skip`, `not_eligible`     |
| Spend pings after a post, a zap-paid note, and a moderator-group message                                               | Sent for a grant without a share                                 | Skipped, `not_eligible`                        |
| Staff `POST /funding/trial` and `POST /funding/admit` ping (`src/lib/funding-ping.ts`)                                 | Sent; the share is not read                                      | Skipped without the share                      |
| First-share ping of `PUT /me/recovery-share` (`src/routes/me.ts`)                                                      | Not sent: the share made nobody payable, and the post was pinged | Sent                                           |
| `POST /debug/spend-ping` (`src/routes/debug-payments.ts`, `src/lib/cutover-replay.ts`), judged on the clock of the run | Paid; a window replay never reports `no_recovery_share`          | 403 `Not eligible`; `no_recovery_share`        |

The owner JSON now returns the first blocking payout condition in
`funding.payoutToday` (or top-level `grantPayoutToday` for `basis`), so a
required missing share is `recovery_share`. `socialRecoverySetUp` still only
says whether the share is stored. During the period the app still shows its
dialog on `/welcome` to a grant member without the share. The dialog text
`socialRecoveryPrompt.body` says grant payouts need Social Recovery (all four
locales), and `socialRecoveryPrompt.title` names the grant; before the start
day the first of those is not yet true of a payout. That text belongs to the
app.

An unset value on an environment changes what it does compared with a build
that has no start date: to keep the share required there, set the day there.

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

1. The API release includes the roster account link at boot.
2. The API and the app go live together. The new API with the old app would
   block posting for everyone, because the old app cannot create a wallet.
3. Production has `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` set for the API and
   `NEXT_PUBLIC_BREEZ_API_KEY` set for the app. Without them no wallet can be
   created or verified, and nobody can post. Once social recovery is on
   `main`, the API also has `RECOVERY_SHARE_KEK` (64 lowercase hex, different
   from `NOSTR_NSEC_KEK`) set. Without it the API stops at boot
   (`openBootStores`), so it keeps restarting and nobody is paid.
4. The API roster (`daily_roster_entry`) holds the same addresses, amounts and
   buckets as spend's live list in [Daily roster](#daily-roster). Every legacy
   row then belongs to an account with a username, except the one recipient
   without an account, and the link keeps every listed amount. A row that
   belongs to no account stays stored without one and is never paid. Both payment switches in `daily_roster` (`payments_enabled`, `moderator_payments_enabled`) are on, and its comment is not `Welcome`, which would let a daily payout through on a welcome day and mark payments as welcome payments.
5. Production runs the released heads: in each repository every
   `deploy-prd.yaml` run has status `completed`, and the run that finished
   last, whatever its result, succeeded and is on the `main` merge commit of
   the release. The workflow pushes the movable tag `latest`
   before it waits for the deploy, so a later run that failed or was
   cancelled may already have moved `latest`, and a re-run of an older run
   keeps its creation time but pushes `latest` again.
6. From the UTC day `RECOVERY_SHARE_REQUIRED_FROM`, with social recovery on `main`: the
   member has stored the 21.gifts recovery share of their current verified
   wallet. From that day a member in the grant program without it is not paid
   until they set up social recovery; storing the first share pings that UTC
   day's newest media post. Read the value on release day: unset keeps paying
   members without a share.
7. From deployment of the viewer rule, the member's wallet has a completed
   server-verified payment to a live 21.gifts shop on that payout UTC day or
   the day before. There is no configured start day. This applies to daily
   grants and moderator stipends, but not the one-time welcome gift.

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
account link leaves without an account. After the deploy, read
`gifts-debug daily-roster-links`: `linked` equals the old row count minus the
rows without an account, `unlinked` lists exactly those rows, and per bucket
`linkedUsd` equals `totalUsd` minus their amounts. Read `gifts-debug db daily_roster`: both `payments_enabled` and `moderator_payments_enabled` must be `true`, and `comment` must not be `Welcome`.
Read `GET /debug/welcome-sweep`: `wouldPing` lists every account the welcome sweep would ping. Turn the sweep on with `PUT /debug/welcome-sweep` only when that list holds no account that was welcomed before.
Read the grants of the 58 people with `gifts-debug db funding_grant` and their
roles with `gifts-debug db account` to know who is eligible on release day
(role not `basis`, and `admitted`, or `trial` for that UTC day). Once social
recovery is on `main`, also read `gifts-debug db recovery_share`: an eligible
member additionally needs a row whose `spark_pubkey` equals the account's
`spark_pubkey`, on an account whose `spark_pubkey_verified_at` is set, as
`loadPayoutEligibility` reads it.
Check the three settings of condition 3 in the production deployment
configuration, and the fourth, `RECOVERY_SHARE_KEK`, when the release brings
social recovery to `main`.
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
