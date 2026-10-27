# Securing the account

Status: **concept only**. Decided 2026-10-27. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

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
gains this one exception when recovery is built.

## Who holds what

The 16 bytes behind the 12 words are split with SLIP-39: one group, group
threshold 1, member count 3, member threshold 2, empty passphrase. Any two
shares give back the same 16 bytes, and BIP-39 of those bytes is the original
12 words. One share gives nothing.

| Share | Held by                  | How it travels                        |
| ----- | ------------------------ | ------------------------------------- |
| 1     | Person 1, on their phone | QR code, phone to phone               |
| 2     | Person 2, on their phone | QR code, phone to phone               |
| 3     | 21.gifts, as a backup    | Open, see [Open points](#open-points) |

- Person 1 and person 2 are two different people with two different phones.
- A person's share never reaches the 21.gifts server, sealed or not. The
  server stores nothing about who protects whom.
- The 21.gifts share is a backup only. The api never reads, releases or uses
  it. Using it is a manual 21.gifts process.
- Any two holders act at once. There is no waiting period and no cancel
  window. Person 1 and person 2 together can recover the account and move the
  wallet without the owner. The owner is told this before choosing them.

## Who can use it

Securing the account is optional. Sign-up, login and every other use work
without it. Recovery needs a verified wallet (`spark_pubkey_verified_at` is
set), because it is proven against that wallet key.

Recovery checks the old 12 words, not the shares. It also works with 12 words
the owner wrote down, and for an account that never set up shares. Whoever
holds the 12 words can take the whole account at once, not only the wallet.
The app says so wherever it shows the 12 words.

## Setting it up

The owner opens **Mein Konto absichern** and chooses two people. Setup may
happen remotely, for example with the QR code shown in a video call.

1. The owner's phone derives the 12 words as today and opens the wallet with
   them. If its identity public key is not the account's verified
   `spark_pubkey`, setup stops.
2. The phone splits the 16 bytes into three shares. Before any share leaves
   the phone, it checks that each of the three pairs gives the same 16 bytes.
3. The owner's phone shows share 1 as a QR code. Person 1 scans it in the
   21.gifts app, which keeps it on that phone under the owner's account id and
   the share's SLIP-39 identifier.
4. The same for share 2 and person 2. A phone that already holds a share for
   the same owner with the same identifier refuses the new one, so one phone
   never holds two shares of one set. The identifier is a random 15-bit value;
   if a new set happens to draw the identifier of an old set a person still
   holds, that phone refuses it too, and setup starts again with a new split.
5. Share 3 goes to 21.gifts as described under [Open points](#open-points).

Remotely, both shares are never shown over the same call or service, and the
call is not recorded: anyone who captures two shares can recover the account.

Choosing other people later means a new setup with three new shares. A new
setup does not revoke the old set, because the 12 words stay the same: any two
old shares still rebuild them. Holders delete an old share by hand in their
app when the owner asks. The app warns the owner that a removed person's share
stays usable together with any other old share.

## Recovery

Recovery needs each person to meet the owner **in person**. The owner has a
new phone with the 21.gifts app.

1. The owner taps **Account über Social Recovery wiederherstellen**.
2. The new phone scans the QR codes of person 1 and person 2, or the owner
   types the old 12 words.
3. The app rebuilds the old 12 words, opens the old wallet and starts a
   recovery ceremony with the old wallet's identity key and its signed address
   lookup (`POST /lnurlpay/<old key>/recover`), behind the same app build check
   and login switch as the register and authenticate ceremonies. The server finds the
   account whose verified `spark_pubkey` is that key, refuses an account with
   `session_refused`, and returns WebAuthn creation options for a new passkey
   on that account: as for a seed passkey, with a stored passkey challenge of
   the new type `recovery` and the same `CHALLENGE_TTL_MS` window.
4. The app creates the new passkey, derives the new 12 words from it and opens
   the new wallet. The new passkey is not linked to the account yet.
5. One button, **Übertragen**, does the rest in this order:
   1. **Account.** The old wallet signs the recovery message (`signMessage`
      in the Breez SDK). The app finishes the ceremony with it and the new
      passkey's attestation, and the server stores a **pending recovery**.
   2. **Lightning address.** The old wallet authorizes the transfer of the
      address to the new wallet (`authorizeLightningAddressTransfer`), and the
      new wallet claims it (`claimLightningAddressTransfer`). The Breez SDK
      sends the claim to `POST /lnurlpay/<new key>/transfer`, a new route
      forwarded like `POST /lnurlpay/:pubkey`. When the LNURL server accepts
      it, the server commits the account transfer.
   3. **Balance.** After the commit, which the app confirms by signing in
      with the new passkey, the old wallet sends its whole balance to the new
      wallet, if it is above 0.

The app signs in with the new passkey through the normal authenticate
ceremony. Until the commit, nothing on the account changes. The QR codes use
the app's existing `QrCode` and `QrScanner` components, and the new 12 words
are shown on the existing phrase screen.

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
message, the challenge is the account's unconsumed `recovery` challenge inside
`CHALLENGE_TTL_MS`, and the new passkey's attestation verifies with that
challenge and carries the credential id named in the message, as the seed
passkey finish does for the rest. It mints no session.

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
at all, or with an error after it already moved the name. An implementation
keeps these rules:

1. **One at a time.** An account has at most one pending recovery. Begin, the
   finish and the transfer route's admission each run as one locked step per
   account. A finish consumes its challenge only when it stores the pending
   recovery, and never replaces one that was forwarded.
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

### If not everything succeeds

The button can be pressed again while the app still holds the old words; each
press resumes at the first step not done. If the account did not move, recovery starts again,
with the two QR codes or the old 12 words once the app was closed.

If the balance did not move, the settings list each previous wallet with its
balance and a button **Restguthaben übertragen**. It needs the two QR codes or
the old 12 words of that wallet again and then sends the balance. The balance
is read live from the public Spark explorer API by the wallet's
`spark_address`, or shown as unknown. The app's existing **Move Bitcoin from
another wallet** (`MoveFundsSheet`) cannot do this: it only shows an address
for a send from a wallet app the member still runs. The owner drops a previous
wallet once its balance is 0.

## After recovery

The app shows the new 12 words and says that words written down earlier now
open only the previous wallet. It asks the owner to set up new shares for the
new words. The old shares stay on the people's phones, told apart by the
owner's account id and the SLIP-39 identifier, until the owner drops the
previous wallet and asks each person to delete their old share by hand.

## What the server stores

No 12 words, no 16 bytes, no share and no PRF output, in no row and no log.

- The new passkey credential, as for any passkey.
- `spark_pubkey` and `spark_address` of the current wallet, and of each
  previous wallet until the owner drops it.
- The recovery challenge, as a passkey challenge of type `recovery`.
- At most one pending recovery per account, until it commits or is dropped.

## Security

- **Two people together** can recover the account and move the wallet at
  once. The owner chooses them knowing this.
- **One person** cannot. A single share reveals nothing, and a phone refuses
  a second share of the same set.
- **Whoever holds the 12 words** can recover the account, with or without
  shares.
- **Old shares** stay valid until each holder deletes them.
- **The server alone** cannot. It holds no readable share and cannot sign
  with the wallet key.
- **21.gifts and one person** can, through the manual backup process only.
- **A stranger with a fake QR code** has to stand in front of the person,
  because recovery happens in person.
- **A stranger who replays a verified lookup** of the old wallet within the
  LNURL server's validity window (ten minutes) can only restart a recovery
  that is not forwarded yet; that takes over nothing. The public wallet key
  alone is not enough.
- **A recorded remote setup** can leak shares, so both shares never go over
  the same call, and calls are not recorded.
- **A replayed signature** is refused: the message binds the account, a
  single-use challenge, the new passkey and the new wallet key.
- **The lost phone** loses its sessions and push subscriptions.
- **Losing the new phone during recovery** as well, without a synced passkey,
  can make the account unrecoverable.

## Open points

- **21.gifts share.** How 21.gifts keeps and manually releases its share.
  Proposal: sealed to a 21.gifts offline key, so the api can never read it.
- **LNURL server.** That the self-hosted LNURL server accepts
  `POST /lnurlpay/:pubkey/transfer`, and moves no name later than twice
  `LNURL_SERVER_TIMEOUT_MS` after the forward.
- **Signature scheme.** The exact `signMessage` scheme, pinned with a test
  vector.
- **Later:** a printed copy of a person's share against cleared browser
  storage, a confirmation code for remote setup, and NOSTR after v1, where
  new 12 words would mean a new npub.

## Acceptance criteria for a later implementation

- Each pair of the three shares, or the typed old 12 words, rebuilds the
  original 12 words. One share does not.
- Setup stops when the words do not open the account's verified wallet, and a
  phone refuses a second share of the same set.
- No person's share reaches the api, and the api has no path that reads,
  returns or uses the 21.gifts share.
- Recovery without a valid signature by the verified `spark_pubkey`, with a
  used or expired challenge, or for a `session_refused` account changes
  nothing.
- Until the LNURL server accepts the address claim, the account is unchanged.
- After the commit: one passkey credential, no old session or push
  subscription, the new key as verified `spark_pubkey`, the old key among the
  previous wallets, the same username and Lightning address.
- The rules for the implementation hold, and at most one recovery per old key
  commits.
- No row and no log contains the 12 words, the 16 bytes, a share or PRF
  output.

## Out of scope here

- Any route, table, screen or migration.
- Splitting the passkey private key.
- On-chain multisig. This is Shamir secret sharing of the seed.
- Requiring **Mein Konto absichern** for sign-up, login or any other use.
- Moving funds of an external Lightning wallet.
