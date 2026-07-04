// ==============================================================================
// Geographic primitives
// ==============================================================================
//
// Tiny helpers for distance and bearing on the WGS-84 sphere. We only need
// short-range accuracy (≤ 1–2 km) so we use the haversine formula and the
// standard initial-bearing formula — both exact for an idealized sphere and
// well under one part per million for radii we care about.

import type { LatLng } from '../types';

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6_378_137;

/**
 * Great-circle distance between two coordinates, in metres.
 */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const lat1 = a.lat * RAD;
  const lat2 = b.lat * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing from `from` to `to`, in degrees clockwise from north.
 * Matches SunCalc's azimuth convention (0 = N, 90 = E, 180 = S, 270 = W).
 */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const lat1 = from.lat * RAD;
  const lat2 = to.lat * RAD;
  const dLng = (to.lng - from.lng) * RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const brng = Math.atan2(y, x) / RAD;
  return (brng + 360) % 360;
}
