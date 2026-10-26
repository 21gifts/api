# Securing the account

Status: **concept only**. Decided 2026-10-27. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

This replaces the design of 2026-09-29 and 2026-09-30 (two required people, a
48-hour wait, a server-side bind key and a seed wrap). None of those parts
remain.

## What recovery does

An owner who lost their passkey gets two things back:

1. **The same account.** The account id stays, and with it the username, the
   Lightning address `<username>@<host>`, the profile, the notes and the
   history. Only the passkey and the wallet key change.
2. **The original 12 words.** They are put back together on the new phone and
   used once to move the whole wallet balance to the new wallet.

After recovery the account has a new passkey with its own new 12 words. A
passkey cannot take a given seed: the app derives the 12 words from the PRF
output of exactly one passkey (`src/lib/prf-mnemonic.ts` in the app, see
[CONCEPT.md](../CONCEPT.md)). So the old words cannot follow the account to the
new passkey. They open the old wallet for the move and are then discarded.
Nothing stores them.

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

- A person's share never reaches the 21.gifts server, sealed or not. The
  server stores nothing about who protects whom.
- The 21.gifts share is a backup only. The api never reads, releases or uses
  it. Using it is a manual 21.gifts process.
- Any two holders act at once. There is no waiting period and no cancel
  window. Person 1 and person 2 together can recover the account and move the
  wallet without the owner. The owner is told this before choosing them.

## Who can use it

Securing the account is optional. Sign-up, login and every other use work
without it. It is offered only to an account with a verified wallet
(`spark_pubkey_verified_at` is set), because the account transfer below is
proven against that wallet key.

## Setting it up

The owner opens **Mein Konto absichern** and chooses two people. Setup may
happen remotely, for example with the QR code shown in a video call.

1. The owner's phone derives the 12 words as today and splits the 16 bytes
   into three shares. Before any share leaves the phone, it checks that each
   of the three pairs gives the same 16 bytes.
2. The owner's phone shows share 1 as a QR code. Person 1 scans it in the
   21.gifts app, which keeps it on that phone under the owner's name.
3. The same for share 2 and person 2.
4. Share 3 goes to 21.gifts as described under [Open points](#open-points).

Choosing other people later means a new setup with three new shares. Shares
are not edited in place.

## Recovery

Recovery needs each person to meet the owner **in person**. The owner has a
new phone with the 21.gifts app.

1. The owner taps **Account über Social Recovery wiederherstellen**.
2. The owner's new phone scans the QR code of person 1.
3. It scans the QR code of person 2.
4. The app puts the 16 bytes back together, derives the old 12 words, opens
   the old wallet with them and reads its identity public key. It calls the
   recovery endpoint with that key. The server finds the account whose
   verified `spark_pubkey` equals it and returns a fresh, single-use
   challenge with a short expiry. No account is found for an unverified or
   unknown key.
5. The app creates a new passkey for this account, derives the new 12 words
   from it and opens the new wallet. The new passkey is not linked to the
   account yet.
6. One button, **Übertragen**, does three things together:
   1. The old wallet sends its whole balance to the new wallet, if the balance
      is above 0.
   2. The old wallet authorizes the transfer of the Lightning address to the
      new wallet's identity key (`authorizeLightningAddressTransfer` in the
      Breez SDK), and the new wallet claims it
      (`claimLightningAddressTransfer`).
   3. The old wallet signs the recovery message (`signMessage` in the Breez
      SDK). The server checks it and transfers the account.

The account transfer in step 6.3 is the only step that changes the account.
The app runs it last, so the account moves after the wallet has moved.

### The recovery message

UTF-8, five lines, a newline between the lines, no trailing newline:

```text
21gifts-account-recovery-v1
<account id>
<challenge, lowercase hex>
<new passkey credential id, base64url>
<new wallet identity public key, lowercase hex>
```

The server accepts it only when:

- the public key returned by `signMessage` equals the account's verified
  `spark_pubkey`,
- the signature verifies for that key and this exact message,
- the challenge was issued for this account, is unused and has not expired,
- the request carries a valid attestation of the new passkey with that
  credential id, user verification required, and the user id equal to the
  account id.

Then, in one transaction, the server:

- stores the new passkey credential,
- deletes every other passkey credential and every session of the account,
- keeps the old `spark_pubkey` and `spark_address` as the account's
  **previous wallet**,
- stores the new identity key as `spark_pubkey` and its `spark_address`,
- marks the challenge used.

The new key counts as verified once the LNURL server has accepted the claimed
Lightning address, as it does today for a registration. The username stays.
On any failure nothing changes, and the old passkey credentials stay.

### If not everything succeeds

The button can be pressed again while the app still holds the old words in
memory. Once the app is closed, the words are gone.

- **The account did not move.** The two QR codes are scanned again and
  recovery runs again from step 1.
- **The account moved, but the balance or the Lightning address did not.** The
  settings show the previous wallet with its balance and a button **Restguthaben
  übertragen**. It needs the two QR codes again and then repeats steps 6.1 and
  6.2 only. The balance is read live from the public Spark explorer API by the
  previous `spark_address`, and the last reported `wallet_balance_snapshot`
  is shown with its date when that is not reachable. Payments that reach the
  old wallet before the Lightning address moved are swept the same way.

The previous wallet is dropped when its balance is 0 and the owner confirms.
An old key is never used to move the account again: after recovery, step 4
only finds an account by its current verified key.

## After recovery

The old shares now rebuild only the old wallet, which is empty once moved.
The app asks the owner to set up new shares for the new 12 words, with the
same or other people.

## What the server stores

No 12 words, no 16 bytes, no share and no PRF output, in no row and no log.

- The new passkey credential, as for any passkey.
- `spark_pubkey` and `spark_address` of the current and, until it is dropped,
  the previous wallet.
- Recovery challenges: random value, account id, expiry, used flag.

## Security

- **Two people together** can recover the account and move the wallet at
  once. The owner chooses them knowing this.
- **One person** cannot. A single share reveals nothing.
- **The server alone** cannot. It holds no readable share and cannot sign
  with the wallet key.
- **21.gifts and one person** can, through the manual backup process only.
- **A stranger with a fake QR code** has to stand in front of the person,
  because recovery happens in person.
- **A replayed signature** is refused: the message binds the account, a
  single-use challenge, the new passkey and the new wallet key.

## Open points

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
- **Lightning address transfer.** Which path of the self-hosted LNURL server
  the claim uses, and that the api's LNURL relay forwards it, must be checked.
- **Accounts with both a login passkey and a seed passkey.** Which words are
  protected, and that step 6.3 removes both old credentials, must be stated
  for that case.

## Acceptance criteria for a later implementation

- Each pair of the three shares rebuilds the original 16 bytes and 12 words.
  One share does not.
- A person's share never appears in a request to the api.
- The api has no path that reads, returns or uses the 21.gifts share.
- Recovery without a valid signature by the account's verified `spark_pubkey`
  changes nothing.
- A used or expired challenge is refused.
- A successful recovery leaves exactly one passkey credential, no old
  session, the new wallet key as `spark_pubkey`, and the old key as the
  previous wallet.
- The username and the Lightning address stay the same.
- The old key cannot start a second account transfer.
- No row and no log contains the 12 words, the 16 bytes, a share or PRF
  output.

## Out of scope here

- Any route, table, screen or migration.
- Splitting the passkey private key.
- On-chain multisig. This is Shamir secret sharing of the seed.
- Requiring **Mein Konto absichern** for sign-up, login or any other use.
- Moving funds of an external Lightning wallet.
