import { describe, expect, it } from 'vitest';
import { resolveMapPush, shopOcpPlaceInput } from '@/lib/ocp-place';

const place = {
  lat: 47.3,
  lng: 8.5,
  label: 'Coffee Lab',
  address: {
    street: 'Main Street',
    houseNumber: '1',
    postalCode: '8001',
    city: 'Zürich',
    country: 'CH',
  },
};

describe('shopOcpPlaceInput', () => {
  it('maps one complete shop and rejects incomplete input', () => {
    expect(
      shopOcpPlaceInput(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Fresh coffee roasted here every morning. #21GiftsShop',
        place,
      ),
    ).toMatchObject({
      origin: '21gifts',
      externalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Coffee Lab',
      lon: 8.5,
    });
    expect(shopOcpPlaceInput('id', '#21GiftsShop', place)).toBeNull();
  });
});

describe('resolveMapPush', () => {
  it('requires both settings and trims the target', () => {
    const fetchImpl = async (): Promise<Response> => new Response('{}');
    expect(resolveMapPush({}, fetchImpl)).toBeUndefined();
    expect(resolveMapPush({ OCP_MAP_BASE_URL: 'https://map.test' }, fetchImpl)).toBeUndefined();
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: ' https://map.test/ ', OCP_PLACE_INGEST_TOKEN: ' token ' },
        fetchImpl,
      ),
    ).toEqual({ baseUrl: 'https://map.test', token: 'token', fetchImpl });
  });
});
