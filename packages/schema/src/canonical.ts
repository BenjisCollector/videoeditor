import { createHash } from "node:crypto";

// SCHEMA-04 — semantic determinism.
//
// Anthropic API has no `seed` parameter and `temperature=0` alone does not
// produce byte-identical output. Determinism must be achieved in our own code
// via a canonical post-processing pass:
//
//   1. canonicalize(obj): sorted keys + floats rounded to 3 decimals
//   2. deterministicClipUuid(namespace, key): UUID v5 over a stable namespace +
//      key so newly-introduced clips get reproducible ids across repeat
//      generations.
//
// Both helpers operate on plain JSON-compatible values. They are pure (no side
// effects) and framework-agnostic.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// UUID v5 namespace for clip identity, stable per project scope.
// Generated once via `crypto.randomUUID()` and then frozen — do NOT regenerate.
export const CLIP_NAMESPACE = "a5b6f3e4-8d2c-4f11-9a77-0017c3b72e00";

/**
 * Canonicalize a JSON-compatible value into a stable string.
 *
 * Rules:
 *  - Object keys sorted alphabetically
 *  - Numbers that are floats rounded to 3 decimal places (stabilizes against
 *    JS floating-point drift across runs)
 *  - Integers left exact
 *  - NaN and Infinity rejected (not representable in canonical JSON)
 *  - Arrays preserved in insertion order
 *
 * Output is UTF-8 encodable and parseable by JSON.parse.
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(canonicalizeValue(obj));
}

function canonicalizeValue(v: unknown): JsonValue {
  if (v === null) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`canonicalize: non-finite number ${String(v)}`);
    }
    if (Number.isInteger(v)) return v;
    // Round to 3 decimals; avoid -0.
    const rounded = Math.round(v * 1000) / 1000;
    return rounded === 0 ? 0 : rounded;
  }
  if (Array.isArray(v)) {
    return v.map(canonicalizeValue);
  }
  if (typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: { [key: string]: JsonValue } = {};
    for (const k of Object.keys(src).sort()) {
      const child = src[k];
      if (child === undefined) continue; // drop undefined so JSON round-trip stable
      out[k] = canonicalizeValue(child);
    }
    return out;
  }
  throw new Error(`canonicalize: unsupported type ${typeof v}`);
}

/**
 * Deterministic UUID v5 for a clip given a namespace and a stable key.
 *
 * Same (namespace, key) always yields the same UUID, across processes and
 * machines. Used when Claude generates a plan that introduces a new clip —
 * if the same plan is regenerated with the same inputs, untouched clips get
 * the same ids.
 *
 * Implements RFC 4122 §4.3 (name-based UUID v5 with SHA-1).
 */
export function deterministicClipUuid(namespace: string, key: string): string {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(key, "utf8");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(nameBytes)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version (5) and variant (RFC 4122) per §4.3
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`deterministicClipUuid: bad namespace ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(b: Buffer): string {
  const hex = b.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}
