import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { newId } from "./db.js";

/**
 * AES-256-GCM for tokens at rest. The key lives only in MASTER_KEY (32 bytes,
 * base64); the database alone yields ciphertext. key_id allows rotation later.
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(masterKeyB64: string) {
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    this.key = key;
    this.keyId = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 8);
  }

  seal(plaintext: string, aad: string): { keyId: string; iv: string; ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { keyId: this.keyId, iv: iv.toString("base64"), ciphertext: body.toString("base64") };
  }

  open(sealed: { keyId: string; iv: string; ciphertext: string }, aad: string): string {
    if (sealed.keyId !== this.keyId) throw new Error(`secret sealed with key ${sealed.keyId}, MASTER_KEY is ${this.keyId}`);
    const body = Buffer.from(sealed.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  }
}

/** Stores a secret and returns its id; only this module and the caller ever see the plaintext. */
export function putSecret(db: Database, box: SecretBox, userId: string, purpose: string, plaintext: string): string {
  const id = newId();
  const sealed = box.seal(plaintext, `${purpose}:${id}`);
  db.query("INSERT INTO secrets (id, user_id, key_id, iv, ciphertext, aad, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, userId, sealed.keyId, sealed.iv, sealed.ciphertext, purpose, Date.now(),
  );
  return id;
}

export function getSecret(db: Database, box: SecretBox, id: string): string {
  const row = db.query("SELECT * FROM secrets WHERE id = ?").get(id) as
    | { key_id: string; iv: string; ciphertext: string; aad: string }
    | null;
  if (row === null) throw new Error(`secret ${id} not found`);
  return box.open({ keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext }, `${row.aad}:${id}`);
}

export function deleteSecret(db: Database, id: string): void {
  db.query("DELETE FROM secrets WHERE id = ?").run(id);
}

/** Last four characters, for showing which token is stored without revealing it. */
export function fingerprint(token: string): string {
  return `…${token.slice(-4)}`;
}
