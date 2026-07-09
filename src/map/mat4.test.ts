import { describe, expect, it } from 'vitest';
import { mat4Mul } from './mat4';

// Column-major convention: element [c*4+r] is column c, row r.

function identity(): number[] {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

describe('mat4Mul', () => {
  it('I × I = I', () => {
    expect(mat4Mul(identity(), identity())).toEqual(identity());
  });

  it('M × I = M', () => {
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(mat4Mul(m, identity())).toEqual(m);
  });

  it('I × M = M', () => {
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(mat4Mul(identity(), m)).toEqual(m);
  });

  it('uniform scale × uniform scale = squared scale', () => {
    const scale = (s: number): number[] => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
    const result = mat4Mul(scale(3), scale(3));
    expect(result).toEqual(scale(9));
  });

  it('translation matrices compose correctly', () => {
    // Translation by (tx, ty, tz) in column-major: column 3 holds [tx, ty, tz, 1].
    const translate = (tx: number, ty: number, tz: number): number[] => [
      1, 0, 0, 0, // col 0
      0, 1, 0, 0, // col 1
      0, 0, 1, 0, // col 2
      tx, ty, tz, 1, // col 3
    ];
    expect(mat4Mul(translate(1, 2, 3), translate(4, 5, 6))).toEqual(translate(5, 7, 9));
  });

  it('returns a plain number[] of length 16', () => {
    const result = mat4Mul(identity(), identity());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(16);
  });
});
