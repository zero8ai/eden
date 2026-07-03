/**
 * ID generation — the one way to mint an identifier in Eden.
 *
 * 12 chars from [a-zA-Z] via nanoid: URL-safe with no escaping or casing ambiguity in logs,
 * and far shorter than a UUID while still collision-proof at our scale (52^12 ≈ 3.9e20; ~1%
 * collision odds would need ~90 quadrillion ids). Works in both server and browser code.
 *
 * Convention: NEW identifiers — table PKs, client-side keys, external references — use
 * `newId()`, never crypto.randomUUID(). Existing uuid-typed columns keep their DB-side
 * defaults (no migration); a new table's PK should be `text("id").primaryKey().$defaultFn(newId)`.
 */
import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Mint a new 12-char [a-zA-Z] id. */
export const newId = customAlphabet(ALPHABET, 12);
