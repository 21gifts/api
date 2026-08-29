import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { runNostrWorkerTick, startNostrWorker } from '@/lib/nostr/worker';

const KEK = parseNostrKek('cd'.repeat(32));

async function seed(): Promise<{
  auth: InMemoryAuthStore;
  messages: InMemoryMessageStore;
}> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: 1,
  });
  await ensureAccountNostrKey(auth, 'acc', KEK);
  const messages = new InMemoryMessageStore();
  await messages.create({
    id: 'm1',
    accountId: 'acc',
    name: 'Ada',
    text: 'hello',
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    ...unsignedNostrDefaults(),
  });
  return { auth, messages };
}

describe('runNostrWorkerTick', () => {
  it('signs without publishing when NOSTR_PUBLISH is off', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env: {},
    });
    const row = await messages.getById('m1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.calls).toHaveLength(0);
  });

  it('publishes to space when NOSTR_PUBLISH=1', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env,
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_060_000,
      env,
    });
    expect(publisher.calls.length).toBeGreaterThan(0);
    expect(publisher.calls[0]?.urls).toEqual(['wss://relay.nostr.space']);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
    const afterFirst = publisher.calls.length;
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_120_000,
      env,
    });
    expect(publisher.calls.length).toBe(afterFirst);
  });

  it('marks published when public ACK is present', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env,
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_060_000,
      env,
    });
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('parks when public relays are on but only space ACKs', async () => {
    const { auth, messages } = await seed();
    const space = 'wss://relay.nostr.space';
    const publisher: RecordingPublisher = new RecordingPublisher();
    publisher.publish = async (event, urls, _timeoutMs) => {
      publisher.calls.push({ event, urls });
      return Promise.resolve(urls.map((url) => ({ url, ok: url === space })));
    };
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env,
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_060_000,
      env,
    });
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
  });

  it('bumps created_at when two notes collide on event id', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'm2',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1_700_000_000_000,
      env: {},
    });
    const first = await messages.getById('m1');
    const second = await messages.getById('m2');
    expect(first?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).not.toBe(first?.eventId);
  });

  it('stops signing after two event-id collisions', async () => {
    const { auth, messages } = await seed();
    messages.updateSignedEvent = async (): Promise<boolean> => false;
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1_700_000_000_000,
      env: {},
    });
    expect((await messages.getById('m1'))?.eventId).toBeNull();
  });

  it('logs nack when space rejects', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env,
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_060_000,
      env,
    });
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('logs nack when publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async () => {
      throw new Error('ws down');
    };
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_000_000,
      env,
    });
    await runNostrWorkerTick({
      messages,
      auth,
      kek: KEK,
      publisher,
      now: () => 1_700_000_060_000,
      env,
    });
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('backfills a missing key with a valid KEK', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc2',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await runNostrWorkerTick({
      messages: new InMemoryMessageStore(),
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1,
      env: {},
    });
    expect(await auth.getNostrPublicKey('acc2')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs keygen backfill failure when the KEK is the wrong size', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await runNostrWorkerTick({
      messages: new InMemoryMessageStore(),
      auth,
      kek: new Uint8Array(16),
      publisher: new RecordingPublisher(),
      now: () => 1,
      env: {},
    });
    expect(await auth.getNostrPublicKey('acc')).toBeUndefined();
  });
});

describe('startNostrWorker', () => {
  it('returns a stop handle', () => {
    const handle = startNostrWorker(
      {
        messages: new InMemoryMessageStore(),
        auth: new InMemoryAuthStore(),
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 0,
        env: {},
      },
      60_000,
    );
    handle.stop();
  });
});
