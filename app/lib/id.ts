/**
 * ID generation — the one way to mint an identifier in Eden.
 *
 * 12 chars from [a-zA-Z] via nanoid: URL-safe with no escaping or casing ambiguity in logs,
 * and far shorter than a UUID while still collision-proof at our scale (52^12 ≈ 3.9e20; ~1%
 * collision odds would need ~90 quadrillion ids). Works in both server and browser code.
 *
 * Convention: ALL identifiers — table PKs, client-side keys, external references — use
 * `newId()`, never crypto.randomUUID(). Every table PK is
 * `text("id").primaryKey().$defaultFn(newId)`; rows minted before the cutover keep their
 * old UUID strings (columns were converted uuid → text in place).
 */
import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Mint a new 12-char [a-zA-Z] id. */
export const newId = customAlphabet(ALPHABET, 12);
