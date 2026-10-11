/*
 * Software authenticator for tests: a real ES256 (P-256) key pair producing W3C WebAuthn L3 registration
 * ("none" attestation) and assertion responses that @simplewebauthn/server verifies for real — so tests
 * exercise the actual signature, challenge, origin, RP ID, UV-flag and counter checks.
 */
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export const TEST_ORIGIN = "http://localhost:8081";
export const TEST_RP_ID = "localhost";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentialId: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter: number;

  /**
   * `privateKeyPkcs8` (base64url PKCS#8 DER) + `credentialId` (base64url) restore a persisted authenticator
   * (the sim CLI keeps one per persona); otherwise a fresh P-256 key pair and credential id are generated.
   */
  constructor(opts: { counter?: number; privateKeyPkcs8?: string; credentialId?: string } = {}) {
    if (opts.privateKeyPkcs8) {
      this.privateKey = createPrivateKey({ key: Buffer.from(opts.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
    } else {
      this.privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    }
    const jwk = createPublicKey(this.privateKey).export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
    this.credentialId = opts.credentialId ? Buffer.from(opts.credentialId, "base64url") : randomBytes(16);
    this.counter = opts.counter ?? 0;
  }

  /** Persistable form (secret: the private key). Restore with `new SoftAuthenticator(exported)`. */
  export(): { privateKeyPkcs8: string; credentialId: string; counter: number } {
    return { privateKeyPkcs8: b64u(this.privateKey.export({ format: "der", type: "pkcs8" })), credentialId: this.id, counter: this.counter };
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  /** base64url COSE public key, as stored in the credential tables. */
  publicKeyB64u(): string {
    return b64u(this.coseKey());
  }

  /** COSE_Key (RFC 9053) for ES256: kty=2 (EC2), alg=-7, crv=1 (P-256), x, y. */
  private coseKey(): Uint8Array {
    const m = new Map<number, number | Uint8Array>();
    m.set(1, 2);
    m.set(3, -7);
    m.set(-1, 1);
    m.set(-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url")));
    m.set(-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url")));
    return isoCBOR.encode(m as never);
  }

  private authData(opts: { rpId: string; uv: boolean; attested: boolean; counter: number }): Buffer {
    const flags = 0x01 | (opts.uv ? 0x04 : 0) | (opts.attested ? 0x40 : 0); // UP, UV, AT
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(opts.counter);
    const parts: Buffer[] = [sha256(opts.rpId), Buffer.from([flags]), counter];
    if (opts.attested) {
      const credLen = Buffer.alloc(2);
      credLen.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), credLen, this.credentialId, Buffer.from(this.coseKey()));
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, opts: { origin?: string; rpId?: string } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin: opts.origin ?? TEST_ORIGIN, crossOrigin: false }),
    );
    const authData = this.authData({ rpId: opts.rpId ?? TEST_RP_ID, uv: true, attested: true, counter: this.counter });
    const attObj = new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", new Uint8Array(authData)],
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(isoCBOR.encode(attObj as never)),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  /** Assertion over `challenge`. Increments the counter unless it stays 0 (synced-passkey behaviour). */
  assert(challenge: string, opts: { origin?: string; rpId?: string; uv?: boolean; counter?: number } = {}) {
    const counter = opts.counter ?? (this.counter === 0 ? 0 : ++this.counter);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: opts.origin ?? TEST_ORIGIN, crossOrigin: false }),
    );
    const authData = this.authData({ rpId: opts.rpId ?? TEST_RP_ID, uv: opts.uv ?? true, attested: false, counter });
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey); // DER ECDSA
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }
}
