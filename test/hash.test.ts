/*
 * canonicalJson / stableHash — key-order independence and stability, since
 * these hashes are the controller↔daemon change detector.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, stableHash } from '../src/util/hash.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}]}');
  });

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('stableHash', () => {
  it('is independent of key insertion order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ x: { m: 1, n: [{ q: 1, p: 2 }] } })).toBe(
      stableHash({ x: { n: [{ p: 2, q: 1 }], m: 1 } }),
    );
  });

  it('is stable across calls and shaped like sha256 hex', () => {
    const doc = { name: 'at-x', tsreadex: { programNumber: 333 } };
    const h = stableHash(doc);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(stableHash(doc)).toBe(h);
  });

  it('differs for different values and for different array order', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it('treats a missing key and an undefined key identically', () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
  });
});
