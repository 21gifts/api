# Shop identity

Status: **concept only**. Decided 2026-10-17. Not implemented. No HTTP path
in this document is reserved. A later change that builds this adds its routes
to `SPEC.md` in that same change. Nothing here changes runtime behaviour.

That change also adds the `shopNpub` field on existing responses to
`SPEC.md`, the new table to `docs/schema/` and its functions and routes to the
handbook.

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
- has `shop_account_id` set;
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
  listed shop for the first time: today `POST /messages`,
  `PATCH /messages/:id/text`, `PATCH /messages/:id/place`,
  `PATCH /messages/:id/shop-account` and the staff restore
  `POST /debug/messages/:id/restore`.
  - A failure logs `shop.nostr_key.failed` with the message id and does not
    fail the request, the same as the lazy account key at login.
  - The worker backfill also picks up listed shops without a key, at most 20
    per tick, oldest note first, next to the existing account backfill.
    After it creates a key, it queues the OpenCryptoPay place push of S5
    for that shop, so a failed mint at the write is repaired without another
    edit.
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

### Storage

New table `shop_identity`. The key columns have the same names as on
`account`:

| Column                     | Type                   | Rule                                             |
| -------------------------- | ---------------------- | ------------------------------------------------ |
| `message_id`               | `uuid PRIMARY KEY`     | `REFERENCES message (id)`                        |
| `nostr_pubkey`             | `text NOT NULL UNIQUE` | 64 lowercase hex                                 |
| `nostr_nsec_ciphertext`    | `bytea NOT NULL`       | Envelope below                                   |
| `nostr_kek_id`             | `integer NOT NULL`     | Only `1`                                         |
| `nostr_key_custody`        | `text NOT NULL`        | `CHECK` `custodial` or `user`; `custodial`       |
| `nostr_key_created_at`     | `timestamptz NOT NULL` | Set on insert                                    |
| `profile_name`             | `text NOT NULL`        | Shop name, rewritten whenever the shop is listed |
| `ocp_photos_hash`          | `text NULL`            | SHA-256 of the photo set last answered by S5     |
| `ocp_photos_pending`       | `boolean NOT NULL`     | Default `false`; a photo push is due (S5)        |
| `ocp_photos_generation`    | `integer NOT NULL`     | Default `0`; raised by every S5 trigger          |
| `ocp_photos_claimed_until` | `timestamptz NULL`     | Photo push claimed until then (S5)               |
| `ocp_photos_claim`         | `integer NOT NULL`     | Default `0`; raised by every photo claim (S5)    |
| `ocp_place_pending`        | `boolean NOT NULL`     | Default `false`; a place push is due (S5)        |
| `ocp_place_generation`     | `integer NOT NULL`     | Default `0`; raised by every place change (S5)   |
| `ocp_place_claimed_until`  | `timestamptz NULL`     | Place push claimed until then (S5)               |
| `ocp_place_claim`          | `integer NOT NULL`     | Default `0`; raised by every place claim (S5)    |

`MessageStore.deleteById` can hard-delete a top-level note, for example when
its video file is missing. It deletes nothing for a note that has a
`shop_identity` row, the same way it already keeps a credit note with sats,
and its callers treat that note like any other kept row. So the reference
never dangles and the identity is never deleted.

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

### Custody

Custodial, like every account key in v1. The shop key only signs the shop's
kind 0 and kind 10002. The shop note itself stays a kind 1 from its author's
account key, unchanged. Handing a shop key to its owner belongs to the open
custodial-to-user step of Open Question #9 in `CONCEPT.md`.

## S2 Profile

The worker publishes a profile for **every** `shop_identity` row, listed or
not, in the same loop and with the same rules as account profiles
(`publishProfiles` in `src/lib/nostr/worker.ts`):

- same interval and batch size, same `NOSTR_PUBLISH` and
  `NOSTR_PUBLISH_PUBLIC` switches, same relays, kind 0 and kind 10002 also to
  `wss://purplepag.es`;
- published only when the content differs from the in-memory cache;
- `created_at` = `max(now, last + 1)`; a failure in the required write set
  clears the cache entry, while the `wss://purplepag.es` copy stays best
  effort, as for accounts.

Kind 0 content of a listed shop:

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| `name`         | shop name                                                              |
| `display_name` | shop name                                                              |
| `about`        | shop description                                                       |
| `picture`      | absolute URL of `/messages/:id/photo`, otherwise the account fallback  |
| `banner`       | absolute URL of `/messages/:id/photo/1.<ext>`, otherwise `/og.png`     |
| `website`      | `https://21.gifts/{npub}`                                              |
| `nip05`        | `<local>@<domain>`, see below                                          |
| `lud16`        | the `lud16` of the till account's own kind 0; omitted when it has none |

Kind 0 of a shop that is no longer listed:

- `name` and `display_name`: `profile_name`, the name it had when it was last
  listed. If the note is hidden or deleted, `Shop` instead, so a name staff
  removed is not kept on the relays.
- `about`: `This shop is no longer listed on 21.gifts.`
- `website`: unchanged.
- `picture`, `banner`, `nip05` and `lud16` are dropped.
- There is no kind 5 deletion.

Kind 10002 lists the same write relays as an account's.

The `lud16` is a plain Lightning address. The till account's LNURL response
is unchanged, so this spec adds no zap receipts for a shop key.

### NIP-05

- Listed shops join the existing `/.well-known/nostr.json` (api route and the
  app proxy).
- The local part comes from `allocateNip05Local(shopName, messageId, taken)`,
  the same slug and the same collision suffix as accounts.
- Accounts are allocated first, then shops by `nostr_key_created_at` and
  then `message_id`, so the order is the same on every run. An
  account never loses its local part to a shop.
- The local part follows the current shop name. A rename, or a new account
  that takes the slug, gives the shop a new local part, and its kind 0 is
  published again.

## S3 API

### `GET /shops/:npub`

New. `GET /messages/:id` keeps serving a note by its note id. This route
resolves a shop by its NOSTR identity, the id that OpenCryptoPay, NIP-05 and
the shop page use, and answers for a shop that is no longer listed with 410.

No session; a missing or invalid bearer gets the same answer. Registered
after `GET /shops/activity`, so `activity` keeps its own handler. It takes any
single path segment and validates it inside the handler, so every other value
gets the 404 body and headers below.

| Request                                  | Response                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| npub of a listed shop                    | **200** `{ "shop": Shop }`                                                |
| 64 lowercase hex of a known shop pubkey  | **301** to `/shops/{npub}`                                                |
| npub of a known shop that is not listed  | **410** `{ "error": "Shop is no longer listed", "npub": "…" }`            |
| anything else, including an unknown npub | **404** `{ "error": "Not found" }`                                        |
| store failure                            | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` |

`Cache-Control: public, max-age=60` on 200, 301, 404 and 410;
`Cache-Control: no-store` on 503.

The 410 body carries no name, so a hidden note's name is not served.

Error texts: the 404 reuses `Not found`, as `GET /pay/:username` does. The 503
gets its own `Shops are unavailable`, following the per-route rule that each
route names its own resource (`Shop activity is unavailable`,
`Messages are unavailable`). The 410 text is new because no route answers 410
today.

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
  "photos": [{ "url": "https://…/messages/:id/photo", "width": 1280, "height": 960 }],
  "payUsername": "…",
  "nip05": "…@21.gifts",
  "createdAt": "ISO-8601"
}
```

`lat` and `lng` as in `GET /messages/places`. `address` is always present,
because a listed shop is complete under #478. `payUsername` is the till
account's username when the account has a username and a non-empty linked
Lightning address is stored; otherwise `null`. Whether that address resolves
at payment time is not checked here; the pay page reports that as it does
today.
Photos are the note's photos in note order. `width` and `height` come from a
header-only reader (JPEG `SOF`, PNG `IHDR`, WebP `VP8`/`VP8L`/`VP8X`) that
never decodes the image, so an unauthenticated request cannot make the api
decode up to ten photos. It is new code next to `imageDisplaySize`
(`src/lib/nostr/image.ts`), which decodes PNGs fully and stays as it is. Both
values are `null` when the header cannot be read. For a JPEG whose EXIF
orientation is 5 to 8 the two are swapped, the same displayed size
OpenCryptoPay reports.

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
  `https://21.gifts/{npub}`.
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
- The shops page (`/shops`) and the map link each shop to `/{npub}` instead
  of the note. While `shopNpub` is `null` (a listed shop whose key is not
  created yet), the link stays `/messages/<messageId>`.
- All visible text goes through the existing translations.

## S5 OpenCryptoPay push

"Listed" is the only rule for what is on the OpenCryptoPay map. Every push
goes through a durable outbox on `shop_identity`, so a failed or late request
is repeated and requests for one shop never overtake each other. The
fire-and-forget place push of today (`syncShopOcpPlace` and
`removeShopOcpPlace` over `mapPlacesRequest`, which logs and swallows
failures) is replaced by it.

### Claiming

Both outboxes claim like the existing worker claims (`claimUnsigned` in
`src/lib/conversation-store.ts`): at most `WORKER_BATCH` rows per tick, a
lease of `WORKER_LEASE_MS` (`src/lib/nostr/worker.ts`) on a `claimed_until`
column, `SELECT … FOR UPDATE SKIP LOCKED`. In addition, every claim raises
its counter (`ocp_place_claim`, `ocp_photos_claim`) and returns it as the
claim token `c`, together with the generation `g`. The existing claims have
no token because their writes are idempotent; here a request that outlived
its lease could otherwise overwrite newer state on OpenCryptoPay.

- Every write after a claim, including releasing it, is conditional on the
  token `c`. A worker whose lease was taken over writes nothing.
- Right before sending, the worker checks by the database clock that the
  lease still has at least the request timeout plus 10 s left; otherwise it
  releases the claim and skips the row this tick. For photos the bytes are
  read before this check.
- Results that change state are also conditional on the generation `g`; if
  a newer change was queued meanwhile, the worker only releases the claim,
  and the newer change is sent next.

### Place outbox

- **Queueing.** Every store write that changes the text, pin, till account
  or `deleted_at` of a note that has a `shop_identity` row also sets
  `ocp_place_pending` and raises `ocp_place_generation` in the same
  transaction. That covers the writes named in S1, `DELETE /messages/:id`
  (staff hide or author delete) and the cascade hide of an external author
  in `blockPubkeyAndHideRows`, which already returns the hidden ids. S1
  queues a shop when it creates its key.
- **Sending.** The worker decides at send time, from the note as it is then:
  a listed shop gets `PUT /map/places` with its `nostrPubkey` (64 lowercase
  hex), anything else gets `DELETE /map/places`. No earlier decision is
  stored, so a stale queue entry cannot remove a listed shop. It keeps the
  5 s timeout of `mapPlacesRequest` (`src/lib/ocp-place.ts`).
- **Results.**
  - `PUT` 2xx: clear the pending flag, then queue the photo push (set
    `ocp_photos_pending`, raise `ocp_photos_generation`).
  - `DELETE` 2xx: clear the pending flag, and, because OpenCryptoPay drops
    the photos with the place, set `ocp_photos_hash` to null, clear
    `ocp_photos_pending` and raise `ocp_photos_generation`. A shop that is
    listed again therefore sends its photos again.
  - 400 or 409: log `ocp.place.rejected` with the message id and clear the
    flag. It is sent again only after the next change.
  - Any other answer, a network error or a timeout (401 and 5xx included):
    log `ocp.place.failed` as today and keep the flag; the next attempt
    follows when the lease ends.
- **Start-up.** Instead of today's single read of at most
  `EXISTING_SHOP_PLACE_LIMIT` (1000) pins, `publishExistingShopPlaces` walks
  every `shop_identity` row with keyset paging (by `message_id`, 200 per
  page) and queues it. It decides nothing itself; the worker does at send
  time.
- **Places without a key.** Places the old push sent without a key stay on
  OpenCryptoPay as stored rows, and its step 1a keeps them off the public
  list. When such a note gets a key, its first `PUT` carries the same
  `externalId` and adds the key there. No separate delete is sent for them,
  so nothing outside the outbox writes to OpenCryptoPay.
- **Account merge.** `mergeAccounts` already moves `message.shop_account_id`
  to the surviving account through its generic rewrite of every
  single-column foreign key to `account` (`src/lib/account-merge.ts:382-404`),
  so a merge keeps the shop listed and queues nothing. The implementing
  change adds a regression test for that column.

### Photo push

- **Queueing.** A successful place `PUT` (above), and
  `PATCH /messages/:id/photos` on a listed shop, set `ocp_photos_pending`
  and raise `ocp_photos_generation`.
- **Claiming.** As above, with `ocp_photos_claimed_until` and
  `ocp_photos_claim`. A row whose place is still pending is skipped, so
  photos only follow a confirmed place.
- **Sending.**
  - A shop that is not listed any more gets its flag cleared and nothing is
    sent.
  - It computes the SHA-256 over the photo set. If it equals
    `ocp_photos_hash`, it clears the flag and sends nothing.
  - Otherwise it sends up to 10 photos, in note order, with
    `PUT /map/places/photos` as `{ nostrPubkey, photos: [{ contentType, data }] }`,
    `data` being the stored bytes in base64. 21.gifts allows at most 10
    photos of 1 MiB, about 13.3 MiB in base64, under that route's 15 MiB
    body limit. An empty set is sent as an empty list.
  - It uses its own 30 s timeout instead of the 5 s place timeout, because
    the body can reach about 13.3 MiB while a place body is a few fields of
    text.
- **Results.**
  - 200: store the hash and clear the flag. OpenCryptoPay may skip single
    photos it does not accept and lists them in its answer; those are logged
    as `ocp.photos.skipped` and not retried for this set.
  - 400 or 413: store the hash, clear the flag and log
    `ocp.photos.rejected`. The same set is not sent again.
  - 404 (OpenCryptoPay does not know the place): set the hash to null, clear
    the flag, and, if the shop is still listed, queue the place (set
    `ocp_place_pending`, raise `ocp_place_generation`). The confirmed place
    `PUT` then queues the photos again.
  - Any other answer, a network error or a timeout: log `ocp.photos.failed`
    and keep the flag; the next attempt follows when the lease ends.

### Rollout

OpenCryptoPay first accepts `nostrPubkey` and lists only shops that have one
(its step 1a), then adds the photo route (step 2), and only then rejects
writes without a key (step 1b). This change deploys after 1a and 2 and before
1b. Until it is live, 21.gifts shops are off the OpenCryptoPay list.

## Order of work

0. 21gifts/api#478: complete shops with a structured address.
1. S1 and S2: shop keys, backfill, profiles, NIP-05.
2. S3: `GET /shops/:npub`, `shopNpub`.
3. S5: place outbox with `nostrPubkey`, PUT or DELETE decided at send time,
   paged start-up, photo push.
4. S4 in `21gifts/app`.

Each step is one pull request with the handbook, e2e tests and the coverage
gate from `CONTRIBUTING.md`.

## Not part of this

- Shop-signed notes, or zaps to a shop key.
- Handing a shop key to its owner.
- A separate photo set for the shop beyond the note's photos.
