/**
 * Software passkey for the loan cycle.
 *
 * Builds a none-attestation P-256 credential the API's WebAuthn check accepts
 * (user verification required, RP id localhost, origin http://localhost:3000).
 * The private key stays in the caller's state file, outside the repo.
 */
import { createHash, generateKeyPairSync, sign as signDer, webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';

const ORIGIN = 'http://localhost:3000';
const RP_ID = 'localhost';

/**
 * @returns {{ id: Buffer, privateKeyPem: string, publicKey: import('node:crypto').KeyObject }}
 */
export function createPasskey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    id: Buffer.from(randomId()),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
}

/**
 * @param {{ id: Buffer, publicKey: import('node:crypto').KeyObject }} passkey
 * @param {string} challenge
 * @returns {Record<string, unknown>}
 */
export function registrationResponse(passkey, challenge) {
  const clientData = clientDataJson('webauthn.create', challenge);
  const authData = attestedAuthData(passkey);
  const attestationObject = encodeMap([
    [encodeText('fmt'), encodeText('none')],
    [encodeText('attStmt'), Buffer.from([0xa0])],
    [encodeText('authData'), encodeBytes(authData)],
  ]);
  const id = passkey.id.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: clientData.toString('base64url'),
      attestationObject: attestationObject.toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

/**
 * @param {{ id: Buffer, privateKeyPem: string }} passkey
 * @param {string} challenge
 * @returns {Record<string, unknown>}
 */
export function authenticationResponse(passkey, challenge) {
  const clientData = clientDataJson('webauthn.get', challenge);
  const authData = assertionAuthData();
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  const signature = signDer('sha256', signed, passkey.privateKeyPem);
  const id = passkey.id.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

/**
 * @param {string} type
 * @param {string} challenge
 * @returns {Buffer}
 */
function clientDataJson(type, challenge) {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }),
  );
}

/**
 * @param {{ id: Buffer, publicKey: import('node:crypto').KeyObject }} passkey
 * @returns {Buffer}
 */
function attestedAuthData(passkey) {
  const jwk = passkey.publicKey.export({ format: 'jwk' });
  const cose = coseKey(Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'));
  const rpHash = createHash('sha256').update(RP_ID).digest();
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(passkey.id.byteLength, 0);
  return Buffer.concat([
    rpHash,
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    credLen,
    passkey.id,
    cose,
  ]);
}

/**
 * @returns {Buffer}
 */
function assertionAuthData() {
  return Buffer.concat([
    createHash('sha256').update(RP_ID).digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
}

/**
 * @param {Buffer} x
 * @param {Buffer} y
 * @returns {Buffer}
 */
function coseKey(x, y) {
  return encodeMap([
    [Buffer.from([0x01]), Buffer.from([0x02])],
    [Buffer.from([0x03]), Buffer.from([0x26])],
    [Buffer.from([0x20]), Buffer.from([0x01])],
    [Buffer.from([0x21]), encodeBytes(x)],
    [Buffer.from([0x22]), encodeBytes(y)],
  ]);
}

/**
 * @param {Buffer[]} pairs
 * @returns {Buffer}
 */
function encodeMap(pairs) {
  if (pairs.length >= 24) {
    throw new Error('cbor map too large');
  }
  return Buffer.concat([Buffer.from([0xa0 | pairs.length]), ...pairs.flat()]);
}

/**
 * @param {string} text
 * @returns {Buffer}
 */
function encodeText(text) {
  const bytes = Buffer.from(text);
  if (bytes.byteLength >= 24) {
    throw new Error('cbor text too large');
  }
  return Buffer.concat([Buffer.from([0x60 | bytes.byteLength]), bytes]);
}

/**
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function encodeBytes(bytes) {
  if (bytes.byteLength < 24) {
    return Buffer.concat([Buffer.from([0x40 | bytes.byteLength]), bytes]);
  }
  if (bytes.byteLength < 256) {
    return Buffer.concat([Buffer.from([0x58, bytes.byteLength]), bytes]);
  }
  throw new Error('cbor bytes too large');
}

/**
 * @returns {Uint8Array}
 */
function randomId() {
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  return bytes;
}
