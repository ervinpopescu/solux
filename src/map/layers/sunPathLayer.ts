// Sun path arc rendered as a pure WebGL custom layer.
//
// Three.js was removed: sharing a WebGL context with MapLibre requires
// intricate viewport and state management that proved unreliable. Plain
// WebGL avoids every one of those issues while giving us full control.
//
// Two non-obvious design choices, both learned the hard way:
//
// 1. Rendering primitive — screen-facing quads, NOT gl.POINTS. gl.POINTS
//    depends on gl_PointSize, which is driver-clamped and unreliable (Firefox/
//    ANGLE can drop or cap it, rendering nothing). Each disc is instead two
//    triangles whose corners are offset *in clip space* by a pixel amount
//    computed in the vertex shader — constant on-screen size, no gl_PointSize.
//
// 2. Coordinate precision — local metre space + a double-precision model
//    matrix. Passing full mercator coordinates (~0.57) straight through the
//    float32 MVP loses ~a full screen of precision at city zoom (the classic
//    web-mercator precision problem), pushing the arc off-screen. Instead we
//    keep vertices in small local metres (±400) and bake the large origin
//    translation into a model matrix that we multiply with MapLibre's MVP in
//    float64 on the CPU. The GPU then only ever multiplies small numbers.

import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput } from 'maplibre-gl';
import type { LatLng, SolarTimes } from '../../types';
import {
  buildArcSamples,
  buildArcMarkers,
  sunPositionAtMinute,
  PHASE_COLORS,
  type ArcPhase,
  type ArcMarkerKind,
} from '../arcGeometry';

export const SUN_PATH_LAYER_ID = 'sun-path-layer';

// Zoom at which the arc is drawn at its authored 400 m radius (matches the
// pin fly-to zoom). Above/below, the radius scales as 2^(REF_ZOOM − zoom) so
// the arc keeps a roughly constant apparent size. Clamped so it never collapses
// to a dot or balloons across the whole world at the extremes.
const ARC_REF_ZOOM = 15;
const ARC_SCALE_MIN = 0.18; // ~72 m at deep zoom
const ARC_SCALE_MAX = 4; // ~1.6 km when zoomed out

function arcScaleForZoom(zoom: number): number {
  const k = Math.pow(2, ARC_REF_ZOOM - zoom);
  return Math.min(ARC_SCALE_MAX, Math.max(ARC_SCALE_MIN, k));
}

export interface SunPathLayerHandle {
  customLayer: CustomLayerInterface;
  setTimeMinutes: (minutes: number) => void;
}

// ── Shaders ────────────────────────────────────────────────────────────────
// GLSL ES 3.00 is required for WebGL2 (MapLibre 5.x context).
//
// a_pos    — disc centre in LOCAL metre space (repeated for all 6 corners)
// a_corner — quad corner in [-1, 1]² (also reused for the round-disc mask)
// u_mvp    — combined (MapLibre MVP × model) matrix, maps local metres → clip

const VERT = `#version 300 es
  in vec3 a_pos;
  in vec2 a_corner;
  uniform mat4 u_mvp;
  uniform vec2 u_viewport; // drawing-buffer size in pixels
  uniform float u_size;    // disc diameter in pixels
  out vec2 v_corner;
  void main() {
    vec4 clip = u_mvp * vec4(a_pos, 1.0);
    vec2 px = a_corner * (u_size * 0.5);          // half-extent in pixels
    clip.xy += (px / u_viewport) * 2.0 * clip.w;  // pixels → clip space
    gl_Position = clip;
    v_corner = a_corner;
  }
`;

// Round disc: discard fragments outside the unit circle of the quad.
const FRAG = `#version 300 es
  precision mediump float;
  in vec2 v_corner;
  uniform vec4 u_color;
  out vec4 fragColor;
  void main() {
    if (dot(v_corner, v_corner) > 1.0) discard;
    fragColor = u_color;
  }
`;

// ── Math helpers ─────────────────────────────────────────────────────────────

// Column-major 4×4 multiply in double precision: out = a · b. Both inputs are
// read as length-16 arrays; the result is a plain (double) number[16].
function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
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

// ── Render helpers ───────────────────────────────────────────────────────────

// Two triangles covering [-1,1]², emitted per disc.
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];

function hexToRgba(hex: number, a: number): [number, number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, a];
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

// Expand a flat list of disc centres (xyz triples) into an interleaved quad
// buffer: 6 vertices per disc, each [posX, posY, posZ, cornerX, cornerY].
function buildQuadBuffer(centres: number[]): Float32Array {
  const n = centres.length / 3;
  const out = new Float32Array(n * 6 * 5);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const px = centres[i * 3],
      py = centres[i * 3 + 1],
      pz = centres[i * 3 + 2];
    for (let c = 0; c < 6; c++) {
      out[o++] = px;
      out[o++] = py;
      out[o++] = pz;
      out[o++] = CORNERS[c * 2];
      out[o++] = CORNERS[c * 2 + 1];
    }
  }
  return out;
}

// Stride/offsets for the interleaved [pos.xyz, corner.xy] layout.
const STRIDE = 5 * 4; // 5 floats × 4 bytes
const CORNER_OFFSET = 3 * 4; // corner starts after the 3 position floats

// ── Factory ────────────────────────────────────────────────────────────────

export function createSunPathLayer(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
): SunPathLayerHandle {
  const origin = maplibregl.MercatorCoordinate.fromLngLat({ lng: pin.lng, lat: pin.lat }, 0);
  const S = origin.meterInMercatorCoordinateUnits();
  const oz = origin.z ?? 0;

  // Model matrix (column-major) mapping LOCAL metre space (X=east, Y=altitude,
  // Z=south) to mercator world space. This is the affine map:
  //   mercX = ox + S·k·xM,  mercY = oy + S·k·zM,  mercZ = oz + S·k·yM
  // i.e. the metre→mercator scale S (times a zoom factor `k`) plus the
  // rotX(90°)/Y-flip axis swap, with the pin origin as the translation column.
  // Kept as doubles so that when we premultiply MapLibre's MVP each frame, the
  // large origin translation is resolved in full precision before the float32
  // upload.
  //
  // `k` scales the whole arc about the pin so it keeps a roughly constant
  // on-screen size across zoom levels: authored at 400 m (REF_ZOOM), it pulls
  // closer as you zoom in and expands as you zoom out, instead of floating at a
  // fixed metric radius that leaves the frame. The translation column is left
  // untouched so only the radius scales, not the centre.
  function modelMatrixForScale(k: number): number[] {
    const sk = S * k;
    return [sk, 0, 0, 0, 0, 0, sk, 0, 0, sk, 0, 0, origin.x, origin.y, oz, 1];
  }

  // ── Geometry (in local metre space) ─────────────────────────────────────────

  const samples = buildArcSamples(pin, dayStartUtc, solarTimes);

  // Group consecutive same-phase samples; each becomes its own quad buffer.
  type Group = { verts: Float32Array; count: number; phase: ArcPhase };
  const groups: Group[] = [];
  {
    let phase: ArcPhase | null = null;
    let acc: number[] = [];
    const flush = () => {
      if (phase && acc.length) {
        groups.push({ verts: buildQuadBuffer(acc), count: (acc.length / 3) * 6, phase });
      }
    };
    for (const s of samples) {
      if (s.phase !== phase) {
        flush();
        phase = s.phase;
        acc = [];
      }
      acc.push(s.xM, s.yM, s.zM); // raw metres — model matrix does the rest
    }
    flush();
  }

  // Sun-position disc: a single quad (6 verts) whose centre is updated by
  // setTimeMinutes. Corners are fixed; only the position floats change.
  const sphereQuad = buildQuadBuffer([0, 0, 0]);
  let sphereVisible = false;

  // Event waypoints (sunrise / solar noon / sunset). Static for the day: one
  // quad per marker, drawn as a distinctive ringed dot in the render loop.
  const markers = buildArcMarkers(pin, solarTimes);
  const markerCentres = markers.flatMap((m) => m.pos);
  const markerQuad = buildQuadBuffer(markerCentres);
  // Per-kind core colour; each marker is drawn as a white halo + this core so
  // it reads as a labelled waypoint rather than another arc dot.
  const MARKER_COLORS: Record<ArcMarkerKind, number> = {
    sunrise: 0xffb347, // warm gold — sun clearing the horizon
    noon: 0xfff2c2, // bright warm white — highest point
    sunset: 0xff5e3a, // deep orange-red — sun dropping behind the skyline
  };

  // ── WebGL state ───────────────────────────────────────────────────────────

  let gl: WebGL2RenderingContext;
  let prog: WebGLProgram | null = null;
  let arcBufs: WebGLBuffer[];
  let sphereBuf: WebGLBuffer;
  let markerBuf: WebGLBuffer;
  let aPos: number;
  let aCorner: number;
  let uMvp: WebGLUniformLocation | null;
  let uColor: WebGLUniformLocation | null;
  let uSize: WebGLUniformLocation | null;
  let uViewport: WebGLUniformLocation | null;
  let storedMap: maplibregl.Map | undefined;

  // Binds the interleaved buffer to the position + corner attributes.
  function bindAttribs(buf: WebGLBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, STRIDE, CORNER_OFFSET);
  }

  // ── CustomLayerInterface ──────────────────────────────────────────────────

  const customLayer: CustomLayerInterface = {
    id: SUN_PATH_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, glCtx) {
      storedMap = map;
      gl = glCtx as WebGL2RenderingContext;

      const vert = compileShader(gl, gl.VERTEX_SHADER, VERT);
      const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
      if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
        console.error('[solux] vertex shader:', gl.getShaderInfoLog(vert));
        return;
      }
      if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
        console.error('[solux] fragment shader:', gl.getShaderInfoLog(frag));
        return;
      }

      const p = gl.createProgram()!;
      gl.attachShader(p, vert);
      gl.attachShader(p, frag);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('[solux] program link:', gl.getProgramInfoLog(p));
        return;
      }

      prog = p;
      aPos = gl.getAttribLocation(prog, 'a_pos');
      aCorner = gl.getAttribLocation(prog, 'a_corner');
      uMvp = gl.getUniformLocation(prog, 'u_mvp');
      uColor = gl.getUniformLocation(prog, 'u_color');
      uSize = gl.getUniformLocation(prog, 'u_size');
      uViewport = gl.getUniformLocation(prog, 'u_viewport');

      arcBufs = groups.map(({ verts }) => {
        const b = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
        return b;
      });

      sphereBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
      gl.bufferData(gl.ARRAY_BUFFER, sphereQuad, gl.DYNAMIC_DRAW);

      markerBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, markerQuad, gl.STATIC_DRAW);
    },

    render(_gl, options: CustomRenderMethodInput) {
      if (!prog || groups.length === 0) return;

      // Combine MapLibre's projection with our model matrix in double precision,
      // then upload the result as float32. This keeps the large origin
      // translation accurate while the GPU only multiplies small local metres.
      //
      // We use `defaultProjectionData.mainMatrix`, NOT `modelViewProjectionMatrix`.
      // In MapLibre 5 the latter does not map mercator [0,1] world coordinates to
      // clip space for custom layers (verified empirically: it projects the pin
      // centre to NDC [-3.85, 1.73] instead of [0, 0]); mainMatrix does.
      const k = arcScaleForZoom(storedMap?.getZoom() ?? ARC_REF_ZOOM);
      const mvp = mat4Mul(options.defaultProjectionData.mainMatrix, modelMatrixForScale(k));

      gl.useProgram(prog);
      gl.uniformMatrix4fv(uMvp, false, new Float32Array(mvp));
      gl.uniform2f(uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);

      // MapLibre uses the stencil buffer for tile clipping and a non-default
      // VAO; both would silently suppress our draws. Reset to a clean state.
      gl.bindVertexArray(null);
      gl.disable(gl.STENCIL_TEST);
      // Overlay semantics: draw on top of buildings/terrain (depth test off),
      // no back-face culling, don't write depth.
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.depthMask(false);

      // Arc — two passes per phase. An additive glow pass lays down a soft
      // halo (large, low alpha) so the path reads as luminous light rather
      // than flat dots; a normal-blended core pass draws the crisp, slightly
      // overlapping discs that fuse into a continuous coloured ribbon.
      groups.forEach(({ count, phase }, i) => {
        bindAttribs(arcBufs[i]);
        const rgb = hexToRgba(PHASE_COLORS[phase], 1);

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive bloom
        gl.uniform1f(uSize, 26.0);
        gl.uniform4f(uColor, rgb[0], rgb[1], rgb[2], 0.1);
        gl.drawArrays(gl.TRIANGLES, 0, count);

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // crisp core
        gl.uniform1f(uSize, 13.0);
        gl.uniform4f(uColor, rgb[0], rgb[1], rgb[2], 0.95);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      });

      // Signature element: the current-time sun as a glowing body — a wide
      // additive halo under a bright warm core.
      if (sphereVisible) {
        bindAttribs(sphereBuf);

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.uniform1f(uSize, 64.0);
        gl.uniform4f(uColor, 1.0, 0.78, 0.32, 0.35);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(uSize, 30.0);
        gl.uniform4f(uColor, 1.0, 0.95, 0.78, 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // Event waypoints — each a soft white halo, a coloured core, and a small
      // bright centre so it reads as a deliberate marker (sunrise/noon/sunset)
      // sitting on the arc, distinct from the continuous phase ribbon.
      if (markers.length) {
        bindAttribs(markerBuf);
        markers.forEach(({ kind }, i) => {
          const first = i * 6;
          const rgb = hexToRgba(MARKER_COLORS[kind], 1);

          gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // coloured halo
          gl.uniform1f(uSize, 30.0);
          gl.uniform4f(uColor, rgb[0], rgb[1], rgb[2], 0.3);
          gl.drawArrays(gl.TRIANGLES, first, 6);

          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // coloured core
          gl.uniform1f(uSize, 17.0);
          gl.uniform4f(uColor, rgb[0], rgb[1], rgb[2], 1.0);
          gl.drawArrays(gl.TRIANGLES, first, 6);

          gl.uniform1f(uSize, 7.0); // bright white centre
          gl.uniform4f(uColor, 1.0, 1.0, 1.0, 0.95);
          gl.drawArrays(gl.TRIANGLES, first, 6);
        });
      }

      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST); // restore for MapLibre's next layer
    },

    onRemove() {
      arcBufs?.forEach((b) => gl.deleteBuffer(b));
      if (sphereBuf) gl.deleteBuffer(sphereBuf);
      if (markerBuf) gl.deleteBuffer(markerBuf);
      if (prog) gl.deleteProgram(prog);
    },
  };

  return {
    customLayer,

    setTimeMinutes(minutes: number) {
      const pos = sunPositionAtMinute(pin, dayStartUtc, minutes);
      if (pos && gl && sphereBuf) {
        // Rewrite the position floats of all 6 corner vertices (local metres).
        for (let i = 0; i < 6; i++) {
          sphereQuad[i * 5] = pos[0];
          sphereQuad[i * 5 + 1] = pos[1];
          sphereQuad[i * 5 + 2] = pos[2];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, sphereQuad);
        sphereVisible = true;
      } else {
        sphereVisible = false;
      }
      storedMap?.triggerRepaint();
    },
  };
}
