// Minimal ambient declaration — `tz-lookup` ships untyped CommonJS.
// Signature: `function(lat: number, lng: number): string` (throws on
// unmappable inputs).
declare module 'tz-lookup' {
  const tzLookup: (lat: number, lng: number) => string;
  export default tzLookup;
}
