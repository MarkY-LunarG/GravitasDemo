// Generates lunarg_ship.glb from the "lunarg-ship-design.jpg" sketch.
//
// Coordinate system (glTF convention): +Y is up, +Z is the front of the ship,
// units are meters. The ship stands on y = 0 and is about 50 m tall.
//
// The profile of the hull is the "G" from the sketch. The front of the ship is
// the curved back of the "G" (where the cockpit window is). The crossbar of the
// "G" is the engine, seen from the side. Two engines sit on a pylon that goes
// through the lower arm of the "G".
//
// Engine state is controlled by node scale, so it works with core glTF only:
//   EngineL_Flames / EngineR_Flames  scale ~0 = unlit, scale 1 = lit.
// Animations:
//   EnginesIgnite   (one shot)  scales the flame roots from 0 to 1.
//   EnginesRunning  (loop)      makes the flame layers flicker and shift color.
//   EnginesShutdown (one shot)  scales the flame roots from 1 to 0.
//
// Usage: node build_ship.mjs [output.glb]

import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'lunarg_ship.glb');

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// Signed power, used for superellipse cross sections.
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

// Deterministic pseudo random numbers, so each build gives the same file.
let seed = 1234567;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---------------------------------------------------------------------------
// Mesh container
// ---------------------------------------------------------------------------
class MeshData {
    constructor() { this.pos = []; this.nrm = []; this.col = null; this.idx = []; }
    addVertex(p, n, c) {
        this.pos.push(p); this.nrm.push(n ?? [0, 1, 0]);
        if (c) { (this.col ??= []).push(c); }
        return this.pos.length - 1;
    }
    tri(a, b, c) { this.idx.push(a, b, c); }
    // Recompute smooth normals from the triangles.
    computeNormals() {
        const acc = this.pos.map(() => [0, 0, 0]);
        for (let i = 0; i < this.idx.length; i += 3) {
            const [a, b, c] = [this.idx[i], this.idx[i + 1], this.idx[i + 2]];
            const fn = cross(sub(this.pos[b], this.pos[a]), sub(this.pos[c], this.pos[a]));
            for (const v of [a, b, c]) acc[v] = add(acc[v], fn);
        }
        this.nrm = acc.map(norm);
    }
    // Flip each triangle whose winding disagrees with its vertex normals.
    orientToNormals() {
        for (let i = 0; i < this.idx.length; i += 3) {
            const [a, b, c] = [this.idx[i], this.idx[i + 1], this.idx[i + 2]];
            const fn = cross(sub(this.pos[b], this.pos[a]), sub(this.pos[c], this.pos[a]));
            const vn = add(add(this.nrm[a], this.nrm[b]), this.nrm[c]);
            if (dot(fn, vn) < 0) { this.idx[i + 1] = c; this.idx[i + 2] = b; }
        }
    }
    append(other) {
        const base = this.pos.length;
        this.pos.push(...other.pos); this.nrm.push(...other.nrm);
        if (other.col) (this.col ??= []).push(...other.col);
        for (const i of other.idx) this.idx.push(i + base);
        return this;
    }
}

// ---------------------------------------------------------------------------
// Hull: the "G"
// ---------------------------------------------------------------------------
// The sketch is measured in image pixels (2000 px wide copy of the photo).
// Image +x is toward the rear of the ship, image +y is down.
const PX = 50 / 430;          // meters per pixel: the "G" is 430 px tall -> 50 m.
const IMG_BOTTOM = 465;       // image y of the bottom of the "G".
const IMG_ZERO_Z = 370;       // image x that maps to z = 0.
const imgToModel = (xi, yi) => [(IMG_ZERO_Z - xi) * PX, (IMG_BOTTOM - yi) * PX]; // -> [z, y]

const OUTER = { cx: 330, cy: 250, a: 182, b: 215 };
const INNER = { cx: 357, cy: 245, a: 102, b: 135 };
const ellipsePoint = (e, theta) => [e.cx + e.a * Math.cos(theta), e.cy - e.b * Math.sin(theta)];

const HULL_WIDTH = 10.0;      // meters, along x.
const STUB_TOP_IMG_Y = 270;   // the lower arm of the "G" stops at this image y.
const SECTION_EXP = 2 / 2.6;  // superellipse exponent for the hull cross section.

// The sweep goes from the crescent tip (s = 0) around the front of the "G"
// to the stub of the lower arm (s = 1). Angles are counter-clockwise from
// image +x (the rear).
const THETA_O0 = 22 * DEG;
const THETA_O1 = 2 * Math.PI + Math.asin((OUTER.cy - STUB_TOP_IMG_Y) / OUTER.b);
const THETA_I0 = 40 * DEG;
const THETA_I1 = 2 * Math.PI + Math.asin((INNER.cy - STUB_TOP_IMG_Y) / INNER.b);

function hullSection(s) {
    const po = ellipsePoint(OUTER, lerp(THETA_O0, THETA_O1, s));
    const piEllipse = ellipsePoint(INNER, lerp(THETA_I0, THETA_I1, s));
    // The crescent tip: the inner edge joins the outer edge.
    const u = clamp(s / 0.22, 0, 1);
    const t = 1 - (1 - u) * (1 - u);
    const pi = [lerp(po[0], piEllipse[0], t), lerp(po[1], piEllipse[1], t)];
    // Width tapers at the crescent tip and at the stub (the "V" marks in the rear view).
    let w = HULL_WIDTH * lerp(0.18, 1.0, smoothstep(0.0, 0.3, s));
    w *= lerp(1.0, 0.45, smoothstep(0.72, 1.0, s));
    const [zo, yo] = imgToModel(po[0], po[1]);
    const [zi, yi] = imgToModel(pi[0], pi[1]);
    return { outer: [0, yo, zo], inner: [0, yi, zi], width: w };
}

function buildHull() {
    const NS = 260, NP = 56;
    const m = new MeshData();
    const rings = [];
    for (let i = 0; i <= NS; i++) {
        const s = i / NS;
        const sec = hullSection(s);
        const mid = scale(add(sec.outer, sec.inner), 0.5);
        const half = scale(sub(sec.outer, sec.inner), 0.5);
        const ring = [];
        for (let j = 0; j < NP; j++) {
            const phi = (j / NP) * 2 * Math.PI;
            const cu = spow(Math.cos(phi), SECTION_EXP);
            const sv = spow(Math.sin(phi), SECTION_EXP);
            const p = add(add(mid, scale(half, cu)), [sv * sec.width * 0.5, 0, 0]);
            ring.push(m.addVertex(p));
        }
        rings.push({ ids: ring, mid });
    }
    for (let i = 0; i < NS; i++) {
        for (let j = 0; j < NP; j++) {
            const a = rings[i].ids[j], b = rings[i + 1].ids[j];
            const c = rings[i + 1].ids[(j + 1) % NP], d = rings[i].ids[(j + 1) % NP];
            m.tri(a, b, c); m.tri(a, c, d);
        }
    }
    // Orient side triangles to point away from the section center line.
    for (let i = 0; i < m.idx.length; i += 3) {
        const [a, b, c] = [m.idx[i], m.idx[i + 1], m.idx[i + 2]];
        const fn = cross(sub(m.pos[b], m.pos[a]), sub(m.pos[c], m.pos[a]));
        const ring = rings[Math.floor(Math.floor(a / NP))];
        const out = sub(m.pos[a], ring.mid);
        if (dot(fn, out) < 0) { m.idx[i + 1] = c; m.idx[i + 2] = b; }
    }
    m.computeNormals();
    // End caps have their own vertices so the edge stays sharp.
    for (const [ri, other] of [[0, 1], [NS, NS - 1]]) {
        const ring = rings[ri];
        const capNormal = norm(sub(ring.mid, rings[other].mid));
        const center = m.addVertex(ring.mid, capNormal);
        const capIds = ring.ids.map((id) => m.addVertex(m.pos[id], capNormal));
        for (let j = 0; j < NP; j++) {
            const a = capIds[j], b = capIds[(j + 1) % NP];
            const fn = cross(sub(m.pos[a], m.pos[center]), sub(m.pos[b], m.pos[center]));
            if (dot(fn, capNormal) >= 0) m.tri(center, a, b); else m.tri(center, b, a);
        }
    }
    return m;
}

// ---------------------------------------------------------------------------
// Surfaces of revolution around an axis along -Z (local space)
// ---------------------------------------------------------------------------
// profile: list of [r, z] points. Normals are analytic: for a profile that is
// walked in the order given, the outward normal is (-dz, dr).
// colorFn(r, z, t, angle) optionally returns RGBA for each vertex.
function lathe(profile, segments, colorFn, smooth = true) {
    const m = new MeshData();
    const n = profile.length;
    const pn = [];
    for (let i = 0; i < n; i++) {
        const segN = (a, b) => { const dr = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dr, dz) || 1; return [-dz / l, dr / l]; };
        let v;
        if (i === 0) v = segN(profile[0], profile[1]);
        else if (i === n - 1) v = segN(profile[n - 2], profile[n - 1]);
        else if (smooth) { const a = segN(profile[i - 1], profile[i]), b = segN(profile[i], profile[i + 1]); v = [a[0] + b[0], a[1] + b[1]]; }
        else v = segN(profile[i], profile[i + 1]);
        const l = Math.hypot(v[0], v[1]) || 1;
        pn.push([v[0] / l, v[1] / l]);
    }
    for (let i = 0; i < n; i++) {
        const [r, z] = profile[i];
        for (let j = 0; j <= segments; j++) {
            const a = (j / segments) * 2 * Math.PI;
            const c = Math.cos(a), s = Math.sin(a);
            m.addVertex([r * c, r * s, z], [pn[i][0] * c, pn[i][0] * s, pn[i][1]],
                colorFn ? colorFn(r, z, i / (n - 1), a, j) : undefined);
        }
    }
    const W = segments + 1;
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < segments; j++) {
            const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, d = i * W + j + 1;
            m.tri(a, b, c); m.tri(a, c, d);
        }
    }
    m.orientToNormals();
    return m;
}

function transformMesh(m, fn, nfn) {
    m.pos = m.pos.map(fn);
    m.nrm = m.nrm.map((n) => norm(nfn ? nfn(n) : n));
    return m;
}

// ---------------------------------------------------------------------------
// Engine (local space: rear face of the cowl at z = 0, nose toward +z)
// ---------------------------------------------------------------------------
const ENGINE_R = 1.6;
const ENGINE_FRONT_Z = imgToModel(400, 0)[0];   // front of the crossbar in the sketch
const ENGINE_REAR_Z = imgToModel(580, 0)[0];    // rear of the crossbar in the sketch
const ENGINE_LEN = ENGINE_FRONT_Z - ENGINE_REAR_Z;
const ENGINE_Y = imgToModel(0, 284)[1];         // center line of the crossbar
const ENGINE_X = 13.0;                          // from the front view: pylons reach out ~1.3 hull widths
const LIP_R = 1.42;                             // inner radius of the cowl lip
const THROAT_DEPTH = 0.55;                      // depth of the annular throat
const SPIKE_BASE_R = 1.12;
const SPIKE_LEN = 3.8;
const spikeR = (t) => SPIKE_BASE_R * Math.pow(1 - t, 1.7) + 0.04 * (1 - t);

function buildEngine() {
    const NOSE = 4.2;
    const bodyProfile = [];
    for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI / 2;
        bodyProfile.push([ENGINE_R * Math.sin(a), ENGINE_LEN - NOSE + NOSE * Math.cos(a)]);
    }
    // Two reinforcing bands give the cylinder some detail.
    for (const zb of [ENGINE_LEN * 0.55, ENGINE_LEN * 0.3, 1.2]) {
        bodyProfile.push([ENGINE_R, zb + 0.18], [ENGINE_R + 0.08, zb + 0.1], [ENGINE_R + 0.08, zb - 0.1], [ENGINE_R, zb - 0.18]);
    }
    bodyProfile.push([ENGINE_R, 0]);
    const body = lathe(bodyProfile, 48, null, true);

    const lip = lathe([[ENGINE_R, 0], [LIP_R, 0]], 48, null, false)
        .append(lathe([[LIP_R, 0], [LIP_R, THROAT_DEPTH]], 48, null, false));
    const throat = lathe([[LIP_R, THROAT_DEPTH], [SPIKE_BASE_R, THROAT_DEPTH]], 48, null, false);

    const spikeProfile = [];
    for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        spikeProfile.push([spikeR(t), THROAT_DEPTH - t * (SPIKE_LEN + THROAT_DEPTH)]);
    }
    spikeProfile.push([0, THROAT_DEPTH - (SPIKE_LEN + THROAT_DEPTH) - 0.02]);
    const spike = lathe(spikeProfile, 48, null, true);
    return { body: body.append(lip), throat, spike };
}

// ---------------------------------------------------------------------------
// Flames (local space: same as the engine, flowing toward -z)
// ---------------------------------------------------------------------------
// Each layer is a shell that hugs the spike and closes to a plume behind it.
// Vertex colors carry streaks and an alpha fade toward the end of the plume.
// Two morph targets let the shell wobble and stretch.
function streakNoise(angle, layerSeed) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
        const f = [3, 5, 8, 13, 21][k];
        v += Math.sin(f * angle + layerSeed * (k + 1) * 1.7) / (k + 1.5);
    }
    return 0.5 + 0.5 * Math.tanh(v * 1.4);
}

function buildFlameLayer({ offset0, offset1, plumeLen, colorA, colorB, alpha0, alpha1, layerSeed, rows = 40 }) {
    // Profile: from the throat ring, along the spike, then to a point.
    const zStart = THROAT_DEPTH - 0.03;
    const zSpikeEnd = -SPIKE_LEN;
    const zEnd = -SPIKE_LEN - plumeLen;
    const profile = [];
    for (let i = 0; i <= rows; i++) {
        const t = i / rows;
        const z = lerp(zStart, zEnd, t);
        let r;
        if (z >= zSpikeEnd) {
            const ts = (THROAT_DEPTH - z) / (SPIKE_LEN + THROAT_DEPTH);
            r = spikeR(clamp(ts, 0, 1)) + lerp(offset0, offset1, ts);
            // Leave the throat at its full width.
            r = Math.max(r, lerp(LIP_R - 0.05, 0, smoothstep(0, 0.12, ts)));
        } else {
            const tp = clamp((zSpikeEnd - z) / plumeLen, 0, 1);
            r = (spikeR(1) + offset1) * Math.pow(1 - tp, 0.8);
        }
        profile.push([Math.max(r, 0.0), z]);
    }
    const SEG = 48;
    const colorFn = (r, z, t, angle) => {
        const s = streakNoise(angle + t * 1.3, layerSeed);
        const base = [lerp(colorA[0], colorB[0], t), lerp(colorA[1], colorB[1], t), lerp(colorA[2], colorB[2], t)];
        const k = 0.65 + 0.35 * s;
        const a = lerp(alpha0, alpha1, Math.pow(t, 0.9)) * (0.55 + 0.45 * s) * smoothstep(0, 0.04, t + 0.02);
        return [base[0] * k, base[1] * k, base[2] * k, clamp(a, 0, 1)];
    };
    const m = lathe(profile, SEG, colorFn, true);

    // Morph target 0: an uneven radial bulge (lobes around the ring).
    // Morph target 1: stretch of the plume and a pinch near the spike.
    const t0 = [], t1 = [];
    for (let v = 0; v < m.pos.length; v++) {
        const [x, y, z] = m.pos[v];
        const r = Math.hypot(x, y);
        const angle = Math.atan2(y, x);
        const along = clamp((THROAT_DEPTH - z) / (SPIKE_LEN + plumeLen), 0, 1);
        const bulge = 0.18 * r * Math.sin(3 * angle + layerSeed) * Math.sin(Math.PI * along) +
                      0.10 * r * Math.sin(5 * angle - 2 * layerSeed) * along;
        t0.push(r > 1e-5 ? [x / r * bulge, y / r * bulge, 0] : [0, 0, 0]);
        const stretch = -0.35 * plumeLen * Math.pow(along, 2.0);
        const pinch = -0.12 * r * Math.sin(Math.PI * along);
        t1.push(r > 1e-5 ? [x / r * pinch, y / r * pinch, stretch] : [0, 0, stretch]);
    }
    m.targets = [t0, t1];
    return m;
}

function buildThroatGlow() {
    // Bright ring in the throat, as in the photo of the lit aerospike.
    const m = new MeshData();
    const SEG = 96, RINGS = 4;
    const z = THROAT_DEPTH - 0.02;
    for (let i = 0; i <= RINGS; i++) {
        const t = i / RINGS;
        const r = lerp(LIP_R - 0.01, SPIKE_BASE_R + 0.01, t);
        for (let j = 0; j <= SEG; j++) {
            const a = (j / SEG) * 2 * Math.PI;
            const s = streakNoise(a * 2, 0.7);
            const hot = Math.sin(Math.PI * t);
            const c = [1.0, lerp(0.55, 0.92, hot * s), lerp(0.18, 0.65, hot * s), 1.0];
            m.addVertex([r * Math.cos(a), r * Math.sin(a), z], [0, 0, -1], c);
        }
    }
    const W = SEG + 1;
    for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEG; j++) {
        const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, d = i * W + j + 1;
        m.tri(a, b, c); m.tri(a, c, d);
    }
    m.orientToNormals();
    return m;
}

// ---------------------------------------------------------------------------
// Pylon through the lower arm of the "G"
// ---------------------------------------------------------------------------
function buildPylon() {
    const stubOuter = ellipsePoint(OUTER, THETA_O1), stubInner = ellipsePoint(INNER, THETA_I1);
    const zc = imgToModel((stubOuter[0] + stubInner[0]) / 2, 0)[0];
    const NX = 24, NP = 32;
    const m = new MeshData();
    const rings = [];
    for (let i = 0; i <= NX; i++) {
        const x = lerp(-ENGINE_X, ENGINE_X, i / NX);
        const t = Math.abs(x) / ENGINE_X;
        const chord = lerp(6.0, 3.4, t), thick = lerp(1.0, 0.6, t);
        const ring = [];
        for (let j = 0; j < NP; j++) {
            const phi = (j / NP) * 2 * Math.PI;
            // Rounded leading edge, sharper trailing edge.
            const cz = Math.cos(phi), sy = Math.sin(phi);
            const zz = cz >= 0 ? cz : -Math.pow(-cz, 0.7);
            ring.push(m.addVertex([x, ENGINE_Y + sy * thick * 0.5 * (cz >= 0 ? 1 : Math.pow(1 + cz, 0.35)), zc + zz * chord * 0.5]));
        }
        rings.push(ring);
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NP; j++) {
        m.tri(rings[i][j], rings[i + 1][j], rings[i + 1][(j + 1) % NP]);
        m.tri(rings[i][j], rings[i + 1][(j + 1) % NP], rings[i][(j + 1) % NP]);
    }
    for (let i = 0; i < m.idx.length; i += 3) {
        const [a, b, c] = [m.idx[i], m.idx[i + 1], m.idx[i + 2]];
        const fn = cross(sub(m.pos[b], m.pos[a]), sub(m.pos[c], m.pos[a]));
        const out = sub(m.pos[a], [m.pos[a][0], ENGINE_Y, zc]);
        if (dot(fn, out) < 0) { m.idx[i + 1] = c; m.idx[i + 2] = b; }
    }
    m.computeNormals();
    return m;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function ellipsoid(radii, center, frame, rows = 20, segs = 36) {
    // frame: [u, v, w] unit axes; radii along each axis.
    const m = new MeshData();
    for (let i = 0; i <= rows; i++) {
        const th = (i / rows) * Math.PI;
        for (let j = 0; j <= segs; j++) {
            const ph = (j / segs) * 2 * Math.PI;
            const l = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
            const p = add(center, add(add(scale(frame[0], l[0] * radii[0]), scale(frame[1], l[1] * radii[1])), scale(frame[2], l[2] * radii[2])));
            const n = norm(add(add(scale(frame[0], l[0] / radii[0]), scale(frame[1], l[1] / radii[1])), scale(frame[2], l[2] / radii[2])));
            m.addVertex(p, n);
        }
    }
    const W = segs + 1;
    for (let i = 0; i < rows; i++) for (let j = 0; j < segs; j++) {
        const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, d = i * W + j + 1;
        m.tri(a, b, c); m.tri(a, c, d);
    }
    m.orientToNormals();
    return m;
}

function buildWindows() {
    // Cockpit window on the front of the "G", about 30 m above the ground.
    const yImg = IMG_BOTTOM - 30 / PX;
    const th = Math.PI - Math.asin((OUTER.cy - yImg) / OUTER.b);
    const [xi, yi] = ellipsePoint(OUTER, th);
    const [z, y] = imgToModel(xi, yi);
    // Ellipse normal in image space, then into model space (z = -x_img, y = -y_img).
    const nImg = [Math.cos(th) / OUTER.a, Math.sin(th) / OUTER.b];
    const n = norm([0, nImg[1], -nImg[0]]);
    const up = norm(cross(n, [1, 0, 0]));
    const frame = [[1, 0, 0], up.map((v) => -v), n];
    const surf = [0, y, z];
    const glass = ellipsoid([2.45, 2.45, 1.25], add(surf, scale(n, -0.35)), frame);
    const rim = ellipsoid([2.9, 2.9, 1.0], add(surf, scale(n, -0.5)), frame);

    // Side portholes (the small dots in the profile and the front view).
    const [pz, py] = imgToModel(215, 205);
    for (const sx of [-1, 1]) {
        glass.append(ellipsoid([0.75, 0.75, 0.3], [sx * 4.88, py, pz], [[0, 0, 1], [0, 1, 0], [sx, 0, 0]], 12, 24));
        rim.append(ellipsoid([0.95, 0.95, 0.22], [sx * 4.86, py, pz], [[0, 0, 1], [0, 1, 0], [sx, 0, 0]], 12, 24));
    }
    return { glass, rim };
}

// ---------------------------------------------------------------------------
// glTF writer
// ---------------------------------------------------------------------------
class GltfBuilder {
    constructor() {
        this.chunks = []; this.byteLength = 0;
        this.json = {
            asset: { version: '2.0', generator: 'lunarg-ship build_ship.mjs' },
            extensionsUsed: ['KHR_materials_unlit'],
            scene: 0, scenes: [], nodes: [], meshes: [], materials: [],
            accessors: [], bufferViews: [], buffers: [], animations: [],
        };
    }
    _view(typed, target) {
        const pad = (4 - (this.byteLength % 4)) % 4;
        if (pad) { this.chunks.push(Buffer.alloc(pad)); this.byteLength += pad; }
        const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
        const view = { buffer: 0, byteOffset: this.byteLength, byteLength: buf.length };
        if (target) view.target = target;
        this.chunks.push(buf); this.byteLength += buf.length;
        this.json.bufferViews.push(view);
        return this.json.bufferViews.length - 1;
    }
    accessor(data, type, { componentType = 5126, target, minmax = false, normalized } = {}) {
        const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
        const typed = componentType === 5125 ? Uint32Array.from(data)
            : componentType === 5123 ? Uint16Array.from(data) : Float32Array.from(data);
        const acc = { bufferView: this._view(typed, target), componentType, count: typed.length / comps, type };
        if (normalized) acc.normalized = true;
        if (minmax) {
            const mn = Array(comps).fill(Infinity), mx = Array(comps).fill(-Infinity);
            for (let i = 0; i < typed.length; i++) { const c = i % comps; mn[c] = Math.min(mn[c], typed[i]); mx[c] = Math.max(mx[c], typed[i]); }
            acc.min = mn; acc.max = mx;
        }
        this.json.accessors.push(acc);
        return this.json.accessors.length - 1;
    }
    material(m) { this.json.materials.push(m); return this.json.materials.length - 1; }
    mesh(name, prims) {
        const primitives = prims.map(({ data, material }) => {
            const attributes = {
                POSITION: this.accessor(data.pos.flat(), 'VEC3', { target: 34962, minmax: true }),
                NORMAL: this.accessor(data.nrm.flat(), 'VEC3', { target: 34962 }),
            };
            if (data.col) attributes.COLOR_0 = this.accessor(data.col.flat(), 'VEC4', { target: 34962 });
            const big = data.pos.length > 65535;
            const p = {
                attributes, material, mode: 4,
                indices: this.accessor(data.idx, 'SCALAR', { componentType: big ? 5125 : 5123, target: 34963 }),
            };
            if (data.targets) {
                p.targets = data.targets.map((t) => ({ POSITION: this.accessor(t.flat(), 'VEC3', { target: 34962, minmax: true }) }));
            }
            return p;
        });
        const mesh = { name, primitives };
        if (prims[0].data.targets) mesh.weights = prims[0].data.targets.map(() => 0);
        this.json.meshes.push(mesh);
        return this.json.meshes.length - 1;
    }
    node(n) { this.json.nodes.push(n); return this.json.nodes.length - 1; }
    toGlb() {
        const bin = Buffer.concat(this.chunks);
        const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
        this.json.buffers = [{ byteLength: binPad.length }];
        let jsonBuf = Buffer.from(JSON.stringify(this.json), 'utf8');
        jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPad.length, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
        const bh = Buffer.alloc(8); bh.writeUInt32LE(binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
        return Buffer.concat([header, jh, jsonBuf, bh, binPad]);
    }
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------
const UNLIT_SCALE = 1e-4;   // A zero scale gives a singular matrix in some engines.

function addAnimation(g, name, channels) {
    const anim = { name, samplers: [], channels: [] };
    for (const { node, pathName, times, values, type } of channels) {
        const input = g.accessor(times, 'SCALAR', { minmax: true });
        const output = g.accessor(values.flat(), type);
        anim.samplers.push({ input, output, interpolation: 'LINEAR' });
        anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path: pathName } });
    }
    g.json.animations.push(anim);
}

// Sum of sines with whole cycles over the loop, so the loop has no seam.
function loopNoise(t, period, seedVal, terms = [2, 3, 5, 7, 11]) {
    let v = 0, wsum = 0;
    terms.forEach((k, i) => {
        const w = 1 / (i + 1);
        v += w * Math.sin(2 * Math.PI * k * t / period + seedVal * (i + 1) * 2.39);
        wsum += w;
    });
    return v / wsum;  // about -1 .. 1
}

const quatZ = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

// ---------------------------------------------------------------------------
// Assemble the scene
// ---------------------------------------------------------------------------
const g = new GltfBuilder();

const matHull = g.material({ name: 'Hull', pbrMetallicRoughness: { baseColorFactor: [0.80, 0.82, 0.86, 1], metallicFactor: 0.55, roughnessFactor: 0.35 } });
const matEngine = g.material({ name: 'EngineCasing', pbrMetallicRoughness: { baseColorFactor: [0.32, 0.34, 0.38, 1], metallicFactor: 0.8, roughnessFactor: 0.4 } });
const matSpike = g.material({ name: 'AerospikePlug', pbrMetallicRoughness: { baseColorFactor: [0.42, 0.36, 0.30, 1], metallicFactor: 0.9, roughnessFactor: 0.45 } });
const matThroat = g.material({ name: 'ThroatSoot', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.05, 0.05, 1], metallicFactor: 0.2, roughnessFactor: 0.9 } });
const matGlass = g.material({ name: 'WindowGlass', pbrMetallicRoughness: { baseColorFactor: [0.02, 0.04, 0.08, 1], metallicFactor: 0.9, roughnessFactor: 0.06 } });
const matRim = g.material({ name: 'WindowRim', pbrMetallicRoughness: { baseColorFactor: [0.12, 0.13, 0.15, 1], metallicFactor: 0.9, roughnessFactor: 0.3 } });
// Flames are unlit: the color is the vertex color (COLOR_0, with alpha).
// A renderer can draw materials named "Flame_*" with additive blending and
// bloom for a stronger glow.
const flameMaterial = (name, blend) => g.material({
    name, doubleSided: true, ...(blend ? { alphaMode: 'BLEND' } : {}),
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
    extensions: { KHR_materials_unlit: {} },
});
const matFlameCore = flameMaterial('Flame_Core', true);
const matFlameMid = flameMaterial('Flame_Mid', true);
const matFlameOuter = flameMaterial('Flame_Outer', true);
const matThroatGlow = flameMaterial('Flame_ThroatGlow', false);

const hullMesh = g.mesh('Hull', [{ data: buildHull(), material: matHull }]);
const pylonMesh = g.mesh('Pylon', [{ data: buildPylon(), material: matEngine }]);
const win = buildWindows();
const windowMesh = g.mesh('Windows', [{ data: win.glass, material: matGlass }, { data: win.rim, material: matRim }]);
const eng = buildEngine();
const engineMesh = g.mesh('Engine', [
    { data: eng.body, material: matEngine },
    { data: eng.throat, material: matThroat },
    { data: eng.spike, material: matSpike },
]);
const throatGlowMesh = g.mesh('ThroatGlow', [{ data: buildThroatGlow(), material: matThroatGlow }]);

const LAYERS = [
    { key: 'Core', material: matFlameCore, opts: { offset0: 0.10, offset1: 0.06, plumeLen: 0.9, colorA: [1.0, 0.97, 0.82], colorB: [1.0, 0.80, 0.42], alpha0: 0.95, alpha1: 0.15, layerSeed: 0.3 } },
    { key: 'Mid', material: matFlameMid, opts: { offset0: 0.30, offset1: 0.26, plumeLen: 2.6, colorA: [1.0, 0.62, 0.20], colorB: [1.0, 0.45, 0.12], alpha0: 0.70, alpha1: 0.0, layerSeed: 1.9 } },
    { key: 'Outer', material: matFlameOuter, opts: { offset0: 0.55, offset1: 0.55, plumeLen: 4.8, colorA: [1.0, 0.78, 0.45], colorB: [0.95, 0.35, 0.10], alpha0: 0.35, alpha1: 0.0, layerSeed: 3.1 } },
];
const layerMeshes = LAYERS.map((L) => g.mesh(`Flame${L.key}`, [{ data: buildFlameLayer(L.opts), material: L.material }]));

const shipChildren = [];
shipChildren.push(g.node({ name: 'Hull', mesh: hullMesh }));
shipChildren.push(g.node({ name: 'Pylon', mesh: pylonMesh }));
shipChildren.push(g.node({ name: 'Windows', mesh: windowMesh }));

const engines = [];
for (const [side, x] of [['L', ENGINE_X], ['R', -ENGINE_X]]) {
    // "L" is the port side: with +Z forward and +Y up, port is +X.
    const layerNodes = LAYERS.map((L, i) => g.node({ name: `Engine${side}_Flame${L.key}`, mesh: layerMeshes[i] }));
    const glowNode = g.node({ name: `Engine${side}_ThroatGlow`, mesh: throatGlowMesh });
    const flameRoot = g.node({
        name: `Engine${side}_Flames`, scale: [UNLIT_SCALE, UNLIT_SCALE, UNLIT_SCALE],
        children: [glowNode, ...layerNodes],
    });
    const engNode = g.node({
        name: `Engine${side}`, mesh: engineMesh, translation: [x, ENGINE_Y, ENGINE_REAR_Z],
        children: [flameRoot],
    });
    shipChildren.push(engNode);
    engines.push({ side, flameRoot, layerNodes, glowNode });
}

const shipRoot = g.node({
    name: 'LunarGShip', children: shipChildren,
    extras: {
        description: 'G-profile ship. +Y up, +Z forward, meters. Engines are unlit until the flame roots are scaled to 1.',
        engineFlameRoots: engines.map((e) => g.json.nodes[e.flameRoot].name),
        animations: {
            EnginesIgnite: 'Play once and clamp at the end. Scales the flame roots from 0 to 1.',
            EnginesRunning: 'Loop. Flicker of the flame layers. Play together with EnginesIgnite.',
            EnginesShutdown: 'Play once and clamp at the end. Scales the flame roots from 1 to 0.',
        },
    },
});
g.json.scenes.push({ name: 'Scene', nodes: [shipRoot] });

// EnginesIgnite: a quick flash, overshoot, and settle.
{
    const times = [0, 0.12, 0.3, 0.55, 0.85, 1.2];
    const xy = [UNLIT_SCALE, 0.55, 0.85, 1.12, 0.96, 1.0];
    const z = [UNLIT_SCALE, 0.25, 0.7, 1.3, 0.92, 1.0];
    const channels = engines.map((e, i) => ({
        node: e.flameRoot, pathName: 'scale', type: 'VEC3',
        times: times.map((t) => t + i * 0.08),
        values: times.map((_, k) => [xy[k], xy[k], z[k]]),
    }));
    // Hold the unlit state until the second engine starts.
    channels[1].times.unshift(0); channels[1].values.unshift([UNLIT_SCALE, UNLIT_SCALE, UNLIT_SCALE]);
    addAnimation(g, 'EnginesIgnite', channels);
}

// EnginesShutdown
{
    const times = [0, 0.25, 0.6, 0.9];
    const xy = [1.0, 0.9, 0.45, UNLIT_SCALE];
    const z = [1.0, 0.75, 0.25, UNLIT_SCALE];
    addAnimation(g, 'EnginesShutdown', engines.map((e) => ({
        node: e.flameRoot, pathName: 'scale', type: 'VEC3', times, values: times.map((_, k) => [xy[k], xy[k], z[k]]),
    })));
}

// EnginesRunning: each layer pulses in length and width, turns slowly about
// the engine axis (this moves the color streaks), and wobbles with the morph
// targets. Layers and engines use different phases, so the overlap of the
// white core, orange middle, and outer plume changes all the time.
{
    const PERIOD = 4.0, FPS = 30, N = PERIOD * FPS;
    const times = Array.from({ length: N + 1 }, (_, i) => i / FPS);
    const channels = [];
    const amp = { Core: [0.06, 0.18], Mid: [0.08, 0.22], Outer: [0.10, 0.28] };
    const spin = { Core: 1, Mid: -1, Outer: 2 };
    engines.forEach((e, ei) => {
        LAYERS.forEach((L, li) => {
            const node = e.layerNodes[li];
            const sd = ei * 7.1 + li * 3.3 + 0.5;
            const [aw, al] = amp[L.key];
            channels.push({
                node, pathName: 'scale', type: 'VEC3', times,
                values: times.map((t) => {
                    const w = 1 + aw * loopNoise(t, PERIOD, sd, [3, 7, 11, 17, 23]);
                    const l = 1 + al * loopNoise(t, PERIOD, sd + 1.3, [4, 9, 13, 19, 29]);
                    return [w, w, l];
                }),
            });
            channels.push({
                node, pathName: 'rotation', type: 'VEC4', times,
                values: times.map((t) => quatZ(spin[L.key] * 2 * Math.PI * t / PERIOD + 0.4 * loopNoise(t, PERIOD, sd + 2.7))),
            });
            channels.push({
                node, pathName: 'weights', type: 'SCALAR', times,
                values: times.map((t) => [
                    clamp(0.5 + 0.5 * loopNoise(t, PERIOD, sd + 4.1, [5, 8, 13, 21, 31]), 0, 1),
                    clamp(0.5 + 0.5 * loopNoise(t, PERIOD, sd + 5.9, [6, 10, 15, 22, 27]), 0, 1),
                ]),
            });
        });
        channels.push({
            node: e.glowNode, pathName: 'rotation', type: 'VEC4', times,
            values: times.map((t) => quatZ((ei ? -1 : 1) * 4 * Math.PI * t / PERIOD)),
        });
        channels.push({
            node: e.glowNode, pathName: 'scale', type: 'VEC3', times,
            values: times.map((t) => { const s = 1 + 0.015 * loopNoise(t, PERIOD, ei + 9.0, [9, 14, 25, 33, 41]); return [s, s, 1]; }),
        });
    });
    addAnimation(g, 'EnginesRunning', channels);
}

fs.writeFileSync(OUT, g.toGlb());
console.log(`wrote ${OUT}`);
console.log(`engine: x=±${ENGINE_X} y=${ENGINE_Y.toFixed(2)} z=[${ENGINE_REAR_Z.toFixed(2)}, ${ENGINE_FRONT_Z.toFixed(2)}]`);
