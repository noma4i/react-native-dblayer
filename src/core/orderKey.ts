/**
 * Lexical fractional order keys: the single home for every scope order key. Keys are base62
 * strings over a codepoint-monotonic alphabet, compared with plain string comparison
 * (`compareCodepoints`); between any two keys a third always exists, so point insertion never
 * renumbers neighbours and precision has no limit.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
/** Sequence sizing never needs keys longer than this; 62^8 slots stay inside safe integers. */
const MAX_SEQUENCE_KEY_LENGTH = 8;

/**
 * Generate a key strictly between `lower` and `upper` under codepoint comparison.
 * @param lower Exclusive lower bound; `undefined` means "before every key".
 * @param upper Exclusive upper bound; `undefined` means "after every key".
 * @returns A non-empty base62 key that never ends with the minimal digit, so a key before it always exists.
 * @throws When the bounds are inverted or not base62.
 */
export const keyBetween = (lower: string | undefined, upper: string | undefined): string => {
  let prefix = '';
  for (let index = 0; ; index += 1) {
    const lowerCharacter = lower?.[index] ?? ALPHABET[0]!;
    const upperCharacter = upper?.[index] ?? ALPHABET.at(-1)!;
    if (lowerCharacter === upperCharacter) {
      prefix += lowerCharacter;
      continue;
    }
    const lowerIndex = ALPHABET.indexOf(lowerCharacter);
    const upperIndex = ALPHABET.indexOf(upperCharacter);
    if (lowerIndex < 0 || upperIndex < 0 || lowerIndex > upperIndex) throw new Error('Invalid fractional order bounds');
    if (upperIndex - lowerIndex > 1) return `${prefix}${ALPHABET[Math.floor((lowerIndex + upperIndex) / 2)]!}`;
    return `${prefix}${lowerCharacter}${lower?.slice(index + 1) ?? ''}${ALPHABET[Math.floor(BASE / 2)]!}`;
  }
};

/** Generate a key strictly before `key` (a prepend placement). */
export const keyBefore = (key: string | undefined): string => keyBetween(undefined, key);

/** Generate a key strictly after `key` (an append placement). */
export const keyAfter = (key: string | undefined): string => keyBetween(key, undefined);

const paddedValue = (key: string, length: number): number => {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    const digit = index < key.length ? ALPHABET.indexOf(key[index]!) : 0;
    if (digit < 0) throw new Error('Invalid fractional order bounds');
    value = value * BASE + digit;
  }
  return value;
};

const toKey = (value: number, length: number): string => {
  let remaining = value;
  let key = '';
  for (let index = 0; index < length; index += 1) {
    key = ALPHABET[remaining % BASE]! + key;
    remaining = Math.floor(remaining / BASE);
  }
  return key;
};

/**
 * Generate `count` strictly increasing keys evenly distributed between the bounds - the rebuild
 * path for complete landings and order resets. Even distribution keeps keys short where a chained
 * `keyBetween` walk would degrade one character per insertion.
 * @param count Number of keys; non-positive counts return an empty array.
 * @param lower Exclusive lower bound; `undefined` means "before every key".
 * @param upper Exclusive upper bound; `undefined` means "after every key".
 * @returns Deterministic keys of one shared length, none ending with the minimal digit.
 */
export const keysForSequence = (count: number, lower?: string, upper?: string): string[] => {
  if (count <= 0) return [];
  let length = Math.max(1, lower?.length ?? 0, upper?.length ?? 0);
  const boundsAt = (size: number): { floor: number; ceiling: number } => ({
    floor: lower === undefined ? -1 : paddedValue(lower, size),
    ceiling: upper === undefined ? BASE ** size : paddedValue(upper, size)
  });
  let bounds = boundsAt(length);
  while (bounds.ceiling - bounds.floor < 2 * (count + 1)) {
    length += 1;
    if (length > MAX_SEQUENCE_KEY_LENGTH) throw new Error('Order key sequence exceeds addressable space');
    bounds = boundsAt(length);
  }
  const step = Math.floor((bounds.ceiling - bounds.floor) / (count + 1));
  const keys: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const value = bounds.floor + step * index;
    keys.push(toKey(value % BASE === 0 ? value + 1 : value, length));
  }
  return keys;
};
