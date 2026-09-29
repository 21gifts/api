# Social recovery of the seed

Status: **concept only**. Decided 2026-09-29. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

This is the third recovery path named in `CONCEPT.md`. It applies only to the
non-custodial phase, after an account holds one user-owned Nostr key derived
from its seed. It does not migrate the v1 custodial `nsec`, and it does not
decide Open Question #9.

## Decision

Friends replace the paper copy of the seed. They do not replace the phone, and
they do not hold the passkey.

Daily login stays a passkey. Friends are involved only when the seed itself
must be reconstructed. They act together, on purpose, and only toward the new
device. One friend is not enough.

The server stores ciphertext and account bookkeeping. It is not a guardian, not
a co-decryptor, and not the source of the public keys that shares are encrypted
to. If the encrypting device trusts a public key because the api returned it,
the server is the recipient and can read every share. Ciphertext-only storage
would then be false. That failure is forbidden below.

## What is recovered

The secret is the **128-bit BIP-39 entropy** that the client already derives
and never sends:

1. WebAuthn PRF `eval.first`, with salt = SHA-256 of the UTF-8 string
   `21gifts-nostr-v1`.
2. HKDF-SHA-256, salt = UTF-8 `21gifts-seed-derivation`, info = UTF-8
   `mnemonic-v1`, output length 128 bits.

Those 16 bytes are the master secret. BIP-39 English encoding of those bytes
is the twelve-word phrase. The target identity, still client-side, is NIP-06:
BIP-39 seed, then BIP-32 at `m/44'/1237'/0'/0/0`, then the secp256k1 Nostr key.
The same 16 bytes are the root for any later wallet derived from that phrase.

Social recovery reconstructs **those 16 bytes**. It does not create a new
identity. After a correct reconstruction, the twelve words and the `npub` match
what the original passkey's PRF produced.

`mnemonic-v1` is frozen. This concept does not change the salt, the info
string, the length, or the PRF label.

## What is not recovered

- **The passkey.** The passkey private key never leaves the authenticator.
  There is no share of it. A new passkey after recovery is a new door onto the
  same seed. Its own `mnemonic-v1` output is a different seed and must not be
  shown or used as the identity.
- **The v1 custodial `nsec`.** The api generates that key and stores it
  encrypted at rest. The client does not hold it, so friends cannot be given a
  share of it. Forum history signed by the custodial key stays on that key
  until the separate migration in Open Question #9. Recovery proves the
  user-held `npub` only.
- **Wallet of Satoshi.** The Lightning address is a string on the account, not
  a key derived from the seed. Logging in again shows the same string. The
  balance lives in that wallet's own custody. Friends do not recover it.
- **A server session.** Sessions stay passkey-backed bearer tokens. Recovery
  does not mint a session until a new passkey has been bound.
- **Bitcoin held by 21.gifts.** The service does not hold it.

## Prerequisites

All of the following are required before enrollment. If any is missing, the
client stops. The server-side flags are consistency checks, not the trust root.

- The owner's seed unlocks on this device (PRF `mnemonic-v1`, or an existing
  wrap as defined below). The twelve words are known to the client and are not
  uploaded.
- The owner's user-held secret is the NIP-06 key of that entropy. The device
  derives the `npub` locally.
- `nostr_key_custody` for the owner is `user`, and the stored `nostr_pubkey`
  equals that locally derived `npub`. A mismatch aborts. A custodial row cannot
  enroll.
- Each guardian is another 21.gifts account whose device can sign with **its
  own** user-held NIP-06 key. A custodial account cannot be a guardian, because
  its device cannot sign without the server.
- The owner's device encrypts each share only to a guardian public key it
  received from that guardian's device (scanned or pasted), and only after it
  has verified a signature from that key. Seeing `nostr_pubkey` in an api
  response is not enough. If the scanned key and the stored pubkey differ,
  abort. The account record and the person in front of the device must be the
  same key.
- The authenticator used to persist a wrap supports PRF. Missing PRF aborts,
  as registration already aborts. The api still never receives PRF output.

Platform passkey sync (iCloud Keychain, Google Password Manager, and a hardware
authenticator that syncs) remains recovery path 1. The written twelve words
remain recovery path 2. Social recovery is path 3, optional, and of the same
entropy. None of the three replaces the others. Losing all three loses the
seed. A new passkey does not bring it back.

## Guardians and threshold

One Shamir group only. No second group, no "family and friends" composition,
no passphrase in this version. A memorised passphrase would stop colluding
guardians, and it would also lock out the person who forgot it. This path is
for someone who has already lost the device. The passphrase is deferred.

| Parameter                               | Rule              |
| --------------------------------------- | ----------------- |
| `n`                                     | 2 to 5 guardians  |
| `t`                                     | 2 to `n`, never 1 |
| Default offered                         | 2 of 3            |
| Shares one account may hold as guardian | at most 20        |
| Active share sets per owner             | one               |

`t = 1` is forbidden. One guardian must not be able to reconstruct the seed.
`t = n` is allowed and is a bad default: one unavailable guardian blocks
recovery. The product offers 2 of 3 and lets the owner raise or lower only
inside the table.

A guardian is a person with an account, not an email address and not a phone
number. The owner sees every guardian's name. Each guardian sees the owner's
name and, during a recovery, the count of approvals (`2 of 3`). A guardian does
not see the other guardians' names.

An account with `session_refused` cannot enroll, guard, or recover.

## Share construction

Normative sharing format: **SLIP-39** (SatoshiLabs SLIP-0039), used only as the
container for the 16-byte entropy.

- Master secret: exactly those 16 bytes. Not the twelve-word string. Not the
  64-byte BIP-39 seed. Not the Nostr private key. Not the PRF output.
- One group. Group threshold 1. Group count 1.
- Member threshold `t`. Member count `n`.
- Empty passphrase.
- Iteration exponent 0, as SLIP-39 defines it.
- A 128-bit master secret under those parameters is a 20-word SLIP-39 mnemonic
  per guardian. That word list is not the BIP-39 list. Guardians do not see it
  unless they explicitly export.

After reconstruction the client **stops**. It must not run SLIP-39's conversion
of the master secret into a BIP-32 seed. That conversion would produce a
different `npub` from NIP-06. The client BIP-39-encodes the 16 bytes with the
English wordlist and, when it needs the Nostr key, follows NIP-06.

A future implementation must pass SLIP-39's published test vectors for a
128-bit master secret, one group, empty passphrase, and iteration exponent 0,
and must then assert that BIP-39(master secret) equals the phrase
`mnemonic-v1` produced from the original PRF.

Each stored share is NIP-44 version 2, encrypted to the guardian's 32-byte
x-only public key. Plaintext before encryption:

- one version byte `0x01`
- the UTF-8 SLIP-39 mnemonic: twenty words, single ASCII spaces, no trailing
  newline

NIP-44 padding and the conversation key are the NIP-44 v2 rules. No second
encryption scheme. The client uses the secp256k1 library the non-custodial
phase already calls for. WebCrypto does not perform this ECDH.

The SLIP-39 identifier is the set id. Shares from two enrollments must not
combine. Reconstruction rejects a set whose identifier, threshold, or member
count disagrees.

## Key transport

Two public keys move between devices. Neither is taken from the api.

**Guardian key, at enrollment.** The guardian's device derives its user-held
secret locally (PRF or its own wrap), signs, and displays the x-only pubkey
together with the signature. The owner's device scans or pastes that payload.
It verifies the signature itself. It encrypts that guardian's share only to
that pubkey. The api is then asked whether the account's stored pubkey is
equal. Unequal means abort and upload nothing. The api value is a consistency
check against the wrong profile. It is never the key that is encrypted to.

The signed message is the UTF-8 string

```text
21gifts-guardian-v1
<owner account id>
<guardian x-only pubkey, lowercase hex>
<nonce, lowercase hex>
```

with a newline between the four lines and no trailing newline. The signature
is BIP-340 Schnorr over the SHA-256 of that string, from the guardian's NIP-06
key. The nonce is 32 random bytes from the owner's device, shown on the same
QR the guardian signs, so the api cannot choose the nonce either. The guardian
signs only a nonce its device scanned from the owner.

**Ephemeral key, at recovery.** The new device generates a secp256k1 keypair
and keeps the secret in memory. It shows the x-only pubkey as a QR and as
lowercase hex. Each approving guardian scans or pastes that pubkey from the
recovering device, or from a copy the owner sent through some channel that is
not this api. The guardian encrypts the decrypted share to that scanned key
and uploads only the new ciphertext.

The session record may store the pubkey the new device announced. That copy is
for humans to notice a mismatch. A guardian client must refuse to encrypt to a
pubkey that arrived only inside the session payload. A later test of the client
feeds the session pubkey alone and expects no upload.

A short code of 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` identifies
the session to a person. It is not a key, not a secret, and not sufficient to
approve. Approval without the scanned ephemeral pubkey does nothing.

In person is the normal handoff. A remote guardian works only if the owner
conveys the ephemeral pubkey outside this service. The service must not offer
"use the key on the session" as a shortcut.

## Enrollment

Enrollment happens on a device that can already unlock the seed. Order:

1. The owner chooses `n` and `t` inside the rules above, and chooses that many
   guardian accounts.
2. For each guardian, the two devices exchange the nonce and the signed pubkey
   as specified above. The owner verifies. A stored-pubkey mismatch aborts the
   whole enrollment.
3. The owner builds one SLIP-39 set locally and encrypts each share to the
   verified pubkey. Plaintext shares exist only in that device's memory.
4. Each guardian's device stores the ciphertext **locally**, decrypts it once,
   checks that the SLIP-39 identifier matches the set the owner just committed
   to, discards the plaintext, and signs a readable-proof with the same
   guardian key. Enrollment is incomplete until every guardian has done this.
   The local copy is what still exists if this service disappears.
5. The owner uploads the `n` ciphertexts, `t`, `n`, and the SLIP-39 identifier.
   The api stores them against the owner and the guardian accounts. It cannot
   read them.
6. The owner reconstructs from the local shares before uploading, derives the
   `npub`, and aborts with no upload if it does not match the account.

The readable-proof message is UTF-8

```text
21gifts-guardian-readable-v1
<owner account id>
<SLIP-39 identifier, lowercase hex>
<guardian x-only pubkey, lowercase hex>
```

same newline rules, BIP-340 over SHA-256, guardian NIP-06 key. The api checks
the signature against the pubkey the owner bound to that share. A guardian who
cannot decrypt cannot produce this proof. The proof is not a substitute for the
in-person key exchange: the server could sign for a key it owns if the owner
had encrypted to a server-supplied key. The scan is what prevents that.

Replacing a share set is the same ceremony. The new set is written and the old
ciphertexts are deleted in one step. Open recovery sessions for that owner are
cancelled. A guardian who exported words earlier still holds that export.

## What the server may store

No row contains entropy, a mnemonic, PRF output, a share plaintext, a wrap key,
or an `nsec`. Logs and diagnostics follow the same ban.

Conceptual records, not a schema migration:

**Share set.** Owner account id. SLIP-39 identifier. `t`. `n`. Status
`active` or `degraded`. Created time.

**Share.** Share-set id. Guardian account id. Guardian x-only pubkey (the one
the owner verified, stored so later signatures have a comparison point, never
used by a client as the encryption target). NIP-44 ciphertext. Time the
readable-proof succeeded.

**Wrap.** Owner account id. Opaque blob, at most 128 bytes. For version 1 the
blob is exactly 45 bytes: version `0x01`, 12-byte AES-GCM nonce, 16-byte
ciphertext, 16-byte tag. Absent while `seed_root` is `prf`.

**`seed_root`.** `prf` or `wrapped`. Default `prf`, including every account
that already exists when this ships. Visible to the signed-in owner. Not shown
on a public profile. `prf` means the identity is `mnemonic-v1` of the current
seed-bearing passkey. `wrapped` means the identity is the unwrap of the wrap
blob, and `mnemonic-v1` of the current passkey must not be displayed.

**Recovery draft.** Ephemeral x-only pubkey announced by a new device. Short
code. Created time. Expires 15 minutes after creation. No account yet. Not an
encryption instruction for guardians.

**Recovery session.** Owner account id. Mode `friends` or `paper`. Announced
ephemeral pubkey. Short code. Status `pending`, `ready`, `completed`,
`cancelled`, or `expired`. Created time. Ready time. The announced pubkey is
not the guardian's encryption input.

**Approval.** Session id. Guardian account id. NIP-44 ciphertext encrypted to
the ephemeral key the guardian scanned. Created time.

`wallet_required` stays the existing flag meaning "a seed-bearing ceremony has
happened". It is not `seed_root`. Recovery does not clear
`wallet_backup_seen_at`.

## Recovery session

A new device generates the ephemeral keypair first and registers a draft (the
pubkey and a short code). Drafts are unauthenticated and expire after 15
minutes. Creation is rate-limited per caller so drafts cannot be used to flood
the service.

Binding a draft to an account creates a session:

- **By username.** The new device sends the public username. Unknown username
  is a not-found response. Usernames are already public. This only names the
  account. It does not release a share.
- **With a guardian present.** A signed-in guardian selects the owner from the
  accounts whose share they hold, and submits the draft's short code. The
  session is bound to that owner. The guardian still scans the ephemeral pubkey
  separately before any share is re-encrypted.

At most 3 sessions may be created for one account in any rolling 24 hours.
Pending sessions do not block each other. One hostile start must not occupy
the only slot until expiry. The first session that completes cancels the
others.

Friends mode becomes `ready` at the later of: 48 hours after creation, and the
moment the `t`-th distinct guardian approval is stored. Paper mode becomes
`ready` 48 hours after creation and needs no approvals. A session that is not
`completed` or `cancelled` becomes `expired` 7 days after creation. Expired and
cancelled sessions cannot be completed. Approvals that arrive late are kept
and ignored.

The 48 hours run even if every guardian approves in the first minute. An owner
who still has a passkey uses that time to cancel. Being logged in does not
skip the wait. The only instant path to the seed is the original PRF
derivation, or an unwrap with the passkey that already wraps it. Any path that
reconstructs the seed from friends or from paper waits.

Guardians and the owner's existing push subscriptions are notified that a
recovery started, with the owner's display name and the short code. The
payload has no share, no mnemonic, and no ephemeral pubkey. Cancellation
notifies the same people. The new device polls. It is not assumed to have a
push subscription.

## Paper words

The twelve words are a full copy of the same 16 bytes, not a second factor on
top of the friends. Whoever holds the words holds the identity. They can import
them into any NIP-06 client without this service.

Rebinding a passkey from paper uses the same delay and the same bind
submission as friends mode, with mode `paper` and no approvals. The words are
typed into the new device and are not sent. The device derives the `npub`
locally, opens the session for that account, waits 48 hours, and signs the
bind challenge. Guardians are notified so they can warn the owner. A passkey
the owner still has can cancel the session.

Friends are not required to use the words. The words are not required to use
friends. Either one reconstructs the same secret.

## Binding a new passkey

The current replace routes stay a refusal (`A recovery phrase cannot be
replaced`). Replace swaps the credential and would orphan a PRF-derived seed.
Recovery is not replace.

When a session is `ready`, the new device submits one bind. The client has
already reconstructed or typed the entropy, checked the `npub`, created a
passkey, read PRF, and built the wrap. If PRF is missing, the client does not
submit.

The submission carries:

- the session id
- a WebAuthn attestation for a new passkey whose user id is the account id,
  user verification required, resident key required
- a BIP-340 signature by the recovered NIP-06 key over the bind challenge
- the wrap blob

The bind challenge is UTF-8

```text
21gifts-recovery-bind-v1
<session id>
<announced ephemeral x-only pubkey, lowercase hex>
```

same newline rules. The server's challenge nonce is the session id plus the
announced pubkey, so the signature is bound to this session. The signature is
over SHA-256 of that string.

The api accepts the bind only when all of these hold:

- the session is `ready` and belongs to this account
- `nostr_key_custody` is `user`
- the signature verifies under the stored `nostr_pubkey`
- the attestation verifies for this relying party, user verification was
  required, and the credential id is not stored for a different account
- the body does not contain PRF results (same rejection as authentication)
- the wrap blob is at most 128 bytes

The api cannot see whether the authenticator returned PRF. The client hard-fail
is the same rule as registration today.

On success, in one transaction: store the new credential, delete every other
passkey credential for the account, store the wrap, set `seed_root` to
`wrapped`, leave `wallet_required` true, mark the session `completed`, cancel
sibling sessions. On failure, store nothing from the submission and leave the
session `ready` until it expires, so the device can try again.

Deleting the old credential stops that passkey from logging in. It does not
erase the PRF secret inside the lost authenticator. Someone who can still pass
that device's user verification can still derive the seed locally. Recovery
does not pretend to remote-wipe it.

## The wrap

The wrap exists so a passkey created after recovery can unlock the **old**
entropy. The new passkey's PRF is an encryption key, not a new root.

- IKM: the new passkey's PRF `eval.first` (32 bytes).
- HKDF-SHA-256, salt = UTF-8 `21gifts-seed-derivation` (the same salt
  `CONCEPT.md` already uses for domain separation), info = UTF-8
  `seed-wrap-v1`, output 256 bits.
- AES-256-GCM. Nonce: 12 random bytes, stored in the blob. Additional data:
  the UTF-8 account id, so a blob cannot be moved to another account.
- Plaintext: the 16-byte entropy, nothing else.

`seed-wrap-v1` must not equal `mnemonic-v1`. The wrap key is not the phrase.
The client that just built a wrap decrypts it before uploading and checks the
16 bytes. A mismatch aborts with no bind.

While `seed_root` is `prf`, there is no wrap. Showing the phrase evaluates PRF
and runs `mnemonic-v1`, as today. While `seed_root` is `wrapped`, showing the
phrase evaluates PRF, derives the wrap key, decrypts the blob, and BIP-39-encodes
the 16 bytes. If the authenticator returns no PRF, the phrase stays locked.
The client must not fall back to `mnemonic-v1` of that PRF-less login, and must
not invent words.

Login itself stays the discoverable passkey assertion. It does not require the
wrap. A passkey can sign the user in and still fail to unlock the seed. The
interface says so. It does not create a second account to "fix" it.

## Rotation, resignation, and a degraded set

While the owner can unlock the seed, they may run enrollment again. That
replaces the set. They may also remove one guardian and add another, which is
the same full reshare: Shamir shares are not edited in place.

A guardian may resign. Resignation deletes that share's server ciphertext and
asks that guardian's device to delete its local copy. An export the guardian
already wrote down cannot be deleted. The owner is told this at enrollment,
before any guardian is added: resignation is social, export is not.

If the number of remaining shares drops below `t`, the set is `degraded`. A
degraded set cannot open a friends-mode session. The owner repairs it by
resharing while they still have the seed. If they no longer have the seed and
the set is degraded, friends-mode recovery is over. Paper and the original
passkey's PRF are the remaining copies.

A guardian who loses their own seed can recover it through their own guardians
or their own paper. The share stays encrypted to the same `npub`, so it becomes
readable again when that guardian can sign with that same key. A guardian who
starts a **new** identity (a new `npub`) does not regain the share. The owner
must reshare. This concept does not transfer shares across a guardian's
identity change.

## Cancellation

A passkey login for the owner cancels any named session, or all pending and
ready sessions, immediately. No delay. Cancellation is the owner's defence
during the 48 hours.

The new device can abandon its own session before completion. Abandoning
discards the ephemeral secret. Ciphertexts encrypted to it become useless.
The guardian's original share is untouched.

## Threat model

| Threat                                                  | What holds                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server reads stored shares                          | It cannot. It never receives plaintext, and it does not choose the recipient key. A client that encrypts to an api-supplied key is a broken client.                                                                                                 |
| One guardian reconstructs the seed                      | `t ≥ 2`. One share is not the entropy. SLIP-39's checksum rejects a forged companion share.                                                                                                                                                         |
| `t` guardians collude                                   | They can. They each hold a decryptable share. The delay does not stop them from reconstructing outside the service. The trust assumption is that fewer than `t` guardians will betray the owner.                                                    |
| A stranger starts a session                             | Username start only notifies people and waits. Shares move only after a guardian scans the new device's key. Paper completion needs the words. Rate limits bound the noise.                                                                         |
| Stolen paper                                            | The thief can open paper mode and, after 48 hours, bind a passkey, unless the owner still has a passkey and cancels. That is the same power as holding the identity.                                                                                |
| Stolen phone, biometrics not passed                     | PRF and the passkey stay inside the authenticator. Social recovery is not required.                                                                                                                                                                 |
| Stolen phone, biometrics passed                         | The thief already has the seed via PRF. Friends do not make that worse. Revocation after the real owner's recovery stops further login. It does not wipe the authenticator.                                                                         |
| Passkey syncs, PRF does not                             | Login works and the seed does not. Friends or paper reconstruct it. The bind then wraps it to a PRF-capable passkey. The synced passkey that has no PRF must not be the passkey that holds the wrap.                                                |
| This service disappears                                 | A guardian's local ciphertext, or an export of the SLIP-39 words, still reconstructs the entropy on a device that never talks to the api. The server copy is convenience, not the only copy. The wrap blob is not required for that reconstruction. |
| Malicious client offers "approve with the server's key" | Forbidden. Approval requires a scanned or pasted ephemeral pubkey.                                                                                                                                                                                  |
| Replay of an old bind signature                         | The signature covers the session id and the announced pubkey. Completed, cancelled, and expired sessions are rejected.                                                                                                                              |

Social recovery is not threshold signing. Guardians do not co-sign posts,
gifts, or Nostr events. FROST and account multisig are a different product:
friends would be online for ordinary use. That is out of scope.

The server is not a mandatory decryptor. Adding a server share so that friends
alone are not sufficient would let the service refuse a recovery. That breaks
the rule that a disappeared service must not take the key with it.

## State machine

```text
draft (15 min, no account)
        │ bind by username or by a guardian's short code
        ▼
     pending
        │ 48h elapsed, and t approvals if mode is friends
        ▼
      ready ────── owner passkey cancel, or device abandon, or sibling completed ──► cancelled
        │
        │ bind verifies
        ▼
    completed

pending or ready, 7 days after creation, not completed ──► expired
```

A degraded share set has no transition into `pending` for friends mode. Paper
mode does not consult the share set.

## Acceptance criteria for a later implementation

These are the checks a future change has to meet. This document does not add
them.

- Reconstructing a fresh SLIP-39 set of the `mnemonic-v1` entropy yields those
  same 16 bytes, and BIP-39 of them is the original twelve words.
- The NIP-06 `npub` of the reconstruction equals the `npub` of the original
  PRF. SLIP-39's BIP-32 derivation was not used.
- A client given only the api's copy of a pubkey uploads no share and no
  approval.
- A body that still contains PRF results is rejected on bind, as on login.
- `t = 1` cannot be stored.
- A custodial account cannot enroll and cannot be a guardian.
- Replace stays the existing refusal.
- `seed_root = wrapped` never displays `mnemonic-v1` of the current passkey.
- Server logs and the database contain no entropy, mnemonic, PRF output, share
  plaintext, wrap key, or `nsec`.
- Completing one session cancels the others. A cancelled session cannot bind.
- With the service unreachable, `t` exported SLIP-39 shares still produce the
  twelve words offline.

## Out of scope here

- Any route, table, client screen, or migration.
- Choosing how a custodial `nsec` becomes the user-held key, or how old forum
  events move. That remains Open Question #9. Social recovery starts only after
  one user-held `npub` is the account's key.
- A passphrase on the SLIP-39 set.
- More than one Shamir group.
- Threshold signatures, multisig wallets, and recovery of Wallet of Satoshi.
- Changing passkey login, the PRF label, or `mnemonic-v1`.
- Remote wipe of a lost authenticator.
