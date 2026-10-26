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
   history. Only the passkey and the wallet key change.
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
without it. It needs a verified wallet (`spark_pubkey_verified_at` is set),
because recovery is proven against that wallet key.

Recovery checks the old 12 words, not the shares. So it also works with 12
words the owner wrote down, and for an account that never set up shares.
Whoever holds the 12 words can take the whole account at once, not only the
wallet. The app says so wherever it shows the 12 words. Whether recovery is
limited to accounts that completed setup is an [open point](#open-points).

## Setting it up

The owner opens **Mein Konto absichern** and chooses two people. Setup may
happen remotely, for example with the QR code shown in a video call.

1. The owner's phone derives the 12 words as today and opens the wallet with
   them. If its identity public key is not the account's verified
   `spark_pubkey`, setup stops.
2. The phone splits the 16 bytes into three shares. Before any share leaves
   the phone, it checks that each of the three pairs gives the same 16 bytes.
3. The owner's phone shows share 1 as a QR code. Person 1 scans it in the
   21.gifts app, which keeps it on that phone under the owner's name and the
   share's SLIP-39 identifier.
4. The same for share 2 and person 2. A phone that already holds a share with
   the same identifier refuses the second one, so one phone never holds two
   shares of one set.
5. Share 3 goes to 21.gifts as described under [Open points](#open-points).

Remotely, both shares are never shown over the same call or service, and the
call is not recorded: anyone who captures two shares can recover the account.

Choosing other people later means a new setup with three new shares. Shares
are not edited in place.

## Recovery

Recovery needs each person to meet the owner **in person**. The owner has a
new phone with the 21.gifts app.

1. The owner taps **Account über Social Recovery wiederherstellen**.
2. The owner's new phone scans the QR code of person 1.
3. It scans the QR code of person 2.
4. The app puts the 16 bytes back together, derives the old 12 words, opens
   the old wallet with them and reads its identity public key. It starts a
   recovery ceremony with that key, next to the existing register, replace
   and seed passkey ceremonies. The server finds the account whose verified
   `spark_pubkey` equals the key and returns the account id and WebAuthn
   creation options for it: the relying party, `user.id` the account id, the
   PRF salt as for a seed passkey, and a challenge stored like every passkey
   challenge, with a new ceremony type `recovery` and the same
   `CHALLENGE_TTL_MS` window. No account is found for an unverified or unknown
   key.
5. The app creates the new passkey with those options, derives the new 12
   words from it and opens the new wallet. The new passkey is not linked to
   the account yet.
6. One button, **Übertragen**, does the rest in this order:
   1. **Account.** The old wallet signs the recovery message (`signMessage` in
      the Breez SDK). The app finishes the recovery ceremony with the
      attestation of the new passkey and the signature. The server checks them
      and transfers the account.
   2. **Lightning address.** The old wallet authorizes the transfer of the
      Lightning address to the new wallet's identity key
      (`authorizeLightningAddressTransfer`), and the new wallet claims it
      (`claimLightningAddressTransfer`) through the forwarded LNURL routes
      (`src/routes/lnurl-server.ts`). The account already holds the new key,
      so their gate passes, and the LNURL server's acceptance marks the new
      key verified as for a registration today.
   3. **Balance.** The old wallet sends its whole balance to the new wallet,
      if the balance is above 0.

Step 6.1 is the only step that changes the account. It runs first: if it
fails, nothing has changed and nothing has moved.

### The recovery message

UTF-8, five lines, a newline between the lines, no trailing newline:

```text
21gifts-account-recovery-v1
<account id>
<challenge of this recovery ceremony, base64url as issued>
<new passkey credential id, base64url>
<new wallet identity public key, lowercase hex>
```

The server accepts it only when:

- the public key returned by `signMessage` equals the account's verified
  `spark_pubkey`,
- the signature verifies for that key and this exact message,
- the challenge is the stored `recovery` challenge for this account, not
  consumed, and inside `CHALLENGE_TTL_MS`,
- the attestation of the new passkey verifies with that challenge as the
  expected challenge, the expected origin and relying party, user
  verification, and that credential id, as the seed passkey finish does.

Then, in one transaction, the server:

- stores the new passkey credential,
- deletes every other passkey credential, every session and every push
  subscription of the account,
- keeps the old `spark_pubkey` and `spark_address` as the account's
  **previous wallet**,
- stores the new identity key as `spark_pubkey`, not yet verified, and its
  `spark_address`,
- consumes the challenge.

The username stays and cannot change until the new key is verified in step
6.2. On any failure nothing changes, and the old passkey credentials stay.

### If not everything succeeds

The button can be pressed again while the app still holds the old words in
memory. Once the app is closed, the words are gone.

- **Step 6.1 failed.** Nothing changed. Recovery runs again from step 1. The
  passkey created in step 5 is unused and can be deleted from the phone.
- **Step 6.2 or 6.3 failed.** The account already belongs to the new passkey,
  so the owner is signed in. The settings show the previous wallet and a
  button **Restguthaben übertragen**. It needs the two QR codes again, opens
  the old wallet and repeats steps 6.2 and 6.3 only. Before the scan, the
  balance is read live from the public Spark explorer API by the previous
  `spark_address`, and shown as unknown when that is not reachable. After the
  scan, the app shows the old wallet's own balance. Payments that reach the
  old wallet later are swept the same way.

The previous wallet is dropped when its balance is 0, the Lightning address
has moved and the owner confirms. An old key never moves the account again:
step 4 only finds an account by its current verified key.

## After recovery

The old shares rebuild only the old wallet. They stay on the people's phones
until the previous wallet is dropped, because **Restguthaben übertragen**
needs them. The app asks the owner to set up new shares for the new 12 words,
with the same or other people. A person's phone keeps the new share next to
the old one, told apart by the SLIP-39 identifier, and deletes the old share
when the owner drops the previous wallet.

## What the server stores

No 12 words, no 16 bytes, no share and no PRF output, in no row and no log.

- The new passkey credential, as for any passkey.
- `spark_pubkey` and `spark_address` of the current and, until it is dropped,
  the previous wallet.
- The recovery challenge, stored as a passkey challenge of type `recovery`.

## Security

- **Two people together** can recover the account and move the wallet at
  once. The owner chooses them knowing this.
- **One person** cannot. A single share reveals nothing, and a phone refuses
  a second share of the same set.
- **Whoever holds the 12 words** can recover the account, with or without
  shares. Written-down words need the same care as the wallet itself.
- **The server alone** cannot. It holds no readable share and cannot sign
  with the wallet key.
- **21.gifts and one person** can, through the manual backup process only.
- **A stranger with a fake QR code** has to stand in front of the person,
  because recovery happens in person.
- **A recorded remote setup** can leak shares. Both shares never go over the
  same call or service, and setup calls are not recorded.
- **A replayed signature** is refused: the message binds the account, a
  single-use challenge, the new passkey and the new wallet key.
- **The lost phone** loses its sessions and push subscriptions, so it gets no
  more private messages.

## Open points

- **Recovery without setup.** Recovery works for any account with a verified
  wallet, so 12 words alone take the account. Whether step 4 accepts only
  accounts that completed setup (a per-account flag that names no people) is
  not decided.
- **21.gifts share custody.** Proposal: the owner's phone seals share 3 to a
  21.gifts offline public key that ships with the app, so the running api can
  never read it. Where the ciphertext lives, who at 21.gifts may open it
  (four eyes), how the requester and the participating person are identified,
  and how the share reaches the new phone (by QR code) are not decided.
- **Where a person keeps their share.** The app keeps it in browser storage,
  which a browser can delete (for example Safari's limit for sites that are
  not installed, or "clear website data"). A printed QR code as a second copy
  and a reminder in the app are proposed.
- **Remote setup.** A QR code shown in a video call can be swapped. A short
  confirmation code that both phones show is proposed.
- **Signature scheme.** `signMessage` returns `{ pubkey, signature }` and has
  a matching `checkMessage`. The exact scheme (message hashing, compact or
  DER signature) must be pinned with a test vector before the server
  verifies it.
- **Lightning address claim.** Which LNURL server path
  `claimLightningAddressTransfer` uses, and that the forwarded LNURL routes
  pass it, must be checked against the LNURL server.
- **Previous wallet on the forwarded LNURL routes.** When the old wallet is
  opened again for **Restguthaben übertragen**, the Breez SDK may look up its
  own address through those routes. Their gate accepts only the account's
  current key (`isSparkPubkeyClaimed`), so it must also accept the previous
  wallet key until that wallet is dropped.
- **Accounts with both a login passkey and a seed passkey.** Setup already
  checks that the words match the verified wallet. Step 6.1 removes both old
  credentials.

## Acceptance criteria for a later implementation

- Each pair of the three shares rebuilds the original 16 bytes and 12 words.
  One share does not.
- Setup stops when the 12 words do not open the account's verified wallet.
- A phone refuses a second share with the same SLIP-39 identifier.
- A person's share never appears in a request to the api.
- The api has no path that reads, returns or uses the 21.gifts share.
- Recovery without a valid signature by the account's verified `spark_pubkey`
  changes nothing.
- A used or expired challenge is refused.
- A successful step 6.1 leaves exactly one passkey credential, no old
  session, no push subscription, the new wallet key as `spark_pubkey`, and the
  old key as the previous wallet.
- After step 6.2 the new key is verified, and the username and the Lightning
  address are the same as before.
- The old key cannot start a second account transfer.
- No row and no log contains the 12 words, the 16 bytes, a share or PRF
  output.

## Out of scope here

- Any route, table, screen or migration.
- Splitting the passkey private key.
- On-chain multisig. This is Shamir secret sharing of the seed.
- Requiring **Mein Konto absichern** for sign-up, login or any other use.
- Moving funds of an external Lightning wallet.
