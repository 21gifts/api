# Shop identity

Status: **S1, S2, S3 and S5 implemented** in this repository. S4, the shop
page, is in 21gifts/app#646 (open, not merged). The API route and response
fields are documented in `SPEC.md`; the durable table is documented in
`docs/schema/shop_identity.sql`.

Every shop gets its own NOSTR identity. 21.gifts generates it, holds it and
publishes its profile, exactly the way it already does for every account. The
shop's public page is `https://21.gifts/{npub}`.

The same npub identifies the shop on the OpenCryptoPay map. OpenCryptoPay
requires a NOSTR public key for every shop it lists and uses it as the shop's
id, including for its page `https://opencryptopay.io/{npub}`. OpenCryptoPay
does not hold keys and does not maintain profiles. Its side is specified in
[openCryptoPay/api `docs/product/shop-identity.md`](https://github.com/openCryptoPay/api/blob/develop/docs/product/shop-identity.md)
(until that is merged: openCryptoPay/api#23).

## What a shop is

A **listed shop** is a top-level forum note (`parent_id` null) that:

- is live: `deleted_at` null. A staff hide sets `deleted_at` too, so a hidden
  note is not listed;
- has the hashtag token `21GiftsShop` in its text, with the same token rule
  as `GET /shops/activity`;
- has a place pin;
- has `shop_account_id` set. The till account does not need a username: an
  account without one (for example the survivor of an account merge, which
  keeps its own username) still lists the shop; only `payUsername` is
  `null` and the shop kind 0 has no `lud16`;
- is complete under 21gifts/api#478: `shopPlaceProblem` (label, structured
  address, label without the address) and `shopTextProblem` (description)
  both return `null`. This is the same check `shopOcpPlaceInput` makes before
  it sends a place to OpenCryptoPay.

"Listed" is the single rule for everything in this document: which notes get
a key, which kind 0 content a shop identity publishes (S2 publishes every
identity, listed or not, with different content), which shops
`GET /shops/:npub` serves with 200, and which shops are on the OpenCryptoPay
map. A note that stops meeting any of the five conditions is no longer
listed. It keeps its identity. An older shop note that is not complete gets
no key until its owner completes it.

The shop name is the pin label, which a listed shop always has. The shop
description is the note text without the `#21GiftsShop` token
(`shopDescription`). Both come from 21gifts/api#478, which makes shops
complete for the map and adds the structured pin address. This concept
builds on that change.

## S1 Key per shop

- One random key per shop note, from the same `generateSecretKey()` path as
  account keys (`src/lib/nostr/keys.ts`). No master seed, no derivation.
- The key is created after the commit of any write that makes a note a
  listed shop for the first time: `POST /messages`,
  `PATCH /messages/:id/text`, `PATCH /messages/:id/place`,
  `PATCH /messages/:id/shop-account`, `PUT /me/about` (the profile note's
  text) and the staff restore `POST /debug/messages/:id/restore`.
  - The insert runs in a transaction that first locks the note
    (`SELECT … FROM message WHERE id = $1 FOR UPDATE`), the same in the
    backfill below, and then checks the five conditions again. If the note
    is no longer listed, no key is created. A concurrent edit of that note
    therefore either commits first, and the check and the new key's first
    push see it, or waits and then queues itself (S5).
    Implemented as one statement (`PostgresShopIdentityStore.ensureListed`):
    the conditions are checked in code on the note as read, then a
    data-modifying CTE locks the note with `FOR UPDATE` and inserts only
    while every column that check read (text, pin, till account set, live,
    top-level) is unchanged. An edit that committed in between makes the
    insert a no-op; that edit's own write path or the backfill then creates
    the key from the new state. The in-memory adapter reads the note again
    after the key is generated and takes the name and the fingerprints from
    that read, creating nothing if it is no longer listed.
  - For an existing key, `ensureListed` rewrites `profile_name` under the
    same lock and the same unchanged-columns condition (`UPDATE … FROM` the
    locked note), so a request that read the note before a newer rename
    committed changes nothing and cannot put the older name back. The
    in-memory adapter applies the same rule as `renameIfListed`: it writes
    the name only while the note read again still shows the snapshot, and
    returns the stored row.
  - A failure logs `shop.nostr_key.failed` with the message id and does not
    fail the request, the same as the lazy account key at login.
  - The worker backfill also picks up listed shops without a key, next to
    the existing account backfill. Each tick reads one raw page of at most
    20 candidate notes (live, top-level, pinned `#21GiftsShop` notes with a
    till account), keyed or not: the `LIMIT` bounds the page before the key
    check, which is an `EXISTS` on `shop_identity` per returned row. The
    keyset cursor by (`created_at`, `id`) advances to the last note of that
    raw page, keyed notes are skipped without generating a key, and the
    cursor resets to the start only after a short raw page. Completeness
    under #478 is checked in code, not in SQL, so the cursor also moves past
    rejected (incomplete) notes. An older incomplete note or a run of keyed
    shops can therefore never hold the slot of an unkeyed listed shop behind
    it, and a lap where every shop has its key reads one page per tick
    instead of every candidate. The page walks the partial index
    `message_shop_candidate_idx` on `message` (`created_at`, `id`), limited
    to live top-level notes with a till account and a pin
    (`parent_id IS NULL`, `deleted_at IS NULL`, `shop_account_id IS NOT NULL`,
    `place_lat IS NOT NULL`), so a tick does not scan every live note, and a
    page returns at most `limit` rows. The first page has no cursor
    predicate; every later page is a separate statement with only
    `(created_at, id) > ($1, $2)`, so the cursor is always an index
    condition on that index, also under a cached generic plan of the
    prepared statement, and a page never reads the candidates before it.
    Ticks start without waiting for the previous one, so the backfill
    holds a per-store in-flight mark (cleared also when the page read
    fails): a tick that finds it set skips the backfill without reading.
    Overlapping ticks therefore never stack candidate scans or key
    generation, and an older pass cannot set the cursor back to an earlier
    page.
    After it creates a key, it queues the OpenCryptoPay place push of S5
    for that shop, so a failed mint at the write is repaired without another
    edit. The key insert, outbox columns, write-path queueing, backfill
    queueing and paged start-up pass ship together in this release.
- The identity belongs to the note. It is never deleted and never moved to
  another note:
  - A note that stops being listed and is listed again gets the same npub
    back.
  - Changing the till account (`shop_account_id`) or the pin does not change
    the identity.
  - A second note for the same physical shop is a second shop with its own
    identity.
- Two concurrent creators keep exactly one key: compare-and-set on insert,
  the same as `ensureAccountNostrKey`.
- Concurrent boots cannot fail the schema migration: every statement of
  `SHOP_IDENTITY_SCHEMA_SQL` (table, indexes, trigger functions and
  triggers) runs in its own `DO` block that first takes the
  transaction-scoped advisory lock `pg_advisory_xact_lock(21499001)`, so
  the boots run each statement one after the other.

### Storage

New table `shop_identity`. The key columns have the same names as on
`account`:

| Column                     | Type                   | Rule                                                             |
| -------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `message_id`               | `uuid PRIMARY KEY`     | `REFERENCES message (id)`                                        |
| `nostr_pubkey`             | `text NOT NULL UNIQUE` | 64 lowercase hex                                                 |
| `nostr_nsec_ciphertext`    | `bytea NOT NULL`       | Envelope below                                                   |
| `nostr_kek_id`             | `integer NOT NULL`     | Only `1`                                                         |
| `nostr_key_custody`        | `text NOT NULL`        | `CHECK` `custodial` or `user`; `custodial`                       |
| `nostr_key_created_at`     | `timestamptz NOT NULL` | Set on insert                                                    |
| `profile_name`             | `text NOT NULL`        | Shop name, rewritten whenever the shop is listed (1)             |
| `ocp_photos_hash`          | `text NULL`            | SHA-256 of the photo set last answered by S5                     |
| `ocp_photos_pending`       | `boolean NOT NULL`     | Default `false`; a photo push is due (S5)                        |
| `ocp_photos_generation`    | `integer NOT NULL`     | Default `0`; raised by every S5 trigger                          |
| `ocp_photos_claimed_until` | `timestamptz NULL`     | Photo push claimed until then (S5)                               |
| `ocp_photos_claim`         | `integer NOT NULL`     | Default `0`; raised by every photo claim (S5)                    |
| `ocp_place_pending`        | `boolean NOT NULL`     | Default `false`; a place push is due (S5)                        |
| `ocp_place_generation`     | `integer NOT NULL`     | Default `0`; raised by every place change (S5)                   |
| `ocp_place_claimed_until`  | `timestamptz NULL`     | Place push claimed until then (S5)                               |
| `ocp_place_claim`          | `integer NOT NULL`     | Default `0`; raised by every place claim (S5)                    |
| `ocp_revision`             | `bigint NOT NULL`      | Default `0`; raised for every request sent to OpenCryptoPay (S5) |

(1) Written on insert, by every write path that calls `ensureListed` while
the note is listed, and by the worker before it publishes a listed shop's
kind 0. The worker writes through `renameIfListed` with the note it read,
under the same note lock and unchanged-columns condition as `ensureListed`,
so a tick that read the note before a newer rename committed cannot put the
older name back (which the kind 0 of a shop that is later unlisted would
otherwise keep).

The operator dump (`GET /debug/dump/shop_identity`) shows every column
except `nostr_nsec_ciphertext`; the encrypted secret is never dumped. Like
every other dump table it is capped at 200 rows: it reads
`ShopIdentityStore.listDebug(200)`, the first 200 identities by
`nostr_key_created_at`, then `message_id` (`LIMIT $1` on Postgres).

`MessageStore.deleteById` can hard-delete a top-level note, for example when
its video file is missing. It deletes nothing for a note that has a
`shop_identity` row, the same way it keeps a credit note with sats, and its
callers treat that note like any other kept row. On Postgres, `deleteById`
runs in a transaction that locks the note, checks for that row in its own
statement and then deletes, so a key insert that commits while the delete
waits is still seen. So the reference never dangles and the identity is
never deleted.

`PostgresMessageStore.create` writes the note row with its mentions and its
`message_extra_photo` rows in one statement: a data-modifying CTE, as
`deleteById` uses, whose photo rows insert from the note insert's
`RETURNING`, so a reply whose parent check inserts no row writes no photos
either. Separate statements would let the backfill see a committed note
before a failing extra photo removes it again and mint a key that keeps the
half-written note. A failure of the statement leaves nothing behind, and the
error path of `create` (the unique-violation lookups and `removeForumVideo`)
runs as before; there is no separate extra-photo loop with a `deleteById`.
A regression test fails the statement on an extra photo while the backfill
runs and checks that neither the note nor a `shop_identity` row is left.

### Encryption at rest

- The existing envelope and key-encryption key: `version (0x01) || kek_id
(u32 BE) || nonce (12) || ciphertext+tag`, AES-256-GCM, `NOSTR_NSEC_KEK`.
  No new secret.
- Additional authenticated data: the UTF-8 bytes of `shop:<messageId>`. An
  account key uses the account UUID, so a shop ciphertext can never be
  decrypted as an account key or as another shop's key.
- A new `signEventForShop(messageId, event)` next to `signEventForAccount` in
  `src/lib/nostr/sign.ts`: it reads `shop_identity.nostr_nsec_ciphertext`,
  decrypts with the shop AAD, signs and zeroes the secret.
- The `db_change` audit log stores a shop's `nostr_nsec_ciphertext` only as
  a SHA-256 hash, as it does for accounts.
- A memory boot (blank `DATABASE_URL`) has no `NOSTR_NSEC_KEK`. It passes a
  random process-ephemeral key as `shopKek` to `createApp`, so listed shops
  still get a key and `GET /shops/:npub` works (Playwright e2e uses this).
  Those keys live in `InMemoryShopIdentityStore` and vanish with the process,
  like every other memory row; no shop kind 0 is published without Postgres.

### Custody

Custodial, like every account key in v1. The shop key only signs the shop's
kind 0 and kind 10002. The shop note itself stays a kind 1 from its author's
account key, unchanged. Handing a shop key to its owner belongs to the open
custodial-to-user step of Open Question #9 in `CONCEPT.md`.

## S2 Profile

The worker publishes a profile for **every** `shop_identity` row, listed or
not, in the same loop and with the same rules as account profiles
(`publishProfiles` in `src/lib/nostr/worker.ts`):

- same interval and batch size (`WORKER_BATCH` attempts per tick, failures
  included), but as a round robin with bounded reads: each kind keeps an
  in-process cursor (by `nostr_key_created_at`, then `message_id`, the
  `listAll()` order) and reads one page of at most `WORKER_BATCH`
  identities after it per pass (`ShopIdentityStore.listRound`, a keyset
  read on the index `shop_identity_key_order_idx`); when fewer rows follow
  the cursor, the store wraps with a second bounded read from the first
  row. The round-robin page never reads the whole table; only the NIP-05
  directory below reads every identity, at most once per its cache TTL plus
  one forced refresh per refresh gap. The cursor moves
  to every shop of the page before its visit, so up to 20 shops that keep
  failing cannot hold back the shops behind them. Every row of the page
  uses a slot, also a shop whose reads throw or whose content is unchanged
  (for kind 10002 too, so a lap visits every shop within
  ⌈shops / 20⌉ passes, unless a kind 0 pass stops early after a failed
  NIP-05 directory read), and a pass reads at most `WORKER_BATCH` shops per
  kind (a tick whose previous pass of that kind is still running reads none), also during an outage. The NIP-05
  names come from the shared directory (`nip05Directory`, see NIP-05
  below): the same names as `/.well-known/nostr.json` and
  `GET /shops/:npub`, read only once a visited shop is listed and the
  NIP-05 domain is set. It is computed at most once per 60 s on expiry and
  not per tick, whatever the number of shops. Each shop reads its note
  fresh, so when the directory has no entry for a listed shop or one with
  another name (listed or renamed since the directory), the shop asks for a
  forced refresh, which computes at most once per 10 s per store set and
  otherwise gives the cached directory. When the entry still does not
  match, that shop gets no kind 0 and no cache entry, the tick logs
  `nostr.profile.nack` with `reason: "nip05_stale"` and the shop is tried
  again on its next turn.
  When a directory read fails, the tick logs `nostr.profile.nack` with
  `reason: "nip05"`, publishes no further shop kind 0 in that tick (shops
  already published in that tick keep theirs; never one without its NIP-05)
  and goes on with kind 10002, kind 1 and conversations;
- same `NOSTR_PUBLISH` and
  `NOSTR_PUBLISH_PUBLIC` switches, same relays, kind 0 and kind 10002 also to
  `wss://purplepag.es`;
- published only when the content differs from the in-memory cache;
- `created_at` = `max(now, last + 1)`; a failure in the required write set
  clears the cache entry, while the `wss://purplepag.es` copy stays best
  effort, as for accounts;
- the fast lane starts a tick every 2 s without waiting for the previous
  one; a shop pass of one kind does not start while the previous pass of
  that kind is still in flight in the process (it is skipped for that tick
  and reads nothing), so two ticks never work on one shop's cache entry at
  once, and a nack or a failure after the reservation clears the shop's
  cache entry (a kind 0 read that throws before it leaves the entry as it
  was).

Kind 0 content of a listed shop:

| Field          | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| `name`         | shop name                                                                   |
| `display_name` | shop name                                                                   |
| `about`        | shop description                                                            |
| `picture`      | absolute URL of `/messages/:id/photo.<ext>`, otherwise `KIND0_PICTURE_URL`  |
| `banner`       | absolute URL of `/messages/:id/photo/1.<ext>`, otherwise `KIND0_BANNER_URL` |
| `website`      | `<site origin>/{npub}`, see below                                           |
| `nip05`        | `<local>@<domain>`, see below                                               |
| `lud16`        | the till account's Lightning address, see below                             |

The `picture` and `banner` URLs need only the content types of photo 0
(`photo.<ext>`) and of the extra still stored at index 1 (`photo/1.<ext>`).
Each field depends on its own still only: an unrecognized type on photo 0
gives the `picture` fallback and keeps the banner, and an unrecognized type
on still 1 gives the `banner` fallback and never moves still 2 into it,
because `getPhotoContentTypes` returns each extra with its stored index.
The worker reads them with `MessageStore.getPhotoContentTypes`, one
statement that selects no `bytea` column, and not with `getPhoto` /
`listExtraPhotos`: these reads run on every pass, before the unchanged-content
skip, so reading the bytes would load up to ten photos per visited shop on
every pass (up to 200 photos per 2 s tick). The worker's own reads in the
shop kind 0 pass load no photo bytes, and `PostgresShopIdentityStore` reads
none either. A memory boot runs no Nostr worker (`src/index.ts` starts it only
with Postgres), so the in-memory shop store is never on this path.

Without a public origin, the shop profile does what an account profile does
(`publishProfiles`, `buildKind0Content`): when `nip05Domain`
(`src/lib/nip05.ts`) gives `null`, `nip05` is left out, and when
`resolvePublicApiBase` (`src/lib/nostr/relays.ts`) is empty, `picture` and
`banner` take the fallbacks `KIND0_PICTURE_URL` and `KIND0_BANNER_URL`.

`<site origin>` is `PUBLIC_BASE_URL` without a trailing slash, as
`notePageUrl` (`src/lib/nostr/event.ts`) builds note links, so a dev or
staging shop links to its own site; when it is empty, `https://21.gifts`.
The shop page is delivered by `21gifts/app` (S4, 21gifts/app#646), so this
release publishes `website` as `<site origin>/{npub}` and deploys after
that page is live (see Rollout). Accounts keep the fixed
`https://21.gifts` behavior.

Kind 0 of a shop that is no longer listed:

- `name` and `display_name`: `profile_name`, the name it had when it was last
  listed. If the note is hidden or deleted, `Shop` instead, so a name staff
  removed is not kept on the relays.
- `about`: `This shop is no longer listed on 21.gifts.`
- `website`: unchanged.
- `picture`, `banner`, `nip05` and `lud16` are dropped.
- There is no kind 5 deletion.

`buildKind0Content` (`src/lib/nostr/event.ts`) always writes
`website: 'https://21.gifts'` and both images, so it gains two optional
arguments: a `website` that replaces the fixed value, and a flag that leaves
out `picture` and `banner` for a shop that is no longer listed.
`buildKind0Event`, which builds the content again for the event it signs,
gains the same two arguments and passes them on, so the signed event and the
cached content match; a test checks the content of a signed shop event.
Accounts call both without them and keep their content.

Kind 10002 lists the same write relays as an account's.

The `lud16` is a plain Lightning address: the till account's
`lightning_address`, set only when the till account has a name (so it has
its own kind 0), a non-blank username and a non-blank address. That is the
`payUsername` rule of `GET /shops/:npub` plus the name, so a till account
without a username lists the shop but gives it no `lud16`, although its own
kind 0 carries one. The till account's LNURL response is unchanged, so this
spec adds no zap receipts for a shop key.

### NIP-05

- Listed shops join the existing `/.well-known/nostr.json` (api route and the
  app proxy).
- The local part comes from `allocateNip05Local(shopName, messageId, taken)`,
  the same slug and the same collision suffix as accounts.
- Accounts are allocated first, then shops by `nostr_key_created_at` and
  then `message_id`, so the order is the same on every run. An
  account never loses its local part to a shop.
- `listNip05Entries` (for `nostr.json`) reserves every account with a
  username, while `nip05Identifier` in `publishProfiles` only sees accounts
  with a name. Shop local parts come from one allocation that both use: the
  account set and order of `listNip05Entries`, then the listed shops. A test
  checks that a shop's kind 0 `nip05` equals its `nostr.json` entry, also
  when a nameless account's username equals the shop's slug.
- The local part follows the current shop name. A rename, or a new account
  that takes the slug, gives the shop a new local part, and its kind 0 is
  published again.
- Cost: one computation of the directory (`nip05Directory`) reads every
  account once and gives that one snapshot to the account and the shop
  allocation, so a username change or merge between two reads cannot hand a
  shop the local part of an account in the same directory; account entries
  are written first and a shop entry never overwrites one (it would be
  skipped and logged as `nip05.shop.collision`). For shops it adds one read
  of every `shop_identity` row and one bulk read of their notes
  (`MessageStore.getByIds`, `id = ANY($1::uuid[])`), not one read per shop.
- Cache: the directory is kept in process per auth store, shop identity
  store and message store (a `WeakMap`, so the memory and the Postgres boot
  each have one per process) for `NIP05_DIRECTORY_TTL_MS` = 60 s, the
  `max-age=60` that `nostr.json` and `GET /shops/:npub` already send.
  Concurrent readers share one computation in flight, so a burst of requests
  computes at most once per 60 s. `nostr.json`, `GET /shops/:npub` and the
  shop kind 0 all read it, so the three carry the same names. A caller whose
  note does not match the cached entry (`GET /shops/:npub`, the shop
  kind 0), a `nostr.json?name=` that the cache does not hold, or a
  `nostr.json?name=` the cache gives a shop while an account now holds it as
  its username, asks for one forced refresh, which bypasses and replaces the cache. Forced refreshes
  are single flight too and start at most once per
  `NIP05_DIRECTORY_REFRESH_MS` = 10 s per store set; inside that gap a
  forced read gets the forced computation in flight or the cached directory.
  So, while computations succeed, a store set computes the directory at most
  once per 60 s on expiry plus once per 10 s on demand (at most seven times a
  minute), however many requests and ticks ask. The price is staleness: the
  full `nostr.json` may be up to 60 s old, and a shop renamed twice within
  10 s answers 503 `nip05_stale` (and its kind 0 waits) until the gap ends.
  A failed computation is not cached; its callers get the error. Results
  are ordered by the order their computations started, not by the clock,
  and a clock that steps back counts as elapsed, so a clock step never
  freezes the cache.

## S3 API

### `GET /shops/:npub`

New. `GET /messages/:id` keeps serving a note by its note id. This route
resolves a shop by its NOSTR identity, the id that OpenCryptoPay, NIP-05 and
the shop page use, and answers for a shop that is no longer listed with 410.

No session; a missing or invalid bearer gets the same answer. Registered
after `GET /shops/activity`, so `activity` keeps its own handler. It takes any
single path segment and validates it inside the handler, so every other value
gets the 404 body and headers below.

| Request                                  | Response                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| npub of a listed shop                    | **200** `{ "shop": Shop }`                                                                              |
| 64 lowercase hex of a known shop pubkey  | **301** to `/shops/{npub}`                                                                              |
| npub of a known shop that is not listed  | **410** `{ "error": "Shop is no longer listed", "npub": "…" }`                                          |
| anything else, including an unknown npub | **404** `{ "error": "Not found" }`                                                                      |
| store failure                            | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed`                               |
| NIP-05 entry still stale after a re-read | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` with `reason: "nip05_stale"`  |
| note still changing after the photo read | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` with `reason: "note_changed"` |

`Cache-Control: public, max-age=60` on 200, 301, 404 and 410;
`Cache-Control: no-store` on 503.

The 410 body carries no name, so a hidden note's name is not served.

One answer, one state of the note:

- The photos come from one read of the whole set
  (`MessageStore.getPhotoSet`, one `UNION ALL` statement on Postgres).
  `replacePhotos` swaps photo 0 and the extras in one transaction, so
  separate reads of photo 0 and the extras could serve photo 0 of one set
  with the extras of another for 60 s.
- While `nip05Domain` is set, the entry of the shared NIP-05 directory
  (`nip05Directory`, see S2 NIP-05) for the note must carry the name of the
  note read by this request. On the first missing entry or entry with
  another name the request asks once for a forced refresh of the directory
  (at most one computation per 10 s per store set, so a stream of requests
  for a renamed shop cannot each force one) and checks again. When it still
  does not match (the shop was renamed or unlisted between the two reads),
  the route reads the note again: a note that is no longer listed then
  answers 410. A mismatch on the last round (`READ_ROUNDS`) answers the 503 above with
  `reason: "nip05_stale"`, never a 200 that pairs a name with another
  name's NIP-05 or a listed shop with a `null` NIP-05.
- After the photo set the route reads the note again and compares the
  fields the answer is built from: text (listing tag and description), pin (name and place),
  till account id and `deletedAt` (the fields of the in-memory place
  fingerprint). When one differs (a rename, a text or pin change, a new till
  account or a hide while the photos were read), it goes round once more with
  that re-read: a NIP-05 check against the new name, a new photo set read and
  another re-read. When the note still differs on that last round, the answer
  is the 503 above with `reason: "note_changed"`, never a 200 that pairs the
  old name with photos set after the change, cached for 60 s. A photo-only
  change inside the gap needs no round: the unchanged note with either set
  is a state that existed. The photo count of the note is not compared with
  the set read, because `getPhotoSet` leaves out a photo with an unrecognized
  type that the note's `photo_count` still counts. Each extra of the set
  carries its stored index, so a left-out still never shifts the ones after
  it.
- Read bound: at most two rounds, so at most three note reads (the first,
  and one re-read per round, which the next round takes as its note) and
  two photo set reads per request; the NIP-05 directory comes from the
  shared cache, with at most one forced refresh per request (itself
  rate-limited per store set). A 503 does not retry further.

Error texts: the 404 reuses `Not found`, as `GET /pay/:username` does. The 503
gets its own `Shops are unavailable`, following the per-route rule that each
route names its own resource (`Shop activity is unavailable`,
`Messages are unavailable`). The 410 text is new because no other route
answers 410.

`Shop`:

```json
{
  "npub": "npub1…",
  "messageId": "uuid",
  "name": "…",
  "description": "…",
  "place": {
    "lat": 0,
    "lng": 0,
    "label": "…",
    "address": {
      "street": "…",
      "houseNumber": "…",
      "postalCode": "…",
      "city": "…",
      "country": "CH"
    }
  },
  "photos": [{ "url": "https://…/messages/:id/photo.jpg", "width": 1280, "height": 960 }],
  "payUsername": "…",
  "nip05": "…@21.gifts",
  "createdAt": "ISO-8601"
}
```

`lat` and `lng` as in `GET /messages/places`. `address` is always present,
because a listed shop is complete under #478. `payUsername` is the till
account's username when the account has a username and a non-empty linked
Lightning address is stored; otherwise `null`. Whether that address resolves
at payment time is not checked here; the pay page reports that as it does for
accounts.
`nip05` is `null` when `nip05Domain` gives `null`, the same case in which
its kind 0 leaves the field out. Otherwise it comes from the shared NIP-05
directory (`nip05Directory`, cached for 60 s, see the cost and cache under S2
NIP-05). Photo 0 is `/messages/:id/photo.<ext>` and
extra still n ≥ 1 is `/messages/:id/photo/<n>.<ext>` (the routes `forumPhotoUrl`
and `forumExtraPhotoUrl` in `src/lib/nostr/event.ts` use), absolute from
`resolvePublicApiBase`, or the path alone when that is empty.
Photos are the note's photos in note order. `n` is the index the still is
stored under (`message_extra_photo.idx`), not its position in the list: a
still with an unrecognized type is left out of the set and drops only its
own entry, so the stills after it keep their URLs, and an unrecognized
photo 0 leaves the list with the extras alone. `width` and `height` come from a
header-only reader (JPEG `SOF`, PNG `IHDR`, WebP `VP8`/`VP8L`/`VP8X`) that
never decodes the image, so an unauthenticated request cannot make the api
decode up to ten photos. It is new code next to `imageDisplaySize`
(`src/lib/nostr/image.ts`), which decodes PNGs fully and stays as it is. Both
values are `null` when the header cannot be read. For a JPEG whose EXIF
orientation is 5 to 8 the two are swapped, the same displayed size
OpenCryptoPay reports. The orientation is read only from a valid TIFF
header (`II` or `MM` with the magic 42 in that byte order) and an entry of
type `SHORT` with count 1; anything else counts as orientation 1.

### Existing responses

- Public message JSON gains `shopNpub`: the npub when the note is a listed
  shop with a key, otherwise `null`.
- `GET /messages/places` rows gain the same `shopNpub`.

## S4 Shop page `https://21.gifts/{npub}`

- New app route `src/app/[npub]/page.tsx`. `/messages/[id]` shows the forum
  note by its note id, and `/view/[viewKey]` shows a member's profile card by
  a capability key. Neither resolves a shop by the npub that OpenCryptoPay,
  NIP-05 and the kind 0 `website` use, so the shop page is a new route.
  Static routes keep precedence. The segment must match
  `^npub1[02-9ac-hj-np-z]{58}$` or `^[0-9a-f]{64}$`, otherwise `notFound()`.
- `^[0-9a-f]{64}$` asks the api and redirects (308) to `/{npub}` on its 301.
- `generateMetadata` like a public note, with the same 2.5 s timeout
  (`AbortSignal.timeout(2500)` in `src/lib/public-message-og.ts`), `title` =
  shop name,
  description, `og:image` = first photo or `/og.png`, canonical
  `/{npub}`, relative to the root `metadataBase` (`https://21.gifts`), as
  the marketing page sets `/`.
- 404 → the existing not-found page (`src/app/not-found.tsx`). 410 → a "this
  shop is no longer listed" page without a name: unlike the not-found page,
  it tells the visitor that this shop existed, so a shared link does not look
  broken. 503 → the error text and retry button pattern of
  `ExternalAuthorProfile` (`forum.error`, `view.retry`), never a blank page.
- Content: name, description, address as text, a link to the forum note
  (`/messages/<messageId>`) and the NIP-05. The page reuses these
  app components (all in `src/components/` of 21gifts/app):
  - photos: `ForumPhotoGallery`;
  - map: the Google Maps setup of `PlacesMapScreen`, drawing only this
    shop's marker; without a maps key the page shows no map, and the
    address text stays. `PlacesMapScreen` itself is not embedded because it
    loads every place;
  - pay QR: `QrCode` with `openCryptoPayQrValue(payUsername, host)`
    (`src/lib/gifts-address.ts`), with `host` taken as the existing screens
    take it (`window.location.hostname`, otherwise `21.gifts`), so it is the
    same OpenCryptoPay `/pl/?lightning=…` link the app already shows for a
    shop; shown only when `payUsername` is not `null`;
  - npub copy button: the copy control of `ExternalAuthorProfile`.
- The map's link from a pin to its note (`/messages/<id>` in
  `PlacesMapScreen`, 21gifts/app) points to `/{npub}` instead, for a shop
  note. While `shopNpub` is `null` (a listed shop whose key is not created
  yet), it stays `/messages/<messageId>`. The `/shops` table keeps its link
  to `/map?pin=…`.
- All visible text goes through the existing translations.

## S5 OpenCryptoPay push

"Listed" is the only rule for what is on the OpenCryptoPay map. Every push
goes through a durable outbox on `shop_identity`, so a failed request is
repeated and this side never has two place requests, or two photo
requests, for one shop in flight; a place and a photo request can overlap,
and the revision below orders them.
Every request carries a `revision` (OpenCryptoPay R8) from one counter per
shop, so a request that OpenCryptoPay applies late, after the timeout here
dropped it, is refused there instead of overwriting newer state. The outbox
replaces the former fire-and-forget place push (`syncShopOcpPlace` and
`removeShopOcpPlace` over `mapPlacesRequest`, which logged and swallowed
failures); that path is removed. The cases 21gifts/api#494 added to it are
decided by the sender from the note at send time instead: a keyed shop whose
pin and text end up incomplete after concurrent place and text edits, whose
note is hidden or gone after a place, text or till account write, or which
is hidden without a pin when the route read it gets `DELETE`; a pin cleared
and set complete again before the send gets one `PUT`. #494's per-note map
queue in the route is not needed, because the revision orders the requests
of one shop and the last request reflects the last write. A shop without a
key was never sent by the outbox, so nothing is deleted for it.

### Claiming

Both outboxes claim like the existing worker claims (`claimUnsigned` in
`src/lib/conversation-store.ts`): at most `WORKER_BATCH` rows per place pass
(the photo sender one row per pass, see below), a lease of `WORKER_LEASE_MS`
(`src/lib/nostr/worker.ts`) on a `claimed_until` column,
`SELECT … FOR UPDATE SKIP LOCKED`. Two things differ, because two requests
for one shop must never be in flight at once:

- The lease is set and compared with the database clock
  (`claimed_until = now() + WORKER_LEASE_MS`, claimable when it is null or
  `<= now()`), not with each instance's own clock as `claimUnsigned` does.
  Instances whose clocks differ then still agree on when a lease ends.
- Every claim raises its counter (`ocp_place_claim`, `ocp_photos_claim`) and
  returns it as the claim token `c`, together with the generation `g`. The
  existing claims need no token because their writes are idempotent; here a
  request that outlived its lease could otherwise overwrite newer state on
  OpenCryptoPay.

Rules for every claim:

- Every write after a claim, including releasing it, is conditional on the
  token `c`. A worker whose lease was taken over writes nothing.
- Before each request, the worker raises `ocp_revision` (conditional on
  `c`) and sends the new value as `revision`. Place and photo requests share
  this counter, so OpenCryptoPay accepts them only in the order they were
  sent.
- The photo sender raises it only while, in the same `UPDATE`, the place is
  not pending (`NOT ocp_place_pending`) and `ocp_photos_generation` is still
  its `g`. The photo claim checks that the place is not pending only when
  it claims; a hide or another place change can come in while the sender
  reads the photos, and the place sender may already have reserved its
  revision for the `DELETE`. Without this check the photo request would
  take the next revision, reach OpenCryptoPay after the `DELETE`, and the
  `DELETE` would be stale. When the check fails, the photo sender releases
  its claim and sends nothing; the flag and `ocp_photos_hash` stay (unless
  the place sender's reset before a `DELETE` cleared them), and the photos
  follow once the place is confirmed again.
- Right before sending, the worker checks, by the database clock, that the
  lease still has at least the request timeout plus 10 s left; otherwise it
  releases the claim and skips the row for this pass.
  The 10 s cover the time between that check and the request starting, so a
  request that runs to its full timeout still ends before another worker can
  claim the row. For photos the check runs before the bytes are read and
  again after.
- The photo sender does not run in the fast tick, which starts every 2 s
  without waiting for the previous one. It runs as its own serialised pass
  that schedules the next one only when it is done, as `runIngestPass`
  (`src/lib/nostr/worker.ts`) does for the ingest, and claims one row per
  pass. The next pass starts `WORKER_INTERVAL_MS` (2 s) after the previous
  one settled, also when it found no row or released one, so an empty queue
  is not a busy loop. Each instance therefore has at most one photo upload
  in flight, and the paged start-up pass does not send every shop's photos
  at once.
- The place sender runs serialised the same way, with its own timer: the
  next pass of at most `WORKER_BATCH` rows starts `WORKER_INTERVAL_MS`
  after the previous one settled, also after a failure. A slow pass
  (database or OpenCryptoPay) therefore never stacks further passes; each
  instance has at most one place pass in flight. A pass settles only after
  every claimed row has settled: a row whose handling throws before its
  request (a store read, say) logs `ocp.place.failed` with its message id
  and keeps its flag, while the pass still waits for the other rows'
  requests. Stopping the worker
  clears both timers, and a pass still in flight then schedules no other.
- Every write after a claim that clears a pending flag or stores a hash is
  also conditional on the generation `g`, including the writes of the paths
  that send nothing; if a newer change was queued meanwhile, the worker only
  releases the claim, and the newer change is sent next.

### Place outbox

- **Queueing.** Every store write that changes the text, pin, till account
  or `deleted_at` of a note that has a `shop_identity` row also sets
  `ocp_place_pending` and raises `ocp_place_generation` in the same
  transaction, as its own statement after the write has locked the message
  row, so it sees a `shop_identity` row that a concurrent key insert has
  just committed. That covers the writes named in S1, `DELETE /messages/:id`
  (staff hide) and the cascade hide of an external author
  in `blockPubkeyAndHideRows`. S1 queues a shop when it creates its key.
  Implemented as the row trigger `trg_shop_identity_place`
  (`AFTER UPDATE OF` those columns on `message`, only when a value
  changed): its `UPDATE shop_identity` runs inside the writing transaction
  after the row lock, and as a PL/pgSQL statement it takes a fresh snapshot,
  so it sees a key insert that committed while the write waited. The
  trigger covers every write path, including the cascade hide, without
  changing `blockPubkeyAndHideRows`. The in-memory adapter has no
  transactions and derives the same queue from a fingerprint of each note
  before every call that syncs its queue. The photo fingerprint is the
  photo revision of the in-memory message store
  (`InMemoryMessageStore.photoRevision`): a counter raised by every write
  that changes a recognized still (photo 0 or an extra: index, content type
  or bytes; a still with an unrecognized type is not part of the set) and left
  unchanged by a write that stores the same stills. A sync therefore reads
  no photo bytes, so a public read (`GET /shops/:npub`, the NIP-05 list)
  does not read the photos of every shop. A change and its exact revert
  between two syncs queue once, as the triggers queue each write. Only over
  a message store of another class (a test double, or a store a caller
  passes to `createApp` without a shop store) does the adapter hash the set
  from one read of the whole set (`MessageStore.getPhotoSet`).
- **Sending.** The worker decides at send time, from the note as it is then:
  a listed shop gets `PUT /map/places` with its `nostrPubkey` (64 lowercase
  hex), anything else gets `DELETE /map/places`. No earlier decision is
  stored, so a stale queue entry cannot remove a listed shop. Before it
  sends a `DELETE`, it sets `ocp_photos_hash` to null, clears
  `ocp_photos_pending` and raises `ocp_photos_generation`, conditional only
  on the token `c`, so a photo push still in flight fails its generation
  check and cannot store a hash afterwards. OpenCryptoPay may drop the
  photos even when the answer is lost or a newer change makes the result
  write a no-op, and a null hash makes the next confirmed `PUT` send the
  photos again. It uses the 5 s timeout of the former `mapPlacesRequest`
  (`OCP_PLACE_TIMEOUT_MS`, `src/lib/ocp-outbox.ts:22`).
- **Results.**
  - `PUT` 2xx: in one statement, clear the pending flag (conditional on
    `g`) and queue the photo push (set `ocp_photos_pending`, raise
    `ocp_photos_generation`), so a crash cannot confirm the place without
    queueing its photos.
  - `PUT` 201, which OpenCryptoPay answers when this request created the
    place (for example after a `DELETE` it applied late): the place had no
    photos there, so the worker sets `ocp_photos_hash` to null, raises
    `ocp_photos_generation` and sets `ocp_photos_pending`, conditional only
    on the token `c`, like the reset before a `DELETE`. Only the clearing of
    the place flag still depends on `g`.
  - `DELETE` 2xx: clear the pending flag; the photo state was already reset
    before sending.
  - 409 `Stale revision`: a newer request for this shop was already
    applied; the worker only releases the claim.
  - 400 or 409 whose body is empty, only whitespace or cannot be read: no
    verdict. Log `ocp.place.failed` with the message id and status, keep
    the flag and do not release the claim; the next attempt follows when
    the lease (`WORKER_LEASE_MS`) ends.
  - 400 `Place field is not allowed: nostrPubkey` or
    `Place field is not allowed: revision`: OpenCryptoPay does not run
    openCryptoPay/api#26 yet. Log `ocp.place.deferred` with the message id
    and the error, keep the flag and do not release the claim, so the place
    is sent again when the lease (`WORKER_LEASE_MS`, 60 s) ends, about once
    a minute. Its `DELETE` ignores unknown fields, so a `DELETE` succeeds
    there; should it answer the same 400, it is deferred the same way.
  - Any other 400 or 409 with a readable body: log
    `ocp.place.rejected` with the message id and clear the flag. It is sent
    again only after the next change.
  - Any other answer, a network error or a timeout (401 and 5xx included):
    log `ocp.place.failed` and keep the flag; the next attempt
    follows when the lease ends.
- **Start-up.** `queueAllShopPlaces` (`src/lib/ocp-outbox.ts`) walks every
  `shop_identity` row with keyset paging (by `message_id`, 200 per page,
  `OCP_STARTUP_PAGE`) and queues it; it replaces the former single read of
  at most 1000 pins by `publishExistingShopPlaces`. It decides nothing itself; the worker does at send
  time. `startOcpOutboxWorker` runs it at boot and, when a page read fails,
  logs `ocp.place.failed` with `pass: 'startup'`, `attempt`, `retryInMs` and
  the safe error fields, and runs it again after `WORKER_INTERVAL_MS`,
  doubling the delay up to `WORKER_LEASE_MS`, until one attempt succeeds. A
  retry resumes at the failed page (after the last message id of the last
  queued page), so a transient error on a later page no longer leaves the
  remaining rows unqueued until the next restart, and the earlier pages are
  queued once, not re-sent with new revisions. Its `stop` cancels a pending
  retry.
- **Places without a key.** Places the old push sent without a key stay on
  OpenCryptoPay as stored rows, and its step 1a keeps them off the public
  list. When such a note gets a key, its first `PUT` carries the same
  `externalId` and adds the key there. No separate delete is sent for them,
  so nothing outside the outbox writes to OpenCryptoPay.
- **Account merge.** `mergeAccounts` already moves `message.shop_account_id`
  to the surviving account through its generic rewrite of every
  single-column foreign key to `account` (`src/lib/account-merge.ts:382-404`),
  so a merge keeps the shop listed. The place trigger queues that change
  like any other till account change, so the merge re-sends the same place
  once; nothing else is queued. A regression test covers that column.

### Photo push

- **Queueing.** A successful place `PUT` (above) sets `ocp_photos_pending`
  and raises `ocp_photos_generation`. Every store write that changes the
  photos of a listed note does the same: `replacePhotos`
  (`PATCH /messages/:id/photos`) and `updatePhoto` (the profile note's
  first photo, `src/routes/me.ts`). The queueing runs in the same
  transaction as the photo write, only when the note is listed, so a crash
  cannot lose the change, and the worker never reads the old set under the
  new generation. Implemented as the row triggers `trg_shop_identity_cover`
  (photo 0 on `message`) and `trg_shop_identity_extra_photo`
  (`message_extra_photo`); they check the listed shape the database can see
  (live, top-level, till account, complete pin columns, shop tag), and the
  photo sender clears the flag without a request for a note that the text
  rules of #478 do not list.
- **Claiming.** As above, with `ocp_photos_claimed_until` and
  `ocp_photos_claim`. A row whose place is still pending is skipped, so
  photos only follow a confirmed place.
- **Sending.**
  - A shop that is not listed any more gets its flag cleared and nothing is
    sent.
  - It computes the SHA-256 over the photo set, read in one statement
    (`MessageStore.getPhotoSet`), so the hash and the request never mix
    photo 0 of one set with the extras of another. If it equals
    `ocp_photos_hash`, it clears the flag and sends nothing.
  - Otherwise it first reserves the revision (see above). A refused
    reservation leaves `ocp_photos_hash` as it was, so an unchanged set is
    not sent again. After the reservation it sets `ocp_photos_hash` to null,
    conditional only on the token `c`, so an answer that is lost or loses
    the generation check leaves no hash that could hide a different set on
    OpenCryptoPay. Then it sends up to 10 photos, in note order (every
    still the set returns, by stored index; a still with an unrecognized
    type drops only itself, photo 0 included, so a set with only recognized
    types gives the same list, and the same `ocpPhotoSetHash`, as the stored
    order), with
    `PUT /map/places/photos` as
    `{ origin: "21gifts", nostrPubkey, revision, photos: [{ contentType, data }] }`,
    `data` being the stored bytes in base64. 21.gifts allows at most 10
    photos of 1 MiB, about 13.3 MiB in base64, under that route's 15 MiB
    body limit. An empty set is sent as an empty list.
  - It uses its own 30 s timeout instead of the 5 s place timeout, because
    the body can reach about 13.3 MiB while a place body is a few fields of
    text.
- **Results.**
  - 200: store the sent hash and clear the flag, both only while `g` still
    matches; otherwise the hash stays null and the next pass sends again.
    OpenCryptoPay may skip single
    photos it does not accept and lists them in its answer; those are logged
    as `ocp.photos.skipped` and not retried for this set.
  - 409 `Stale revision`: a newer request for this shop was already
    applied; the worker sets the hash to null and only releases the claim.
  - 400 or 413: store the sent hash, clear the flag (both only while `g`
    still matches) and log `ocp.photos.rejected`. The same set is not sent
    again.
  - 404 `{"error":"Place not found"}` (openCryptoPay/api#26 does not know a
    place with this key): set the hash to null, clear the flag, and, if the
    shop is still listed, queue the place (set `ocp_place_pending`, raise
    `ocp_place_generation`). The confirmed place `PUT` then queues the
    photos again.
  - Any other 404: an OpenCryptoPay API without openCryptoPay/api#26 has no
    photo route and answers the framework's plain `404 Not Found`. Log
    `ocp.photos.deferred` with the message id, the status, the fixed
    reason `route_missing` and the body length (never the body itself, which
    is upstream text), keep the flag and do not release the claim, so
    the photos are tried again when the lease (60 s) ends. If the shop is
    still listed, also queue the place and set its lease to the end of the
    photo lease, without raising `ocp_place_claim`: such an API accepted the
    place but dropped `nostrPubkey`, so the place must be sent again once
    openCryptoPay/api#26 is live. The place is claimed when that lease ends,
    and the photo row is not claimed while its place is pending, so a shop
    costs at most one place `PUT` and one photo request per minute; neither
    lane loops, and the set is never dropped.
  - Any other answer, a network error or a timeout: log `ocp.photos.failed`
    and keep the flag; the next attempt follows when the lease ends.

### Rollout

Deploy order: openCryptoPay/api#26 and 21gifts/app#646 go live first, then
this API.

- openCryptoPay/api#26 requires `nostrPubkey` on every place write, accepts
  the strictly increasing `revision`, and provides `PUT /map/places/photos`.
- 21gifts/app#646 is S4, the shop page. Every shop kind 0 publishes
  `website` as `<site origin>/{npub}` (S2), and the staging spec allowed that
  npub `website` only once the page is live. Deploying the app change
  first satisfies that: no kind 0 points at a page that does not exist
  yet.

Should this API boot before openCryptoPay/api#26 is live, the push is only
delayed, not dropped. Both OpenCryptoPay versions without #26 are handled:

- The `develop` branch checks the allowed place fields and answers each
  place `PUT` with `Place field is not allowed: nostrPubkey`. The place
  sender defers it (`ocp.place.deferred`) and retries it about once a
  minute; the photos follow the first confirmed place.
- `main`, which production runs, has no such check: it stores the place
  with 200 or 201 and drops `nostrPubkey` and `revision`. It has no
  `PUT /map/places/photos` either and answers the photo request with a plain
  `404 Not Found`. The photo sender defers the set (`ocp.photos.deferred`)
  and queues the place again behind the photo lease, so each shop gets one
  place `PUT` and one photo request about once a minute. Once #26 is live,
  the next place `PUT` stores the key and the photos follow it.

The `shop_identity` outbox columns, all queueing writes, both senders and the
paged start-up pass deploy together. The old `syncShopOcpPlace`, `removeShopOcpPlace` and
`publishExistingShopPlaces` path is removed. `SHOP_PLACE_PUSH_ENABLED` stays
`true`; only the durable outbox uses the resolved target.

## Order of work

0. 21gifts/api#478: complete shops with a structured address.
1. S1 and S2: shop keys, backfill, profiles, NIP-05.
2. S3: `GET /shops/:npub`, `shopNpub`.
3. S5 ships in this same release with both outboxes, both senders and start-up.
4. S4 is 21gifts/app#646 (open); it goes live before this API.
5. Shop kind 0 uses `<site origin>/{npub}`.

S1, S2, S3 and S5 are one pull request and one release in this repository.
This pull request meets the handbook, e2e and 100% coverage gates of this
repo's `CONTRIBUTING.md`; S4 (21gifts/app#646) meets those of 21gifts/app.

## Not part of this

- Shop-signed notes, or zaps to a shop key.
- Handing a shop key to its owner.
- A separate photo set for the shop beyond the note's photos.
