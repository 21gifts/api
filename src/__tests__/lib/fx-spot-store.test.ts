import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { FxSpotQuote } from '@/lib/fx-spot';
import {
  BTC_FIAT_SPOT_SCHEMA_SQL,
  InMemoryFxSpotStore,
  PostgresFxSpotStore,
  migrateFxSpotSchema,
} from '@/lib/fx-spot-store';

const QUOTE: FxSpotQuote = {
  asOf: '2026-10-07T12:00:00.000Z',
  source: 'coinbase-exchange-rates',
  rates: { USD: '62345.12', CHF: '55000.5', EUR: '57000', PHP: '3500000.12' },
};

function recordingClient(rows: unknown[] = []): {
  client: SqlClient;
  executes: { text: string; params: readonly unknown[] }[];
  queries: string[];
} {
  const executes: { text: string; params: readonly unknown[] }[] = [];
  const queries: string[] = [];
  const client: SqlClient = {
    async query<T>(text: string): Promise<T[]> {
      queries.push(text);
      return rows as T[];
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      executes.push({ text, params });
    },
  };
  return { client, executes, queries };
}

describe('migrateFxSpotSchema', () => {
  it('runs the single-row table DDL', async () => {
    const { client, executes } = recordingClient();
    await migrateFxSpotSchema(client);
    expect(executes.map((e) => e.text)).toEqual([...BTC_FIAT_SPOT_SCHEMA_SQL]);
    expect(executes[0]?.text).toContain('CREATE TABLE IF NOT EXISTS btc_fiat_spot');
    expect(executes[0]?.text).toContain('CHECK (id = 1)');
  });
});

describe('InMemoryFxSpotStore', () => {
  it('is empty without a seed', async () => {
    await expect(new InMemoryFxSpotStore().latest()).resolves.toBeNull();
  });

  it('returns the seed and replaces it on save', async () => {
    const store = new InMemoryFxSpotStore(QUOTE);
    await expect(store.latest()).resolves.toEqual(QUOTE);
    const next: FxSpotQuote = { ...QUOTE, asOf: '2026-10-07T12:05:00.000Z', rates: { USD: '1' } };
    await store.save(next);
    await expect(store.latest()).resolves.toEqual(next);
  });

  it('keeps a newer quote when an older one is saved later', async () => {
    const newer: FxSpotQuote = { ...QUOTE, asOf: '2026-10-07T12:05:00.000Z', rates: { USD: '2' } };
    const store = new InMemoryFxSpotStore(newer);
    await store.save({ ...QUOTE, rates: { USD: '1' } });
    await expect(store.latest()).resolves.toEqual(newer);
  });

  it('keeps only the four currencies and hands out copies', async () => {
    const rates = { USD: '1', JPY: '2' } as FxSpotQuote['rates'];
    const store = new InMemoryFxSpotStore();
    await store.save({ ...QUOTE, rates });
    const first = await store.latest();
    expect(first?.rates).toEqual({ USD: '1' });
    if (first !== null) {
      first.rates.USD = '999';
    }
    expect((await store.latest())?.rates).toEqual({ USD: '1' });
  });
});

describe('PostgresFxSpotStore', () => {
  it('upserts the one row with every currency, missing ones as null', async () => {
    const { client, executes } = recordingClient();
    const store = new PostgresFxSpotStore(client);
    await store.save(QUOTE);
    await store.save({ ...QUOTE, rates: { USD: '62000' } });
    await store.save({ ...QUOTE, rates: { PHP: '3500000' } });
    expect(executes[0]?.text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(executes[0]?.text).toContain('WHERE btc_fiat_spot.as_of <= EXCLUDED.as_of');
    expect(executes[0]?.params).toEqual([
      '62345.12',
      '55000.5',
      '57000',
      '3500000.12',
      'coinbase-exchange-rates',
      '2026-10-07T12:00:00.000Z',
    ]);
    expect(executes[1]?.params).toEqual([
      '62000',
      null,
      null,
      null,
      'coinbase-exchange-rates',
      '2026-10-07T12:00:00.000Z',
    ]);
    expect(executes[2]?.params.slice(0, 4)).toEqual([null, null, null, '3500000']);
  });

  it('returns null when the row does not exist', async () => {
    const { client, queries } = recordingClient([]);
    await expect(new PostgresFxSpotStore(client).latest()).resolves.toBeNull();
    expect(queries[0]).toContain('FROM btc_fiat_spot');
  });

  it('returns null when the row holds no rate', async () => {
    const { client } = recordingClient([
      { usd: null, chf: null, eur: null, php: null, source: 's', as_of: new Date(0) },
    ]);
    await expect(new PostgresFxSpotStore(client).latest()).resolves.toBeNull();
  });

  it('maps a Date as_of and omits null currencies', async () => {
    const { client } = recordingClient([
      {
        usd: '62345.12',
        chf: null,
        eur: '57000',
        php: null,
        source: 'coinbase-exchange-rates',
        as_of: new Date('2026-10-07T12:00:00.000Z'),
      },
    ]);
    await expect(new PostgresFxSpotStore(client).latest()).resolves.toEqual({
      asOf: '2026-10-07T12:00:00.000Z',
      source: 'coinbase-exchange-rates',
      rates: { USD: '62345.12', EUR: '57000' },
    });
  });

  it('maps a text as_of', async () => {
    const { client } = recordingClient([
      {
        usd: '1',
        chf: '2',
        eur: '3',
        php: '4',
        source: 'coinbase-exchange-rates',
        as_of: '2026-10-07 12:00:00+00',
      },
    ]);
    await expect(new PostgresFxSpotStore(client).latest()).resolves.toEqual({
      asOf: '2026-10-07T12:00:00.000Z',
      source: 'coinbase-exchange-rates',
      rates: { USD: '1', CHF: '2', EUR: '3', PHP: '4' },
    });
  });
});
