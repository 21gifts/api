# KEK rotation runbook

This is the operator procedure for rotating both key-encryption keys (KEKs)
of the api at once:

- `NOSTR_NSEC_KEK` with its id `NOSTR_NSEC_KEK_ID` seals the custodial Nostr
  keys of members (`account`) and shops (`shop_identity`) and the deployment
  Spark viewer mnemonic (`spark_viewer_key`).
- `RECOVERY_SHARE_KEK` with its id `RECOVERY_SHARE_KEK_ID` seals the 21.gifts
  recovery shares (`recovery_share`).

The rotation itself runs at the next boot of the api with a database
(`DATABASE_URL` set), after every migration and before any worker starts
(`rotateKeks`, `src/lib/kek-rotation.ts`). There is no separate tool and no
route. A memory boot (no `DATABASE_URL`) has nothing to rotate. The variables
are described in CONTRIBUTING.md (environment table) and SPEC.md (KEK ids and
KEK rotation); the per-table rules are in
[docs/shop-identity.md](shop-identity.md#kek-rotation) and
[docs/social-recovery.md](social-recovery.md#the-21gifts-share).

## What the boot does

- Every member and shop Nostr key and the Spark viewer key stored under a
  `NOSTR_NSEC_KEK_ID` other than the configured one gets a **fresh** key under
  the new `NOSTR_NSEC_KEK`. The old secret is never decrypted, so there is no
  previous Nostr KEK.
- Every recovery share under a `RECOVERY_SHARE_KEK_ID` other than the
  configured one is opened with `RECOVERY_SHARE_KEK_PREVIOUS` and sealed again
  under the new `RECOVERY_SHARE_KEK`. Its content cannot be renewed without the
  member, so the same bytes are kept.
- Before anything is written, one stored envelope under each current id is
  opened with the current key. Before the first recovery share is written
  (after the Nostr and viewer keys are rotated), every share under another id
  is opened with the previous key. A failure stops the boot (see
  [Errors](#errors-that-stop-the-boot)).
- Every write is a compare-and-set `UPDATE` in batches of at most 200 rows,
  under an advisory lock, recorded by `db_change` (secret columns only as a
  hash). A boot that stops halfway continues where it stopped at the next
  start; a boot with nothing left to rotate changes nothing.

## Before you start

- **Two new keys.** Create two new random 32-byte keys, each written as 64
  lowercase hex characters, for example with `openssl rand -hex 32` (run it
  twice). The two values must differ from each other and from every key used
  before.
- **Never reuse an old value.** A rotation needs a new value **and** a new id
  for each key. If only the id changes and the old value stays:
  - for `NOSTR_NSEC_KEK`, the boot accepts it: the member and shop Nostr keys
    and the viewer key are replaced by fresh keys, but sealed under the
    **old**, already known key value, although the log looks normal;
  - for `RECOVERY_SHARE_KEK`, the boot stops at once when
    `RECOVERY_SHARE_KEK_PREVIOUS` is set to that same value (it must differ
    from `RECOVERY_SHARE_KEK` and from `NOSTR_NSEC_KEK`); without
    `RECOVERY_SHARE_KEK_PREVIOUS` the shares are not rotated and stay pending.
- **Two new ids.** Pick an id for each key that has never been used for that
  key, for example the current id plus one. Without a configured id the
  current one is `1`. An id is a decimal integer from 1 to 4294967295; any
  other value stops the boot. The ids are not secret.
- **Keep the old recovery key.** You need the current value of
  `RECOVERY_SHARE_KEK` once more, as `RECOVERY_SHARE_KEK_PREVIOUS`. Without it
  the stored shares cannot be moved to the new key. The old `NOSTR_NSEC_KEK`
  is not needed.
- Store the new values wherever the deployment keeps its secrets before you
  change anything.

## Procedure

1. **Stop every running instance of the api.** The rotation happens at the
   next boot. A process that still runs with the old configuration keeps
   writing new keys and shares under the old ids, which the new boot then has
   to rotate again, and it cannot use the keys the new boot wrote. Start the
   new configuration only when no old process is left.
2. **Set the new configuration:**
   - `NOSTR_NSEC_KEK` = the first new key,
   - `NOSTR_NSEC_KEK_ID` = its new id,
   - `RECOVERY_SHARE_KEK` = the second new key,
   - `RECOVERY_SHARE_KEK_ID` = its new id,
   - `RECOVERY_SHARE_KEK_PREVIOUS` = the old value of `RECOVERY_SHARE_KEK`.
3. **Start one instance.** Concurrent boots are safe (the advisory lock
   serialises them), but one instance keeps the log easy to read.
4. **Check the log line `kek.rotation.done`.** It carries counts only:
   - `accounts`: members whose Nostr key was replaced; expect the number of
     members with a custodial Nostr key.
   - `shops`: shops whose Nostr key was replaced; expect the number of shop
     keys.
   - `sparkViewer`: `1` when the deployment viewer key was replaced, `0` when
     there was none yet.
   - `recoveryShares`: shares sealed again under the new key; expect the
     number of stored shares.
   - `recoverySharesPending`: must be `0`. A higher value means
     `RECOVERY_SHARE_KEK_PREVIOUS` was not set; the line
     `kek.rotation.recovery_share.pending` then shows the same count.
5. **Check that no `nostr.key.kek_stale` appears.** That warning means a Nostr
   key under an old id was met while signing, so a key was not rotated, most
   likely because an old process wrote it after the boot. Stop every instance
   and start again; the boot rotates what is left.
6. **Remove `RECOVERY_SHARE_KEK_PREVIOUS` and restart.** The previous key is
   only for the rotation. Expect `kek.rotation.done` with every counter `0`
   (`accounts`, `shops`, `sparkViewer`, `recoveryShares`,
   `recoverySharesPending`), and no `kek.rotation.recovery_share.pending`
   line.
7. Start the remaining instances.

## Errors that stop the boot

Each error message names a variable and, where it applies, an id or a count;
it never contains a key. Nothing that the boot had not already finished is
changed.

- **`KEK rotation stopped: <n> recovery share(s) did not open with RECOVERY_SHARE_KEK_PREVIOUS`**
  — `RECOVERY_SHARE_KEK_PREVIOUS` is not the key the shares were sealed with
  (a typo, or a value of another environment). No share was changed or
  deleted; the Nostr keys may already be rotated, which is fine. Set
  `RECOVERY_SHARE_KEK_PREVIOUS` to the exact old value of `RECOVERY_SHARE_KEK`
  and start again. If that value is lost, the shares cannot be moved: remove
  `RECOVERY_SHARE_KEK_PREVIOUS` so the api boots; the shares stay under the old
  id, `kek.rotation.recovery_share.pending` logs their count at every boot,
  and they still count as stored for the members.
- **`NOSTR_NSEC_KEK does not open the keys stored under NOSTR_NSEC_KEK_ID <id>; a new key value needs a new id`**
  or **`RECOVERY_SHARE_KEK does not open the recovery shares stored under RECOVERY_SHARE_KEK_ID <id>; a new key value needs a new id`**
  — a new key value was set under an id that is already in use, or the
  configured key is not the one for that id. Nothing was written. Give the new
  key a new id (step 2), or, to go back, restore the value that belongs to
  `<id>`.
- **`NOSTR_NSEC_KEK_ID must be a positive integer`** or
  **`RECOVERY_SHARE_KEK_ID must be a positive integer`** — the id is not a
  decimal integer from 1 to 4294967295. Fix the value.
- **`RECOVERY_SHARE_KEK_PREVIOUS must be 64 lowercase hex characters`**,
  **`RECOVERY_SHARE_KEK_PREVIOUS must differ from RECOVERY_SHARE_KEK`** or
  **`RECOVERY_SHARE_KEK_PREVIOUS must differ from NOSTR_NSEC_KEK`** — the
  previous key is malformed or equal to a current key, usually because the
  new key was not set. Fix the values.

## What members notice

Nothing, and they do nothing. Sessions, accounts, usernames, Lightning
addresses and wallets are unchanged. The recovery shares keep their content,
so the shares held by the two chosen people stay valid. The api announces the
new Nostr keys of members and shops (kind 0 and kind 10002) as for a new key,
and `GET /shops`, `GET /shops/:npub` and the NIP-05 directory answer the new
shop npubs. Shop NIP-05 names stay: a shop keeps its `nostr_key_created_at`,
the order in which shop names are allocated. `GET /me` returns the new Spark viewer public key, and the app
grants it to the member's current wallet again.

## Accepted limits

- **Previous wallets lose viewer reads.** The app grants the new viewer key
  only to the current wallet. A member's previous wallets were granted the old
  viewer key and cannot be granted the new one, so the api no longer reads
  their transfers and balances.
- **Signed notes keep their key.** A note that was signed under an old Nostr
  key but not published yet keeps that key and signature when it is
  published; it is not signed again.
- **Old npubs.** The old Nostr public keys are no longer used; an old shop
  npub resolves to no shop.
