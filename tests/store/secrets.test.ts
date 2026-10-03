import { describe, expect, it } from "bun:test";
import { memoryDb } from "../../src/store/db.js";
import { fingerprint, getSecret, putSecret, SecretBox } from "../../src/store/secrets.js";

const key = Buffer.alloc(32, 1).toString("base64");

describe("secrets", () => {
  it("round-trips through the database without storing plaintext", () => {
    const db = memoryDb();
    const box = new SecretBox(key);
    const id = putSecret(db, box, "u1", "github-token", "ghp_example_value");
    const row = db.query("SELECT * FROM secrets WHERE id = ?").get(id) as { ciphertext: string };
    expect(row.ciphertext).not.toContain("ghp_example_value");
    expect(getSecret(db, box, id)).toBe("ghp_example_value");
  });

  it("refuses a ciphertext moved to another row (aad binds it to its id)", () => {
    const db = memoryDb();
    const box = new SecretBox(key);
    const a = putSecret(db, box, "u1", "github-token", "one");
    const b = putSecret(db, box, "u1", "github-token", "two");
    db.query("UPDATE secrets SET iv = (SELECT iv FROM secrets WHERE id = ?), ciphertext = (SELECT ciphertext FROM secrets WHERE id = ?) WHERE id = ?").run(a, a, b);
    expect(() => getSecret(db, box, b)).toThrow();
  });

  it("refuses the wrong master key", () => {
    const db = memoryDb();
    const id = putSecret(db, new SecretBox(key), "u1", "x", "secret");
    expect(() => getSecret(db, new SecretBox(Buffer.alloc(32, 2).toString("base64")), id)).toThrow(/sealed with key/);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new SecretBox("c2hvcnQ=")).toThrow(/32 bytes/);
  });

  it("fingerprint shows only the tail", () => {
    expect(fingerprint("ghp_abcdef1234")).toBe("…1234");
  });
});
