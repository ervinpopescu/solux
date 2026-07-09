// Column-major 4×4 multiply in double precision: out = a · b.
// Used by both custom WebGL layers to fold MapLibre's MVP with the local-metre
// model matrix before uploading as float32 — keeping the large origin
// translation accurate while the GPU only multiplies small numbers.
export function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
