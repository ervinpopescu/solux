// Building shadows rendered as a pure WebGL custom layer.
//
// The hard problem this layer solves is *overlap*. A single building's shadow
// is emitted as many overlapping triangles (footprint + projected roof + swept
// sides — see `shadowGeometry.ts`), and neighbouring buildings' shadows overlap
// each other too. Blending all of that translucently would darken overlaps
// multiple times, producing ugly banded silhouettes.
//
// So we render in two passes:
//
//   1. STENCIL MASK. Draw every shadow triangle with colour writes OFF, setting
//      the stencil to 1 wherever any triangle covers a pixel (stencilOp REPLACE,
//      func ALWAYS). Overlap is irrelevant — a pixel is either shadowed (1) or
//      not (0). Depth testing is left ON so real buildings occlude the ground
//      shadow behind them rather than the wash bleeding over their faces.
//
//   2. WASH. Draw one fullscreen triangle with a single translucent dark colour,
//      gated by stencil EQUAL 1. Every shadowed pixel is darkened exactly once.
//
// Coordinate handling mirrors the sun-path arc: geometry is authored in local
// metres and combined with a double-precision model matrix on the CPU, so the
// GPU only ever multiplies small numbers (avoids the web-mercator float32
// precision problem). We likewise use `defaultProjectionData.mainMatrix`, not
// `modelViewProjectionMatrix`, for the mercator→clip transform.

import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput } from 'maplibre-gl';
import type { LatLng } from '../../types';
import {
  buildStaticShadowMesh,
  sunShadowOffsetPerMetre,
  nightFactorForAltitude,
  shadowOpacityForAltitude,
  type ShadowBuilding,
} from '../shadowGeometry';
import { mat4Mul } from '../mat4';

export const SHADOW_LAYER_ID = 'building-shadow-layer';

export interface ShadowLayerHandle {
  customLayer: CustomLayerInterface;
  /** Replace the set of footprints casting shadows (e.g. after new tiles load). */
  setBuildings: (buildings: ShadowBuilding[]) => void;
  /** Update the sun direction; sets extrusion offset uniforms. Below-horizon hides them. */
  setSun: (azimuthRad: number, altitudeRad: number) => void;
}

// ── Shaders ──────────────────────────────────────────────────────────────────

// Mask pass: transform ground triangles; fragment colour is discarded (colour
// writes are masked off), we only care about the stencil side effect.
const MASK_VERT = `#version 300 es
  in vec3 a_pos;
  uniform mat4 u_mvp;
  uniform vec2 u_offset; // (oxPerM, ozPerM)
  void main() {
    // a_pos is (x, h, z), where h is the extrusion factor.
    vec3 finalPos = vec3(a_pos.x + u_offset.x * a_pos.y, 0.0, a_pos.z + u_offset.y * a_pos.y);
    gl_Position = u_mvp * vec4(finalPos, 1.0);
  }
`;
const MASK_FRAG = `#version 300 es
  precision mediump float;
  out vec4 fragColor;
  void main() { fragColor = vec4(0.0); }
`;

// Wash pass: a single fullscreen triangle in clip space, tinted uniformly.
const WASH_VERT = `#version 300 es
  in vec2 a_clip;
  void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;
const WASH_FRAG = `#version 300 es
  precision mediump float;
  uniform vec4 u_color;
  out vec4 fragColor;
  void main() { fragColor = u_color; }
`;

// Oversized clip-space triangle covering the whole viewport.
const FULLSCREEN_TRI = new Float32Array([-1, -1, 3, -1, -1, 3]);

// Translucent shadow tint (rgb) and its peak opacity. Kept subtle so
// overlapping city blocks read as shade rather than blackout; alpha is applied
// once thanks to the stencil, and scaled by the altitude fade so low-sun
// shadows dissolve toward the horizon.
const SHADOW_COLOR: [number, number, number] = [0.02, 0.03, 0.07];
const SHADOW_MAX_ALPHA = 0.7;

// ── Night wash ───────────────────────────────────────────────────────────────
//
// Once the sun is too low to cast usable shadows, the scene is "unlit" — so
// instead of the shadow mesh we fade in a full-viewport night wash. The ramp
// itself (0→1 vs sun altitude) lives in shadowGeometry as `nightFactorForAltitude`;
// here we just pick the tint and peak opacity. Deep-navy reads as night sky
// bounced onto the city rather than a flat black veil.
const NIGHT_COLOR: [number, number, number] = [0.015, 0.025, 0.06];
const NIGHT_MAX_ALPHA = 0.82;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[solux] shadow shader:', gl.getShaderInfoLog(s));
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vsrc: string, fsrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[solux] shadow program link:', gl.getProgramInfoLog(p));
  }
  return p;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createShadowLayer(
  pin: LatLng,
  onShadowDraw?: (vertexCount: number) => void,
): ShadowLayerHandle {
  const origin = maplibregl.MercatorCoordinate.fromLngLat({ lng: pin.lng, lat: pin.lat }, 0);
  const S = origin.meterInMercatorCoordinateUnits();
  const oz = origin.z ?? 0;

  // Same local-metre → mercator model matrix as the arc (X=east, Y=up, Z=south).
  const modelMatrix: number[] = [S, 0, 0, 0, 0, 0, S, 0, 0, S, 0, 0, origin.x, origin.y, oz, 1];

  // ── State that drives the mesh ────────────────────────────────────────────
  let buildings: ShadowBuilding[] = [];
  let offset: [number, number] | null = null; // per-metre shadow offset, or null
  let mesh: Float32Array = new Float32Array(0);
  let vertexCount = 0;
  // Night-wash opacity derived from the sun altitude; 0 during the day, ramping
  // up through twilight (see nightFactorForAltitude).
  let nightAlpha = 0;
  // Building-shadow opacity derived from the sun altitude; 1 while the sun is
  // high, fading to 0 at the horizon so low shadows dissolve into the night.
  let shadowAlpha = 0;

  // ── WebGL objects ─────────────────────────────────────────────────────────
  let gl: WebGL2RenderingContext | null = null;
  let maskProg: WebGLProgram | null = null;
  let washProg: WebGLProgram | null = null;
  let meshBuf: WebGLBuffer | null = null;
  let fsBuf: WebGLBuffer | null = null;
  let aPos = -1;
  let aClip = -1;
  let uMvp: WebGLUniformLocation | null = null;
  let uOffset: WebGLUniformLocation | null = null;
  let uColor: WebGLUniformLocation | null = null;
  let storedMap: maplibregl.Map | undefined;

  // Recompute the mesh only when buildings change.
  function rebuild() {
    mesh = buildings.length ? buildStaticShadowMesh(buildings) : new Float32Array(0);
    vertexCount = mesh.length / 3;
    if (gl && meshBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    }
    storedMap?.triggerRepaint();
  }

  const customLayer: CustomLayerInterface = {
    id: SHADOW_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, glCtx) {
      storedMap = map;
      gl = glCtx as WebGL2RenderingContext;

      maskProg = linkProgram(gl, MASK_VERT, MASK_FRAG);
      washProg = linkProgram(gl, WASH_VERT, WASH_FRAG);
      aPos = gl.getAttribLocation(maskProg, 'a_pos');
      uMvp = gl.getUniformLocation(maskProg, 'u_mvp');
      uOffset = gl.getUniformLocation(maskProg, 'u_offset');
      aClip = gl.getAttribLocation(washProg, 'a_clip');
      uColor = gl.getUniformLocation(washProg, 'u_color');

      meshBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);

      fsBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf);
      gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRI, gl.STATIC_DRAW);
    },

    render(_gl, options: CustomRenderMethodInput) {
      if (!gl || !maskProg || !washProg) return;
      // Nothing to draw when there's no visible shadow (no footprints, or the
      // altitude fade has taken opacity to ~0) and no night wash is due.
      const hasShadows = vertexCount > 0 && shadowAlpha > 0.01;
      if (!hasShadows && nightAlpha <= 0) return;

      gl.bindVertexArray(null);
      gl.disable(gl.CULL_FACE);

      // ── Building shadows (only while the sun is high enough to cast them) ────
      if (hasShadows) {
        const mvp = mat4Mul(options.defaultProjectionData.mainMatrix, modelMatrix);

        // Pass 1: stencil mask. Reset the stencil in our own region; MapLibre
        // re-establishes its stencil state before each of its own layers.
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
        gl.clearStencil(0);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

        // Colour off; depth ON (read-only) so buildings occlude ground shadow.
        gl.colorMask(false, false, false, false);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);

        gl.useProgram(maskProg);
        gl.uniformMatrix4fv(uMvp, false, new Float32Array(mvp));
        gl.uniform2f(uOffset, offset?.[0] ?? 0, offset?.[1] ?? 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
        onShadowDraw?.(vertexCount);

        // Pass 2: wash — one translucent tint over the stencilled pixels.
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(washProg);
        gl.uniform4f(
          uColor,
          SHADOW_COLOR[0],
          SHADOW_COLOR[1],
          SHADOW_COLOR[2],
          SHADOW_MAX_ALPHA * shadowAlpha,
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf);
        gl.enableVertexAttribArray(aClip);
        gl.vertexAttribPointer(aClip, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.disable(gl.STENCIL_TEST);
      }

      // ── Night wash (fades in through twilight as the sun sinks) ─────────────
      // A plain full-viewport tint over the whole scene — no stencil, no depth —
      // so buildings and ground darken together. Drawn below the arc layer, so
      // the glowing sun-path stays visible over the night scene.
      if (nightAlpha > 0) {
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.colorMask(true, true, true, true);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(washProg);
        gl.uniform4f(uColor, NIGHT_COLOR[0], NIGHT_COLOR[1], NIGHT_COLOR[2], nightAlpha);
        gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf);
        gl.enableVertexAttribArray(aClip);
        gl.vertexAttribPointer(aClip, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // Restore state MapLibre's subsequent layers expect.
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    },

    onRemove() {
      if (!gl) return;
      if (meshBuf) gl.deleteBuffer(meshBuf);
      if (fsBuf) gl.deleteBuffer(fsBuf);
      if (maskProg) gl.deleteProgram(maskProg);
      if (washProg) gl.deleteProgram(washProg);
    },
  };

  return {
    customLayer,
    setBuildings(next) {
      buildings = next;
      rebuild();
    },
    setSun(azimuthRad, altitudeRad) {
      offset = sunShadowOffsetPerMetre(azimuthRad, altitudeRad);
      shadowAlpha = shadowOpacityForAltitude(altitudeRad);
      nightAlpha = nightFactorForAltitude(altitudeRad) * NIGHT_MAX_ALPHA;
      storedMap?.triggerRepaint(); // mesh is static, just repaint with new uniforms
    },
  };
}
