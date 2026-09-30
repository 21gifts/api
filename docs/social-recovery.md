# Securing the account

Status: **concept only**. Decided 2026-09-30. Not implemented. No HTTP path in
this document is reserved. A later change that builds this adds its routes to
`SPEC.md` in that same change. Nothing here changes runtime behaviour.

Recovery does two things, and nothing else:

1. The same 21.gifts account opens on a new device.
2. The same 12 seed words come back.

## Decision

The owner starts this. The owner is the account being secured. Person 1 and
person 2 are the two chosen people. Those words are not interchangeable. It
is not a side effect of being verified, and it is not required. The app
offers **Mein Konto absichern**. The owner may ignore it. Sign-up, login,
and every other use of the account work with no recovery set. Leaving the
screen before two people are confirmed stores nothing.

When the owner continues, that screen explains the two results above, and
that both chosen people are required. One person cannot reset the account.
The owner then chooses exactly two people.

If a moderator has verified the owner, that moderator is suggested as
person 1. The suggestion is not fixed. The owner can replace it with
someone else. Person 2 has no suggestion. If nobody has verified the
owner, both slots start empty.

Each chosen person's share stays on that person's phone. 21.gifts does not
hold a share and cannot reset the account. The server may store a copy of
a sealed share. It has no key to open one.

Both shares are required. There is no third share. A member threshold of 1
cannot be stored. The SLIP-39 group threshold is 1 because there is one
group, not because one share is enough.

Daily login stays a passkey. The passkey private key is not one of these
shares and never leaves the authenticator. On the new device the recovered
bytes do only the two things above: they authorize one new passkey for this
account, and they are shown as the same 12 words.

## Mein Konto absichern

The action is offered to a signed-in owner. It is optional. Opening it
does not create shares, and closing it does not either. The screen
explains, in order:

- Both people together can put this account on a new phone and bring back
  the same 12 words.
- One of them cannot.
- The passkey used day to day stays on the owner's phone.
- Nothing else is recovered or moved.

The owner then picks the two people. Person 1 is prefilled with the
moderator who verified them, when that trust edge exists. Changing person
1 is a normal choice, not an extra step. The two people must be two
different 21.gifts accounts, and neither may be the owner. An account
that cannot log in cannot be chosen.

Choosing the names is not enough, and it stores nothing. There is no set
until both phones have stored a readable proof. Until then a reset cannot
start. After that upload the set is **active**. It becomes **inactive**
only later, if one of those stored shares is gone. Inactive means a reset
cannot start.

## The 12 words

The words are the phrase the phone already derives and never sends. When
the owner continues past the explanation, their phone derives them again.
It does not generate a new secret.

1. WebAuthn PRF `eval.first`, salt = SHA-256 of the UTF-8 string
   `21gifts-nostr-v1`.
2. HKDF-SHA256, salt = UTF-8 `21gifts-seed-derivation`, info = UTF-8
   `mnemonic-v1`, 128 bits.
3. BIP-39 English, 12 words.

That derivation already exists. This document does not change it. The bytes
are the backup phrase. They are not uploaded, and they are not used for
anything besides the two results above.

Before any share is given out, the phone reconstructs the shares locally
and checks that BIP-39 of those bytes is the phrase it just derived. If
not, it stops.

## What this does not do

Anything other than opening the account on a new device and restoring those
words. The passkey private key is not split. A new passkey is a new door
onto the same account. Deleting the old credential on the server stops the
old passkey from logging in. It does not erase the secret inside a lost
phone. The phrase is not replaced with different words. No balance is
moved. Nothing is published. Verification is not changed, and it does not
by itself create a share. Skipping **Mein Konto absichern** does not lock
the account. An account with no set has no social reset. The passkey
remains the only way in.

## The two shares

One SLIP-39 group. Group count 1. Group threshold 1. Member count 2. Member
threshold 2. Empty passphrase. Iteration exponent 0. The master secret is
those 16 bytes. Reconstruction stops there, then BIP-39-encodes them. That
encoding is the original 12 words. Do not run SLIP-39's conversion of the
master secret into a BIP-32 seed. That would not be these words.

| Share | Who                           | Where the readable share lives |
| ----- | ----------------------------- | ------------------------------ |
| 1     | The person chosen as person 1 | That person's phone            |
| 2     | The person chosen as person 2 | That person's phone            |

Both shares are required. There is no configuration of `t` or `n`.

Each share is sealed to an X25519 key that person's phone shows, as a QR
or as hex, to the owner's phone. The owner's phone does not take that
key from the api. The seal is a libsodium sealed box (`crypto_box_seal`:
X25519, XSalsa20-Poly1305). The plaintext is one version byte `0x01`, then 32 confirmation bytes from
the owner's phone, then the UTF-8 SLIP-39 mnemonic of that share (twenty
words, single ASCII spaces, no trailing newline). Each share has its own
confirmation. The api may store a copy of that ciphertext. It has no key
to open it, and it never stores the confirmation.

## Enrollment order

1. The owner opens **Mein Konto absichern** and reads the explanation.
   Stopping here stores nothing. If the owner continues, they confirm the
   two people. Person 1 may still be the suggested moderator, or someone
   else. Confirming the names still stores nothing.
2. The owner's phone derives the existing 16 bytes, builds the two
   SLIP-39 shares, and checks that BIP-39 of the reconstruction is the
   phrase it just derived. It draws a fresh 32-byte confirmation for each
   share. It derives the Ed25519 bind public key and keeps that public key.
3. For each chosen person, that phone shows a fresh X25519 public key and
   an Ed25519 public key, and signs the owner's 32-byte nonce with that
   Ed25519 key. The owner scans or pastes that payload and verifies the
   signature. A mismatch aborts the ceremony. The owner seals that
   person's share, including that share's confirmation, to the scanned
   X25519 key. That phone holds the ciphertext and the matching X25519
   secret only in memory, opens the ciphertext once, reads the
   confirmation, checks the SLIP-39 identifier, discards the share words,
   and signs a readable-proof that includes the confirmation. The owner's phone accepts the proof only when the
   signature verifies and the confirmation matches the one it sealed into
   that share. It then discards that confirmation.
4. Both people do this on their own phones during this ceremony. If either
   person is not available, or either phone aborts, both phones discard
   every provisional ciphertext and the matching X25519 secret. The
   owner's phone also discards the 16
   bytes, the bind private key, both share plaintexts, and both
   confirmations. Nothing is stored. During this enrollment, no share is
   sealed to a key on the owner's current phone. The ceremony can be
   started again later. When both
   proofs have been accepted, the 16 bytes, the bind private key, and the
   share plaintexts are discarded.
5. Only after both readable-proofs are accepted do both phones store their
   ciphertext and the matching X25519 secret together, and the owner's
   phone uploads the bind public key, the SLIP-39 identifier, and the two
   ciphertexts. The server never receives an X25519 secret. Those local
   copies and that upload happen together. That upload creates the set as `active`.
   The 16 bytes are not in the upload. Until both proofs are accepted,
   nothing is stored and a reset cannot start.

The nonce is generated on the owner's phone. The api does not choose it.
The signed enrollment message is UTF-8, four lines, a newline between the
lines, no trailing newline:

```text
21gifts-recovery-person-v1
<owner account id>
<person x25519 public key, lowercase hex>
<nonce, lowercase hex>
```

The signature is Ed25519 over the SHA-256 of that string. The readable-proof
is UTF-8, five lines, a newline between the lines, no trailing newline.
The signature is Ed25519 over the SHA-256 of that string:

```text
21gifts-recovery-readable-v1
<owner account id>
<SLIP-39 identifier, lowercase hex>
<person ed25519 public key, lowercase hex>
<confirmation, lowercase hex>
```

The confirmation is inside the seal and nowhere else. A person who cannot
open the seal does not learn it, so they cannot produce a proof the owner's
phone accepts. The proof is not a substitute for the scan. The server does
not store the confirmation.

Replacing the set is the same ceremony and replaces both shares in one
step. Shamir shares are not edited in place. Changing either person is a
full replacement. A later verification does not move a share and does not
replace person 1.

A written export of a SLIP-39 share cannot be deleted. Resignation deletes
the server ciphertext and asks that phone to delete its local copy. The
owner is told this before confirming the two people. If either share is
gone after the set is `active`, fewer than two shares remain, the set
becomes `inactive`, and a reset cannot start until the owner, who can
still open the phrase with their passkey, runs the ceremony again. The
new upload waits until both new proofs exist, then replaces the set as
`active`. Until that upload, the set stays `inactive`.

## What the server may store

No row contains the 16 bytes, a share plaintext, a confirmation, PRF
output, the 12-word backup, or a passkey private key. Logs follow the same ban. The server
cannot decrypt a share.

Conceptual records, not a schema migration:

**Recovery set.** Created only by the upload in enrollment step 5, as
`active`. Owner account id. SLIP-39 identifier. Ed25519 bind public key.
Created time. Status `active`, or `inactive` after one stored share is
later gone. The account suggested as person 1 is not stored unless that
person was confirmed.

**Share.** Set id. Chosen person's account id. Ed25519 public key and
X25519 public key the owner verified by scan. Sealed ciphertext. Time the
readable-proof succeeded. Exactly two rows while the set is `active`. An
`inactive` set has fewer than two.

Both people are 21.gifts accounts so the app on those phones can store
the share and be asked to release it. A chosen person receives nothing
except that share. `session_refused` cannot enroll, hold a share, or
recover.

## Recovery

A new phone generates an X25519 keypair and keeps the secret in memory.
It shows the public key as a QR and as lowercase hex. Both people must
release their share. Each phone opens its stored ciphertext with the
X25519 secret it kept, then seals that share only to a key that phone
scanned from the new phone. It refuses a key that arrived only inside a
server payload. The server may store the announced public key so a person
can see a mismatch. It must not offer "use the key on the session". The
server has no share of its own to release.

The short code is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
It names the recovery to a person. It is not a key and not sufficient to
release a share.

The new phone reconstructs the 16 bytes from both shares. It derives the
bind key locally and checks the signature against the stored bind public
key before uploading anything. A mismatch discards the material and
uploads nothing.

The bind private key is Ed25519. Its 32-byte seed is HKDF-SHA256 with
input keying material the 16 bytes, salt the UTF-8 string
`21gifts-account-recovery`, info the UTF-8 string `bind-v1`, and length 32. This key only authorizes the new passkey.

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
relying party, user verification required, the user id equal to the
account id, and the wrap described below. The body must not contain PRF
results.

Before that request, the new phone wraps the 16 bytes under the new
passkey and decrypts the wrap locally. HKDF-SHA256, salt UTF-8
`21gifts-seed-derivation`, info UTF-8 `seed-wrap-v1`, 32 bytes. That info
must not equal `mnemonic-v1`. AES-256-GCM, 12-byte nonce, additional data
the UTF-8 account id, plaintext the 16 bytes. The blob is version `0x01`,
the nonce, the ciphertext, and the tag: 45 bytes. The local decrypt must
yield the same 16 bytes. If the new passkey returns no PRF, or the local
decrypt does not match, the phone does not send the bind. The session
stays `ready`. Existing credentials stay. The phone must not show
`mnemonic-v1` of the new passkey instead.

When the local decrypt matches, the phone shows the 12 words from those
bytes and sends the bind, the attestation, and the wrap together. The
server, in one transaction, stores the new credential, stores the wrap,
deletes every other credential for the account, marks the session
completed, and cancels sibling sessions. On failure it stores nothing,
leaves the session `ready` until it expires, and leaves existing
credentials in place. The refused "replace the phrase" behaviour is
unchanged. This path restores the same phrase. It does not write a
different one.

The server cannot read the wrap. Showing the words later unwraps it and
BIP-39-encodes the bytes.

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

The two phones still hold their sealed shares. Those two people can
reconstruct the 12 words without the server. Binding a new passkey needs
the service to be up, because the account lives there. The reconstruction
itself does not.

Losing both phones, with no export, loses this recovery. A paper copy of
the 12 words is the same phrase, not a different secret.

## State machine

```text
no set
  │ never opened, left before two people are confirmed, or a readable
  │ proof is still missing (stores nothing)
  └── stays here

no set
  │ both readable-proofs accepted
  │ upload bind public key, identifier, and both ciphertexts
  ▼
active ──────── one share gone, or resignation ────────► inactive

inactive
  │ ceremony again, both new readable-proofs accepted
  │ upload bind public key, identifier, and both ciphertexts
  ▼
active

active recovery, only from active:
draft (15 min, no account yet)
        │ bind by username, or by a chosen person who selects the owner
        ▼
     pending ────── owner passkey cancel, or device abandon, or sibling completed ──► cancelled
        │ 48h elapsed and both shares released
        ▼
      ready ────── owner passkey cancel, or device abandon, or sibling completed ──► cancelled
        │ bind, wrap, and new passkey verify together
        ▼
    completed

pending or ready, 7 days after creation, not completed ──► expired
```

No set, and an inactive set, have no transition into `pending`. A passkey
that still works is the cancel path during the 48 hours.

## Acceptance criteria for a later implementation

- Both shares reconstruct the original 16 bytes, and BIP-39 of those
  bytes is the original 12 words. One share does not.
- Those bytes authorize a new passkey on the same account, and nothing
  else.
- **Mein Konto absichern** is optional. The account works with no
  recovery set. Closing the screen before two people are confirmed stores
  nothing. Continuing explains the two results, then asks for two people.
  Person 1 starts as the verifying moderator when one exists, and the
  owner can replace that suggestion.
- A fixed moderator, or a share held by the service, cannot be stored.
- The owner's phone will not seal a share to a key that came from the
  api.
- Before both readable-proofs are accepted, nothing is stored, including
  on the chosen people's phones, and a reset cannot start.
- The new passkey, the wrap, and completion are written together. A
  missing PRF, or a failed write, leaves the session `ready` and leaves
  existing credentials in place.
- The owner's phone rejects a readable-proof whose confirmation was not
  inside that share's seal. During enrollment, a share is not sealed to
  a key on the owner's current phone. During recovery, each chosen phone
  opens its share and seals it to the key scanned from the new phone.
  Each chosen phone stores the X25519 secret with the ciphertext. The
  server never receives that secret.
- A body that contains PRF results is rejected.
- Replacing the phrase with different words stays refused.
- After recovery, showing the words unwraps the stored wrap. It does not
  derive a new phrase from the new passkey.
- No row and no log contains the 16 bytes, a share plaintext, or a
  confirmation.
- Completing one recovery cancels the other open ones for that account.
- The two people can reconstruct the 12 words from the copies on their
  phones with the server offline.

## Out of scope here

- Anything other than account access on a new device and the same 12
  words.
- Any route, table, screen, or migration.
- Splitting the passkey private key.
- Requiring **Mein Konto absichern** before sign-up, login, or any other
  use of the account.
- A share held by 21.gifts, a fixed moderator, or a threshold other than
  both chosen people.
- A SLIP-39 passphrase or a second Shamir group.
- Remote wipe of a lost authenticator.
- Wallet of Satoshi recovery.
