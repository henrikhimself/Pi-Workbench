import { randomInt } from "node:crypto";

/** Leaves out characters small vision models confuse: 0/O/D/Q, 1/I/L/J, 2/Z, 5/S, 6/G, 8/B and U/V. */
export const VISION_TOKEN_ALPHABET = "ACEFHKMNPRTWXY3479";

/** Ground-truth token for the live vision gate: no look-alike characters and no adjacent doubles. */
export function visionToken(length = 6, pick = max => randomInt(max)) {
  let chars = "";
  while (chars.length < length) {
    const next = VISION_TOKEN_ALPHABET[pick(VISION_TOKEN_ALPHABET.length)];
    if (next !== chars.at(-1)) chars += next;
  }
  return `WBV-${chars}`;
}
