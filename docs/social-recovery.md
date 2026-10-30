# Securing the account

Status: **Implemented.** Decided 2026-10-27 and 2026-10-28 (owner decisions
in [CONCEPT.md](../CONCEPT.md), 2026-10-28). The routes are in
[SPEC.md](../SPEC.md).

This replaces the design of 2026-09-29 and 2026-09-30 (two required people, a
48-hour wait, a server-side bind key, a seed wrap, a moderator suggested as
person 1). None of those parts remain.

## What recovery does

An owner who lost their passkey gets two things back:

1. **The same account.** The account id stays, and with it the username, the
   Lightning address `<username>@<host>`, the profile, the notes and the
   history. Only the passkey and the wallet key change. The NOSTR key is the
   custodial server key in v1 and does not change.
2. **The original 12 words.** They are put back together on the new phone and
   used to move the Lightning address and the whole wallet balance to the new
   wallet.

After recovery the account has a new passkey with its own new 12 words. A
passkey cannot take a given seed: the app derives the 12 words from the PRF
output of exactly one passkey (`src/lib/prf-mnemonic.ts` in the app, see
[CONCEPT.md](../CONCEPT.md)). So the old words cannot follow the account to the
new passkey. They open the old wallet for the move and are then discarded.
Nothing stores them.

This is the only path that gives an account a different recovery phrase.
`POST /auth/passkey/replace/begin` and `/finish` keep refusing with 409, and
the rule "A recovery phrase is never replaced" in [FLOWS.md](../FLOWS.md)
has this one exception.

## Who holds what

The 16 bytes behind the 12 words are split with SLIP-39: one group, group
threshold 1, member count 3, member threshold 2, empty passphrase. Any two
shares give back the same 16 bytes, and BIP-39 of those bytes is the original
12 words. One share gives nothing.

| Share | Held by                                           | How it travels                                                                                                                            |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Person 1, signed in to their own 21.gifts account | QR code, phone to phone, then kept as a box on the api under the holder's own login, encrypted in the holder's browser (`held_share_box`) |
| 2     | Person 2, signed in to their own 21.gifts account | QR code, phone to phone, then kept as a box on the api under the holder's own login, encrypted in the holder's browser (`held_share_box`) |
| 3     | 21.gifts, as a backup                             | To the api at setup (`PUT /me/recovery-share`), stored encrypted                                                                          |

- Person 1 and person 2 are two different people with two different phones,
  each with their own 21.gifts account. They hold a share only while signed
  in. There is no public holder page.
- A person's share reaches the 21.gifts server only as an opaque box,
  encrypted in the holder's browser under a key from the holder's own 12
  words, see [Held-share boxes](#held-share-boxes). The server cannot open it
  and stores nothing about who protects whom: the owner's id and name exist
  only inside the ciphertext, and nothing on the owner's account refers to a
  box.
- The 21.gifts share is a backup only. The api stores it encrypted and never
  decrypts or returns it; it reads only whether one is stored, see
  [Grant payouts](#grant-payouts). No release is planned; 21.gifts keeps it
  only as an option, see [The 21.gifts share](#the-21gifts-share).
- Any two holders act at once. There is no waiting period and no cancel
  window. Person 1 and person 2 together can recover the account and move the
  wallet without the owner. The owner is told this before choosing them.

## Who can use it

Securing the account is optional. Sign-up, login and every other use work
without it, except the payouts of the grant program, see
[Grant payouts](#grant-payouts). Recovery needs a verified wallet
(`spark_pubkey_verified_at` is set), because it is proven against that wallet
key.

Recovery checks the old 12 words, not the shares. It also works with 12 words
the owner wrote down, and for an account that never set up shares. Whoever
holds the 12 words can take the whole account at once, not only the wallet.
The app says so wherever it shows the 12 words.

## Setting it up

The owner finds **Social Recovery** in the settings, in the Wallet section
below the recovery phrase (`#recovery` in `src/components/SettingsScreen.tsx`
in the app). The entry shows whether social recovery is set up for the current
wallet, and opens **Mein Konto absichern**, where the owner chooses two people.
Setup may happen remotely, for example with the QR code shown in a video call.

1. The owner's phone derives the 12 words as today and opens the wallet with
   them. If its identity public key is not the account's verified
   `spark_pubkey`, setup stops.
2. The phone splits the 16 bytes into three shares. Before any share leaves
   the phone, it checks that each of the three pairs gives the same 16 bytes.
3. The owner's phone shows share 1 as a QR code. Person 1 scans it in their
   signed-in 21.gifts app (**Anteile, die ich für andere aufbewahre**). The
   app unlocks with the holder's passkey, encrypts the share code into a new
   box and stores it on the api under the holder's own login
   (`PUT /me/held-shares/:id`). Only the box says whose share it is (the
   owner's account id and name and the SLIP-39 identifier are inside the
   ciphertext).
4. The same for share 2 and person 2. Before it stores a box, the holder's
   app opens all of its own boxes (`GET /me/held-shares`) and refuses a share
   with the same owner and identifier as one it already holds, so one holder
   account never holds two shares of one set. The api cannot check this: it
   cannot open the boxes. A second 21.gifts account of the same person cannot
   be detected. A share of the holder's own account is refused too. The
   identifier is a random 15-bit value; if a new set happens to draw the
   identifier of an old set a person still holds, the holder's app refuses it
   too, and setup starts again with a new split.
5. Last, once both people hold their share, the owner's phone, signed in,
   sends share 3 to the api (`PUT /me/recovery-share`), which stores it as
   described under [The 21.gifts share](#the-21gifts-share). The stored share
   for the current wallet is what marks social recovery as set up.

Remotely, both shares are never shown over the same call or service, and the
call is not recorded: anyone who captures two shares can recover the account.

Choosing other people later means a new setup with three new shares. A new
setup does not revoke the old set, because the 12 words stay the same: any two
old shares still rebuild them. The api replaces its stored share of that
wallet with the new one. Holders delete an old share by hand in their app when
the owner asks (`DELETE /me/held-shares/:id`). The app warns the owner that a removed person's share stays
usable together with any other old share.

## The 21.gifts share

- **Storage.** The api encrypts share 3 in the request that brings it and
  stores only the ciphertext (`recovery_share`), under the account and its
  verified `spark_pubkey` at that time, one per wallet. It uses AES-256-GCM
  under its own 32-byte key `RECOVERY_SHARE_KEK`, which must differ from
  `NOSTR_NSEC_KEK`, with the account id as additional data, in the envelope
  layout of `nostr_nsec_ciphertext` (`sealAesGcmEnvelope` in
  `src/lib/aes-gcm-envelope.ts`, which `encryptNostrSecret` in
  `src/lib/nostr/keys.ts` uses too). The key comes from the deployment
  environment as 64 lowercase hex characters and is checked at boot like
  `NOSTR_NSEC_KEK` (`parseRecoveryShareKek` in
  `src/lib/auth/recovery-share.ts`, through `parseKekHex` in
  `src/lib/nostr/kek.ts`): with `DATABASE_URL` set, a missing or malformed
  key, or one equal to `NOSTR_NSEC_KEK`, stops the boot. 21.gifts also keeps
  it in its password vault.
- **Secret column.** The share's column `recovery_share_ciphertext` is a
  secret column like `nostr_nsec_ciphertext`: `db_change` keeps only its
  SHA-256 (`db_change_redact` in `src/lib/db-change.ts`), and `GET /debug/db`
  shows only its length (`DEBUG_DB_SECRET_COLUMNS` in `src/lib/debug-db.ts`).
  A replaced or deleted share therefore leaves no copy. The column is in the
  lists of secret columns in CONTRIBUTING.md and CONCEPT.md.
- **Previous wallets.** After a recovery, the share of the previous wallet
  stays until the owner drops that wallet; the drop deletes both in one
  statement.
- **A leak.** The database alone gives no share. The database together with
  the environment gives every stored 21.gifts share. This is accepted: one
  share alone rebuilds nothing.
- **No use of its content.** No route returns the share, nothing in the api
  decrypts it (there is no decrypt function), and no log contains it. The api
  only checks whether one is stored for the current wallet, see
  [Grant payouts](#grant-payouts).
- **No planned release.** 21.gifts plans no release of its share and keeps it
  only as an option. Using it would be a manual process outside the api, with
  the key from the vault.

## Held-share boxes

Decided 2026-10-30. A holder's share used to live in the app's browser
storage, which a browser can delete without notice (Safari after seven days
without a visit, cleared site data, a new phone or browser). Holders must
never manage a secret themselves (no paper copies, no exports), so the share
is kept on the api as an encrypted **box** under the holder's own login.

- **Encryption, in the holder's browser.** The box key is HKDF-SHA256 over the
  16 bytes behind the holder's own 12 words (salt `21gifts-held-share-box`,
  info `box-key-v1`), imported as a non-extractable AES-GCM key. A box is the
  version byte `0x01`, a random 12-byte IV and the AES-256-GCM ciphertext and
  tag of the share code (`21gifts-share:v1:<owner account id>:<owner
username>:<20 SLIP-39 words>`), with the additional data
  `21gifts-held-share-v1\n<holder account id>\n<box id>`. The box id is 16
  random bytes as 32 lowercase hex, chosen by the app. The app owns this
  format (the counterpart pull request in the app repository); the api treats
  the bytes as opaque.
- **On the api.** `held_share_box` keeps the box id, the holder's account id,
  the ciphertext and the creation and update times. The routes act only on
  the caller's own boxes, with the normal session: `GET /me/held-shares`,
  `PUT /me/held-shares/:id` and `DELETE /me/held-shares/:id` (contracts in
  [SPEC.md](../SPEC.md)). The api checks only the id format, a size of 29–1024
  bytes, the version byte, that the id is not another account's, and at most
  50 boxes per account. They need no LNURL server and are always mounted.
- **Nothing on the owner's side.** No box id, label or count is stored on the
  owner's account, and the payout gate is unchanged: it checks only the
  21.gifts share. The api does not tell holders anything; the owner contacts
  them, and a holder opens **Anteile, die ich für andere aufbewahre**,
  unlocks, picks the owner's name and shows the QR code.
- **Secret column.** `ciphertext` is a secret column like
  `recovery_share_ciphertext`: `db_change` keeps only its SHA-256 and
  `GET /debug/db` shows only its length. No application log or request log
  contains a ciphertext or a box id; the request log shows the path as
  `/me/held-shares/:id`. The row-change log `db_change` keeps the box id and
  the holder's account id like every other row (it must stay
  reconstructable); neither names the owner of the share.
- **The holder's own recovery.** The key comes from the holder's 12 words,
  not from the passkey. A holder who recovers their own account rebuilds the
  old words, opens the boxes with them and stores them again under the key of
  the new words (`PUT` of the same ids). The recovery commit keeps the account
  id, so the boxes stay where they are.
- **Account deletion and merge.** Deleting the holder's account deletes its
  boxes (`ON DELETE CASCADE`). An account merge moves them to the surviving
  account like every other row of the merged account. The surviving account
  cannot open them: the additional data names the merged account and the key
  comes from the merged account's words.
- **Accepted risk.** A holder who loses their passkey for good and never
  recovers loses the boxes, and nobody is told. There is no machinery for
  this; the owner sets up shares with someone else.

## Grant payouts

For a member in the grant program, an admitted grant or a trial on today's
UTC day, social recovery is a payout condition.

- **Set up** means that the api holds a 21.gifts share for the account's
  current verified `spark_pubkey`. A share of a previous wallet does not count,
  so after a recovery the condition is open again until the owner sets up
  shares for the new words. The api reads only whether such a share is stored,
  never its content.
- **Payouts.** `eligibleToday` (`src/lib/funding.ts`) also requires it
  wherever this code runs. There is no start date of its own: the condition
  holds on every day the grant is required (`FUNDING_REQUIRED_FROM_UTC`, the
  grant's date). That function already requires the grant for every payout,
  and `loadPayoutEligibility` (`src/lib/payout-eligibility.ts`) reads the
  share for each payout path, except two pings that follow a write (below).
  Without a share the account is not eligible, with the same answers as for a
  missing grant, so the payout worker skips the trigger as it does today.
  Storing the first share of the current wallet pings that UTC day's newest
  media post, as `pingTodayMedia` (`src/lib/funding-ping.ts`) does when staff
  admit a grant, and later triggers that day pay as usual. That first-share
  ping calls `eligibleToday` directly with the share just stored. The staff
  trial and admit pings need the share as well; `pingTodayMedia` reads it
  itself (`requireShare: true`). A day that ends without a share is not paid,
  except by an operator replay, which checks eligibility when it runs.
- **Owner field.** The owner account JSON carries `socialRecoverySetUp`,
  whether social recovery is set up, with no grant or date check. The
  settings entry shows the fact, and the dialog and the payouts use it.
- **Prompt.** From the release on, a member in the grant program whose owner
  field is false sees a dialog on `/welcome`, like **Stell dich vor**
  (`IntroduceYourselfOverlay` in the app). It says that grant payouts need
  social recovery and opens **Mein Konto absichern**. Closing it hides it
  until the next visit to `/welcome`. When both dialogs apply, **Stell dich
  vor** comes first.

## Recovery

Recovery needs each person to meet the owner **in person**. The owner has a
new phone with the 21.gifts app.

1. The owner taps **Account über Social Recovery wiederherstellen**.
2. The new phone scans the QR codes of person 1 and person 2, or the owner
   types the old 12 words.
3. The app rebuilds the old 12 words and opens the old wallet. It signs the
   LNURL server's address lookup of the old key (`breez-lnurl:v2`, `recover`,
   the app host, the key and a timestamp: the message the Breez SDK signs for
   its own lookup) with the old wallet's identity key, and starts a recovery
   ceremony with `POST /auth/passkey/recovery/begin`, sending the old key, the
   DER signature and the timestamp. The api forwards the lookup to the LNURL
   server as `POST /lnurlpay/<old key>/recover`. The ceremony sits behind the
   same app build check and login switch as the register and authenticate
   ceremonies. The server finds the account whose verified `spark_pubkey` is
   that key, refuses an account with `session_refused`, and returns WebAuthn
   creation options for a new passkey on that account: as for a seed passkey,
   with a stored passkey challenge of the new type `recovery` and the same
   `CHALLENGE_TTL_MS` window.
4. The app creates the new passkey, derives the new 12 words from it and opens
   the new wallet. The new passkey is not linked to the account yet.
5. One button, **Übertragen**, does the rest in this order:
   1. **Account.** The old wallet signs the recovery message (`signMessage`
      in the Breez SDK). The app finishes the ceremony with it and the new
      passkey's attestation (`POST /auth/passkey/recovery/finish`), and the
      server stores a **pending recovery**.
   2. **Lightning address.** The old wallet authorizes the transfer of the
      address to the new wallet (`authorizeLightningAddressTransfer`), and the
      new wallet claims it (`claimLightningAddressTransfer`). The Breez SDK
      sends the claim to `POST /lnurlpay/<new key>/transfer`, forwarded like
      `POST /lnurlpay/:pubkey`. When the LNURL server accepts it, the server
      commits the account transfer.
   3. **Balance.** After the commit, which the app confirms by signing in
      with the new passkey, the old wallet sends its whole balance to the new
      wallet, if it is above 0.

The app signs in with the new passkey through the normal authenticate
ceremony. Until the commit, `POST /auth/passkey/authenticate/finish` answers
409 `recovery_pending` (`Recovery is not finished`) for the new passkey
instead of `Unknown credential`, so the app never has the authenticator
delete a passkey that the commit may still make the account's only one.
Until the commit, nothing on the account changes. The QR codes use the app's
existing `QrCode` and `QrScanner` components, and the new 12 words are shown
on the existing phrase screen.

### The recovery message

UTF-8, five lines, a newline between the lines, no trailing newline:

```text
21gifts-account-recovery-v1
<account id>
<challenge of this recovery ceremony, base64url as issued>
<new passkey credential id, base64url>
<new wallet identity public key, lowercase hex>
```

The finish accepts it only when the public key returned by `signMessage` is
the account's verified `spark_pubkey`, the signature verifies for this exact
message as described under [The signature](#the-signature), the challenge is
the account's unconsumed `recovery` challenge inside `CHALLENGE_TTL_MS`, and
the new passkey's attestation verifies with that challenge and carries the
credential id named in the message, as the seed passkey finish does for the
rest. It mints no session. A repeat of the finish that stored the pending
recovery, with the same challenge, credential id and new wallet key, answers
200 again and changes nothing; any other use of a consumed challenge is
refused (`Challenge already used`).

### The signature

The app calls `signMessage` of the Breez SDK pinned in the app (0.26.0) with
`compact: true`. It signs with the wallet's identity key, the key behind
`spark_pubkey`: ECDSA on secp256k1 over one SHA-256 of the message's UTF-8
bytes, with no prefix, RFC 6979 nonces and a low S. It returns `pubkey` as 66
lowercase hex characters, the compressed key that `getInfo().identityPubkey`
also returns, and `signature` as 128 lowercase hex characters, `r` then `s`.
The server verifies exactly that and refuses a signature with a high S.

The same key signs the wallet's Spark login challenges, so the message starts
with its own first line, `21gifts-account-recovery-v1`. The SDK refuses to
sign a message that starts with `breez-lnurl:`, which this message never
does. The implementation's tests pin one message, key and signature made by
that SDK version.

### The commit

When the LNURL server accepts the address claim, one transaction:

- changes the account only while its verified `spark_pubkey` is still the old
  key,
- stores the new passkey credential,
- deletes every other passkey credential, every session and every push
  subscription of the account,
- adds the old `spark_pubkey` and `spark_address` to the account's
  **previous wallets**,
- stores the new key as verified `spark_pubkey` with its `spark_address`,
  keeping the first verification time, so the welcome gift does not start
  again,
- deletes the pending recovery.

The username stays. An old key never moves the account again.

### Rules for the implementation

The account transfer depends on the LNURL server, which can answer late, not
at all, or with an error after it already moved the name. The implementation
keeps these rules:

1. **One at a time.** An account has at most one pending recovery. Begin, the
   finish and the transfer route's admission each run as one locked step per
   account. A finish consumes its challenge only when it stores the pending
   recovery, and never replaces one that was forwarded. A repeat of the
   finish that stored the pending recovery, with the same challenge,
   credential id and new wallet key, answers 200 again and changes nothing;
   any other use of a consumed challenge is refused
   (`Challenge already used`).
2. **Only the newest ceremony.** Begin consumes the account's earlier
   `recovery` challenges and drops a pending recovery that was not forwarded;
   one that was not forwarded also ends after `CHALLENGE_TTL_MS`. A new
   passkey for the same account replaces the earlier one in the
   authenticator, so begin hands out no options while a forwarded pending
   recovery remains. It settles it first.
3. **Proof first.** Begin changes nothing unless the LNURL server verified the
   old wallet's lookup, and it starts a recovery only while the old key holds
   the username. Knowing the public wallet key is not enough.
4. **Admission.** The transfer route forwards a claim only for the account's
   pending recovery that is not forwarded yet and whose new key is the path
   key, authorized by that recovery's old key, still the verified
   `spark_pubkey`, for the account's username. It marks the recovery forwarded
   in the same step.
5. **Settling.** Apart from the commit on the claim's own 2xx, a forwarded
   pending recovery commits when the new key's lookup returns the username,
   or when the LNURL server answers its own "user not found" to a verified
   lookup of the old key. It is dropped when the old key's lookup returns the
   username. Any other answer keeps it. Only lookups sent later than twice
   `LNURL_SERVER_TIMEOUT_MS` after the forward count. The forwarded lookup
   route (`POST /lnurlpay/:pubkey/recover`) also passes a pending recovery's
   new key.
6. **Answers.** The transfer route answers like the register route
   (`src/routes/lnurl-server.ts`). Begin answers 503 `UNAVAILABLE`, like the
   forwarded routes, while the old wallet's lookup is not verified or a
   forwarded pending recovery is kept, and the app tries again after the
   forward window. For a previous wallet's key, or a pending recovery it
   commits, begin answers that the account was already recovered and to sign
   in with the new passkey. When the old key no longer holds the username and
   no pending recovery remains, begin refuses and the account needs an
   operator.

### Routes

The contracts are in [SPEC.md](../SPEC.md):

- `POST /auth/passkey/recovery/begin` and `POST /auth/passkey/recovery/finish`:
  the ceremony, behind the app build check and the login switch.
- `POST /lnurlpay/:pubkey/transfer`: the address claim and the commit.
- `PUT /me/recovery-share`: the 21.gifts share.
- `GET /me/held-shares`, `PUT /me/held-shares/:id` and
  `DELETE /me/held-shares/:id`: the holder's own boxes, see
  [Held-share boxes](#held-share-boxes).
- `GET /me/previous-wallets` and `DELETE /me/previous-wallets/:sparkPubkey`:
  the previous wallets.
- Changed: `POST /lnurlpay/:pubkey/recover` (rule 5),
  `POST /auth/passkey/authenticate/finish` (409 `recovery_pending`), owner
  JSON `socialRecoverySetUp`, and `POST /me/events` (`recovery_done`).

The new routes under `/lnurlpay` and `/me` are mounted only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve, except the held-share
routes, which are always mounted; without them, begin answers 503. The tables
are `recovery_share`, `pending_recovery`, `previous_wallet` and
`held_share_box` (`docs/schema/`).

### The LNURL server

The self-hosted LNURL server in use accepts `POST /lnurlpay/:pubkey/transfer`.
It checks both signatures and moves the name within the request, in one
database transaction, with no background work. It sets no time limit of its
own on the whole request: it waits up to 30 seconds for a pooled database
connection and without limit for its locks. The settling window therefore
holds only if the server drops a request whose connection the api closed, and
only if the api reaches the server with no proxy in between that would keep
an aborted forward running.

### Verification against the LNURL server

Whether the LNURL server build in use drops a forward that the api aborted
while the server waited for a lock cannot be tested in this repository's CI:
that build is not available there.

**In the repository (CI).**

- The transfer route sends its forward with `LNURL_SERVER_TIMEOUT_MS`, and so
  do the recover route and the lookup of recovery begin
  (`src/__tests__/routes/lnurl-server.test.ts`,
  `src/__tests__/lib/auth/recovery.test.ts`). `callLnurlServer` aborts a
  forward after the `timeoutMs` it is given and reports it unreachable
  (`src/__tests__/lib/lnurl-server.test.ts`).
- The transfer route then answers 503 and commits nothing, and the pending
  recovery stays forwarded (`src/__tests__/routes/lnurl-server.test.ts`).
- Nothing settles it within `RECOVERY_SETTLE_AFTER_MS` after the forward;
  after that, only the lookups of rule 5 settle it
  (`src/__tests__/lib/auth/recovery.test.ts`).

**By hand, against the deployed LNURL server image.** This is not a CI test.
It runs before the implementing pull request leaves draft, and again when the
deployed LNURL server build changes. The pull request records the commands,
the outputs, and the image, named only by its digest.

1. Run the deployed LNURL server image against a scratch Postgres 16 with one
   served domain `d`. Generate two test keys, A (old) and B (new), with
   `secp256k1.utils.randomSecretKey()` of `@noble/curves`. Register a
   username `u` for A with `POST /lnurlpay/<A>` (`Host: d`) and the body
   `{ username: u, description: 'Pay to u', timestamp, signature }`, where
   `signature` is A's DER signature (`signDer` in
   `src/__tests__/helpers/recovery.ts`) over
   `breez-lnurl:v2\nregister\n<d>\n<u>\n<lowercase SHA-256 hex of the description>\n<timestamp>`.
2. From `psql`, hold the server's registration lock for A. Compute its key as
   the server does: the first 8 bytes of
   `SHA-256("lnurl/registration/" ‖ d ‖ "\0" ‖ A)`, read as a signed
   big-endian 64-bit integer. Run `BEGIN; SELECT pg_advisory_xact_lock(<key>);`
   and keep that transaction open.
3. From a temporary script outside the repository, run the api against that
   server on a memory boot (`createApp`, `LNURL_SERVER_URL` pointing at the
   server, `PUBLIC_BASE_URL` on host `d`, `LNURL_SERVER_TIMEOUT_MS`
   unchanged). In that script:
   - seed an account with username `u` and key A verified (as
     `seedRecoverableAccount` does);
   - store an unforwarded pending recovery A → B through
     `startRecoveryChallenge` and `storePendingRecovery` on the in-memory
     store;
   - send `POST /lnurlpay/<B>/transfer` to the api with the Breez SDK body
     (as `transferBody` builds it), signed by A over
     `lnurlTransferFromMessage` and by B over `lnurlTransferToMessage` with
     `signDer`, for domain `d` and the current timestamp.

   The api must admit it (the pending recovery gets `forwardedAt`), answer
   503 after 15 s, and leave the account on key A.

4. Wait 5 s, then `COMMIT` the `psql` transaction, which releases the lock.
   Wait 30 s.
5. `SELECT pubkey FROM users WHERE domain = d AND name = u` must still give
   A. A signed lookup of A returns `u`, and one of B returns
   `"user not found"`.
6. Negative control: repeat with a fresh pending recovery and without the
   lock. The name moves to B, and the api commits.

If step 5 gives B, the settling window does not hold with that build, and the
feature must not be released with it. Separately, an operator confirms that
`LNURL_SERVER_URL` of every environment reaches the LNURL server with no
proxy in between.

### If not everything succeeds

The button can be pressed again while the app still holds the old words; each
press resumes at the first step not done. If the account did not move,
recovery starts again, with the two QR codes or the old 12 words once the app
was closed.

If the balance did not move, the settings list each previous wallet
(`GET /me/previous-wallets`) with its balance and open **Restguthaben
übertragen** for it. That page needs the two QR codes or the old 12 words of
that wallet again and then sends the balance. The api reads the listed
balance from the public Spark explorer (Sparkscan), anonymously and by the
wallet's `spark_address`, or shows it as unknown. It includes incoming
transfers that are not claimed yet, and it is information only: the explorer
can lag behind the wallet, so no action depends on it. The app's existing
**Move Bitcoin from another wallet** (`MoveFundsSheet`) cannot do this: it
only shows an address for a send from a wallet app the member still runs. The
owner drops a previous wallet on its **Restguthaben übertragen** page once
that wallet, opened with its words, reads 0
(`DELETE /me/previous-wallets/:sparkPubkey`).

## After recovery

The app shows the new 12 words and says that words written down earlier now
open only the previous wallet. It asks the owner to set up new shares for the
new words. For a member in the grant program, payouts wait for that, see
[Grant payouts](#grant-payouts). After the sign-in that ends a recovery, the
app logs the one interaction event `recovery_done` (`POST /me/events`). The
old shares stay with the holders, told apart by the owner's account id and
the SLIP-39 identifier, until the owner drops the previous wallet and asks
each person to delete their old share by hand.

## What the server stores

No 12 words, no 16 bytes, no readable person's share and no PRF output, in no
row and no log. No application log or request log contains the 21.gifts share,
a held-share box id or a box's ciphertext. The row-change log `db_change`
keeps only a SHA-256 of each box's ciphertext, and keeps the box id and the
holder's account id as it does for every row.

- The 21.gifts share, encrypted, for the current wallet and for each previous
  wallet until the owner drops it (`recovery_share`).
- The new passkey credential, as for any passkey.
- `spark_pubkey` and `spark_address` of the current wallet, and of each
  previous wallet until the owner drops it (`previous_wallet`).
- The recovery challenge, as a passkey challenge of type `recovery`.
- At most one pending recovery per account, until it commits or is dropped
  (`pending_recovery`). It holds the new passkey's public key, never a
  secret.
- Each holder's boxes, encrypted in the holder's browser, under the holder's
  account until the holder deletes them or the account is deleted
  (`held_share_box`). The api cannot open them and does not know whose share
  a box holds or that a box belongs to a set.

## Security

- **Two people together** can recover the account and move the wallet at
  once. The owner chooses them knowing this.
- **One person** cannot. A single share reveals nothing, and the holder's app
  refuses a second share of the same set in that holder's boxes.
- **Whoever holds the 12 words** can recover the account, with or without
  shares.
- **Old shares** stay valid until each holder deletes them.
- **The server alone** cannot. With its environment it can read the 21.gifts
  share, one share per wallet, and it cannot sign with the wallet key. It
  cannot open a held-share box: the key comes from the holder's 12 words,
  which the server never sees.
- **A stolen database** gives no share. A stolen database with the
  environment gives every 21.gifts share, still one per wallet, and no box.
  It shows how many boxes each holder keeps and when they changed, not whose
  shares they are.
- **A holder's 12 words** open that holder's boxes. Whoever has them can
  already take the holder's whole account; with the boxes they also get the
  shares that holder keeps, one share per owner.
- **A holder who loses their passkey** for good and never recovers loses the
  boxes, and nobody is told. This is accepted; the owner sets up shares with
  someone else when a holder can no longer show the QR code.
- **21.gifts and one person** could rebuild the words, by hand and outside
  the api. No release is planned.
- **A stranger with a fake QR code** has to stand in front of the person,
  because recovery happens in person.
- **A stranger who replays a verified lookup** of the old wallet within the
  LNURL server's validity window (ten minutes) can restart a recovery that is
  not forwarded yet, or make begin settle a forwarded one after its forward
  window, as the owner's own begin would; that takes over nothing. The public
  wallet key alone is not enough.
- **A recorded remote setup** can leak shares, so both shares never go over
  the same call, and calls are not recorded.
- **A replayed signature** is refused: the message binds the account, a
  single-use challenge, the new passkey and the new wallet key.
- **The lost phone** loses its sessions and push subscriptions.
- **Losing the new phone during recovery** as well, without a synced passkey,
  can make the account unrecoverable.

## Open points

Later, not needed for a first version:

- A confirmation code for remote setup.
- NOSTR after v1, where new 12 words would mean a new npub.

## Acceptance criteria

- Each pair of the three shares, or the typed old 12 words, rebuilds the
  original 12 words. One share does not.
- Setup stops when the words do not open the account's verified wallet, and
  the holder's app refuses a second share of the same set in its boxes.
- A person's share reaches the api only as a held-share box encrypted in the
  holder's browser; the api cannot open it, and nothing on the owner's
  account refers to it. The api stores the 21.gifts share only
  encrypted under its own key, with the account id as additional data, and
  has no path that decrypts or returns it or uses its content; it only checks
  whether one is stored. `db_change` holds only its
  SHA-256, and a previous wallet's share stays until the owner drops that
  wallet.
- Recovery without a valid signature by the verified `spark_pubkey`, with a
  used or expired challenge, or for a `session_refused` account changes
  nothing. The pinned message, key and signature from the SDK verify, and the
  same signature with a high S does not.
- Until the LNURL server accepts the address claim, the account is unchanged.
- A forward that the api aborts while the LNURL server waits for a lock moves
  no name, tested against the deployed LNURL server build (see
  [Verification against the LNURL server](#verification-against-the-lnurl-server)).
- After the commit: one passkey credential, no old session or push
  subscription, the new key as verified `spark_pubkey`, the old key among the
  previous wallets, the same username and Lightning address.
- The rules for the implementation hold, and at most one recovery per old key
  commits.
- No row contains the 12 words, the 16 bytes, a readable person's share, PRF
  output or a readable 21.gifts share, and no log contains any of them. A
  person's share is stored only as an opaque `held_share_box` row, and no
  application log or request log contains a box id or a box's ciphertext.
- **Social Recovery** is reachable from the settings, and nothing but grant
  payouts needs it.
- From the release on, no payout goes to a member in the grant program
  without a 21.gifts share for the account's current verified `spark_pubkey`,
  and such a member sees the dialog on each visit to `/welcome`, unless they
  closed it during that visit or **Stell dich vor** is shown.

## Out of scope here

- Splitting the passkey private key.
- On-chain multisig. This is Shamir secret sharing of the seed.
- Requiring **Mein Konto absichern** for sign-up, login or any use other than
  grant payouts.
- Moving funds of an external Lightning wallet.
