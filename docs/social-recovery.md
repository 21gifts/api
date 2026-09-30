# Account recovery after verification

Status: **concept only**. Decided 2026-09-30. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

This supersedes the 2026-09-29 text where the same shares were treated as a
future Nostr key. Recovery does two things, and nothing else:

1. The same 21.gifts account opens on a new device.
2. The same 12 seed words come back.

## Decision

When a moderator has verified a person in real life, that person gets three
recovery shares. Two are assigned. The person chooses only the third.

- The **verifier** is the moderator who verified them. That share is stored on
  the verifier's phone.
- **21.gifts** holds one share on the server. The service can read that one
  share. It cannot read the other two.
- The person chooses **one friend**. That share is stored on the friend's
  phone.

Two shares reconstruct the 16 bytes of the existing 12-word phrase. One share
does not. After the set is active, the verifier and 21.gifts together are
enough, without the friend. The friend and the verifier are enough if the
server is gone. The friend and 21.gifts are enough if the verifier is gone.

Daily login stays a passkey. The passkey private key is not one of these
shares and never leaves the authenticator. On the new device those 16 bytes
do only the two things above: they authorize one new passkey for this
account, and they are shown as the same 12 words.

## The 12 words

The words are the phrase the phone already derives and never sends. At the
verification meeting the owner's phone derives them again. It does not
generate a new secret.

1. WebAuthn PRF `eval.first`, salt = SHA-256 of the UTF-8 string
   `21gifts-nostr-v1`.
2. HKDF-SHA256, salt = UTF-8 `21gifts-seed-derivation`, info = UTF-8
   `mnemonic-v1`, 128 bits.
3. BIP-39 English, 12 words.

That derivation already exists. This document does not change it. The bytes
are the backup phrase. They are not uploaded, and they are not used for
anything besides the two results above.

Before any share is given out, the phone reconstructs the shares locally and
checks that BIP-39 of those bytes is the phrase it just derived. If not, it
stops.

## What this does not do

Anything other than opening the account on a new device and restoring those
words. The passkey private key is not split. A new passkey is a new door
onto the same account. Deleting the old credential on the server stops the
old passkey from logging in. It does not erase the secret inside a lost
phone. The phrase is not replaced with different words. No balance is
moved. Nothing is published.

## When the shares are created

`verified` stays a moderator confirming this person in real life. This
document does not change `POST /trust/verify` and does not reserve a new
route. The share ceremony happens at that same meeting, on the phones, and
is not a server-side side effect of the role change.

The owner's phone must be present and unlocked with the passkey. The
verifier's phone must be present. The phone derives the existing phrase
there.
If the ceremony does not finish, the person can still be `verified` and
simply has no recovery set. A later meeting can run the ceremony. A second
verification does not mint a second set while one exists.

The verifier and 21.gifts are not chosen. The only choice is the one friend.
The friend does not have to be in the room. Until that friend's phone has
stored its share, the set is **inactive** and the service has not been given
its share. The verifier may already hold one share from the meeting. One
share is not enough, and recovery cannot start.

## The three shares

One SLIP-39 group. Group count 1. Group threshold 1. Member count 3. Member
threshold 2. Empty passphrase. Iteration exponent 0. The master secret is
those 16 bytes. Reconstruction stops there, then BIP-39-encodes them. That
encoding is the original 12 words. Do not run SLIP-39's conversion of the
master secret into a BIP-32 seed. That would not be these words.

| Share | Who                             | Where the readable share lives                |
| ----- | ------------------------------- | --------------------------------------------- |
| 1     | The verifying moderator         | That moderator's phone                        |
| 2     | 21.gifts                        | The server, in a form the service can decrypt |
| 3     | The one friend the person chose | That friend's phone                           |

Any two of the three active shares reconstruct the secret. There is no
configuration of `t` or `n`. A threshold of 1 cannot be stored.

Each human share is sealed to an X25519 key that phone shows, as a QR or as
hex, to the owner's phone. The owner's phone does not take that key from
the api. The seal is a libsodium sealed box (`crypto_box_seal`: X25519,
XSalsa20-Poly1305). The plaintext is one version byte `0x01` followed by
the UTF-8 SLIP-39 mnemonic of that share (twenty words, single ASCII
spaces, no trailing newline). The api may store a copy of that ciphertext.
It has no key to open it.

The service share is sealed to the 21.gifts recovery public key shipped in
the client, not to a key taken from a response. The private key stays on
the server. Once the ciphertext has been uploaded, the server stores it
and can open that share alone. It must not write the opened share into a log, and it must not
store it beside another opened share.

The owner's phone checks, before anything is given out, that the three
local shares reconstruct the same 16 bytes. If they do not, it stops. No
phone receives a share, and nothing is uploaded.

## Enrollment order

1. The owner unlocks the phone. It derives the existing 16 bytes, builds
   the three SLIP-39 shares, and checks that BIP-39 of the reconstruction
   is the phrase it just derived.
2. The verifier's phone shows a fresh X25519 public key and an Ed25519
   public key, and signs the owner's 32-byte nonce with that Ed25519 key.
   The owner scans or pastes that payload and verifies the signature. A
   mismatch aborts the ceremony.
3. The owner seals share 1 to that X25519 key. The verifier's phone stores
   the ciphertext, opens it once, checks the SLIP-39 identifier, discards
   the plaintext, and signs a readable-proof with the same Ed25519 key.
4. The owner seals share 2 to the pinned service key and keeps that
   ciphertext on the owner's phone. It is not uploaded yet, and the
   owner's phone cannot open it. Share 3 is sealed to a key that stays
   on the owner's phone. The owner derives the Ed25519 bind public key
   from the 16 bytes and keeps that public key. The 16 bytes, the bind
   private key, and the other plaintexts are discarded. One remaining
   share on the owner's phone is not enough to reconstruct the secret.
5. The owner chooses one friend, at the meeting or later. The owner's
   phone opens share 3 and that friend's phone does step 2 and step 3
   for it. The owner's copy of share 3 is then discarded.
6. Only after the friend's readable-proof is stored does the owner's
   phone upload the service ciphertext, the Ed25519 bind public key, the
   SLIP-39 identifier, and the two human ciphertexts. The service then
   opens its share once, checks the identifier, stores the ciphertext,
   and discards the plaintext. Until this upload, the service does not
   have a share. The verifier alone is not enough, so recovery cannot
   be performed yet. The 16 bytes are not in the upload.

The nonce is generated on the owner's phone. The api does not choose it.
The signed enrollment message is UTF-8, four lines, a newline between the
lines, no trailing newline:

```text
21gifts-recovery-holder-v1
<owner account id>
<holder x25519 public key, lowercase hex>
<nonce, lowercase hex>
```

The signature is Ed25519 over the SHA-256 of that string. The readable-proof
uses the same rules over:

```text
21gifts-recovery-readable-v1
<owner account id>
<SLIP-39 identifier, lowercase hex>
<holder ed25519 public key, lowercase hex>
```

A holder who cannot open the seal cannot produce the proof. The proof is
not a substitute for the scan. The service share has no holder signature.
Its proof is that the service accepted the seal under the pinned key.

Replacing a set is the same ceremony and replaces all three shares in one
step. Shamir shares are not edited in place. Changing the friend, or
moving the verifier's share to a different phone, is a full replacement.
A later trust edge does not move the share. The verifier of the set is the
moderator whose phone was scanned, which is the moderator who verified
the person at that meeting.

A written export of a SLIP-39 share cannot be deleted. Resignation deletes
the server ciphertext and asks that phone to delete its local copy. The
owner is told this before the friend is added. After the set is active,
losing the friend's share does not remove the service share. The verifier
and 21.gifts remain a working pair. Replacing the friend is a new
ceremony, because the shares are not edited in place. The set becomes
inactive only when fewer than two shares remain.

## What the server may store

No row contains the 16 bytes, a share plaintext, PRF output, the 12-word
backup, or a passkey private key. Logs follow the same ban. The service
may decrypt its own share in memory while handling a recovery, and must
discard that plaintext when the handling ends.

Conceptual records, not a schema migration:

**Recovery set.** Owner account id. SLIP-39 identifier. Status `inactive`
or `active`. Ed25519 bind public key. Created time.

**Human share.** Set id. Holder account id (`verifier` or `friend`).
Ed25519 public key and X25519 public key the owner verified. Sealed
ciphertext. Time the readable-proof succeeded.

**Service share.** Set id. Sealed ciphertext. Time the service checked the
identifier.

The friend is a 21.gifts account so the app on that phone can store the
share and be asked to release it. The friend receives nothing else.
`session_refused` cannot enroll, hold a share, or recover.

## Recovery

A new phone generates an X25519 keypair and keeps the secret in memory.
It shows the public key as a QR and as lowercase hex, and it announces
the same public key on the recovery session. Two of the three shares
must be released. A human holder opens their share only for a key that
phone scanned from the new phone, and refuses a key that arrived only
inside a server payload. The service is not a holder and does not scan.
It opens its own share only for the announced public key, and only after
one human release names that same key. The server may store the announced
public key so a person can see a mismatch. It must not offer a human
"use the key on the session".

The short code is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
It names the recovery to a person. It is not a key and not sufficient to
release a share.

The new phone reconstructs the 16 bytes from the two released shares. It
derives the bind key locally and checks the signature against the stored
bind public key before uploading anything. A mismatch discards the
material and uploads nothing.

The bind private key is Ed25519. Its 32-byte seed is HKDF-SHA256 with
input keying material the 16 bytes, salt the UTF-8 string
`21gifts-account-recovery`, info the UTF-8 string `bind-v1`, and length 32. This key only authorizes
the new passkey.

The bind message is UTF-8, four lines, a newline between the lines, no
trailing newline:

```text
21gifts-account-recovery-bind-v1
<owner account id>
<recovery session id>
<new passkey credential id, lowercase hex>
```

The signature is Ed25519 over the SHA-256 of that string. The server
accepts it only together with a new passkey attestation for this
relying party, user verification required, and the user id equal to the
account id. The body must not contain PRF results. The server stores the
new credential, deletes every other credential for the account, marks the
session completed, and cancels sibling sessions. On failure it stores
nothing and leaves the session open until it expires. The refused
"replace the phrase" behaviour is unchanged. This path restores the same
phrase. It does not write a different one.

The new phone then shows the 12 words from those bytes. So those words
remain available after the ceremony, the phone wraps the bytes under the
new passkey and uploads only the wrap. HKDF-SHA256, salt UTF-8 `21gifts-seed-derivation`,
info UTF-8 `seed-wrap-v1`, 32 bytes. That info must not equal `mnemonic-v1`.
AES-256-GCM, 12-byte nonce, additional data the UTF-8 account id, plaintext
the 16 bytes. The blob is version `0x01`, the nonce, the ciphertext, and
the tag: 45 bytes. The server stores the blob and cannot read it. Showing
the words later unwraps it and BIP-39-encodes the bytes. If that passkey
returns no PRF, the words stay locked. The phone must not show
`mnemonic-v1` of the new passkey instead.

The wait is 48 hours from the start of the recovery, even if both shares
arrive in the first minute, and even if some passkey is still logged in.
The only instant path is a passkey that already logs in. An existing
passkey cancels the recovery immediately. The new phone can abandon its
own session and discard the ephemeral secret.

A session that is not completed or cancelled expires 7 days after
creation. At most 3 recoveries may be started for one account in any
rolling 24 hours. The first one to complete cancels the others.

The server does not need the 16 bytes to check the bind. It verifies the
signature under the bind public key stored at enrollment.

## If the service is gone

The verifier's phone and the friend's phone still hold their sealed
shares. Two of those people can reconstruct the 16 bytes without the
server. Binding a new passkey needs the service to be up, because the
account lives there. The reconstruction itself does not. The service
share is not required for that pair.

Losing the server's recovery private key loses the service share only.
The other pair still works. Losing the phones as well, with no export,
loses this recovery. A paper copy of the 12 words is the same phrase, not
a different secret. The shares reconstruct those words.

## State machine

```text
no set
  │ ceremony, friend has not stored a share
  ▼
inactive ──────── friend readable-proof stored ────────► active

active recovery:
draft (15 min, no account yet)
        │ bind by username, or by a holder who selects the owner
        ▼
     pending ────── owner passkey cancel, or device abandon, or sibling completed ──► cancelled
        │ 48h elapsed and two distinct shares released
        ▼
      ready ────── owner passkey cancel, or device abandon, or sibling completed ──► cancelled
        │ bind signature and new passkey verify
        ▼
    completed

pending or ready, 7 days after creation, not completed ──► expired
```

An inactive set has no transition into `pending`. A passkey that still
works is the cancel path during the 48 hours.

## Acceptance criteria for a later implementation

- Two of the three shares reconstruct the original 16 bytes, and BIP-39
  of those bytes is the original 12 words. One share does not.
- Those bytes authorize a new passkey on the same account, and nothing
  else.
- The owner's phone will not seal a human share to a key that came from
  the api.
- The service share is sealed only to the key shipped in the client.
- Before the friend's readable-proof, the verifier and the service cannot
  start a recovery.
- After the set is active, the verifier and the service can, without the
  friend.
- A body that contains PRF results is rejected.
- Replacing the phrase with different words stays refused.
- After recovery, showing the words unwraps the stored wrap. It does not
  derive a new phrase from the new passkey.
- No row and no log contains the 16 bytes or a share plaintext.
- Completing one recovery cancels the other open ones for that account.
- The verifier and the friend can reconstruct the 16 bytes from the
  copies on their phones with the server offline.

## Out of scope here

- Anything other than account access on a new device and the same 12
  words.
- Any route, table, screen, or migration.
- Splitting the passkey private key.
- A second friend, a chosen verifier, or a threshold other than 2 of 3.
- A SLIP-39 passphrase or a second Shamir group.
- Remote wipe of a lost authenticator.
- Wallet of Satoshi recovery.
