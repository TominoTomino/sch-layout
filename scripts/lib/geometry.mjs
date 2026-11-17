export const EPS = 1e-6;

export const eq = (a, b) => Math.abs(a - b) < EPS;
export const ptEq = (p, q) => eq(p[0], q[0]) && eq(p[1], q[1]);

export function isOrthogonal(p, q) {
  return eq(p[0], q[0]) || eq(p[1], q[1]);
}

export function bboxOfRects(rects) {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inflate(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

export function deflate(r, d) {
  const nw = r.w - 2 * d;
  const nh = r.h - 2 * d;
  if (nw <= 0 || nh <= 0) return null;
  return { x: r.x + d, y: r.y + d, w: nw, h: nh };
}

export function rectsOverlap(a, b, tol = 0) {
  return !(a.x + a.w <= b.x + tol || b.x + b.w <= a.x + tol ||
           a.y + a.h <= b.y + tol || b.y + b.h <= a.y + tol);
}

export function rectContainsPoint(r, p) {
  return p[0] >= r.x - EPS && p[0] <= r.x + r.w + EPS &&
         p[1] >= r.y - EPS && p[1] <= r.y + r.h + EPS;
}

// Liang-Barsky clip of segment against axis-aligned rect.
// Returns [t0, t1] parameter interval inside the rect, or null.
export function clipSegmentToRect(p, q, r) {
  if (!r) return null;
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const P = [-dx, dx, -dy, dy];
  const Q = [p[0] - r.x, r.x + r.w - p[0], p[1] - r.y, r.y + r.h - p[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(P[i]) < EPS) {
      if (Q[i] < 0) return null;
      continue;
    }
    const t = Q[i] / P[i];
    if (P[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

// True when the segment passes through the rect's interior for more than `minLen` units.
export function segmentCrossesRect(p, q, r, minLen, inset = 0) {
  const rr = inset ? deflate(r, inset) : r;
  if (!rr) return false;
  const iv = clipSegmentToRect(p, q, rr);
  if (!iv) return false;
  const segLen = Math.hypot(q[0] - p[0], q[1] - p[1]);
  return (iv[1] - iv[0]) * segLen > minLen;
}

// Proper intersection. Returns {t,u,point} where t,u in (0,1) strictly,
// so T-junctions and shared corners are NOT counted as crossings.
export function properCrossing(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < EPS) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { t, u, point: [p1[0] + t * d1x, p1[1] + t * d1y], inLen: Math.min(t, 1 - t) * Math.hypot(d1x, d1y) };
}

export function countBends(points) {
  let bends = 0;
  let prevDir = null;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    const dir = Math.abs(dx) >= Math.abs(dy)
      ? (dx > 0 ? 'R' : 'L')
      : (dy > 0 ? 'U' : 'D');
    if (prevDir && dir !== prevDir) bends++;
    prevDir = dir;
  }
  return bends;
}

export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.abs(points[i][0] - points[i - 1][0]) + Math.abs(points[i][1] - points[i - 1][1]);
  }
  return len;
}

export function segmentLength(a, b) {
  return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
}

export function pointOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return ptEq(p, a);
  const cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
  if (Math.abs(cross) / len > 1e-3) return false;
  const dot = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
  return dot >= -EPS && dot <= len * len + EPS;
}

export function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[i];
}

// Most frequent value in a list of integers, ignoring zeros.
export function modeOf(arr) {
  const m = new Map();
  for (const v of arr) {
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [v, c] of m) {
    if (c > bestCount || (c === bestCount && v < best)) { best = v; bestCount = c; }
  }
  return best === null ? null : { value: best, count: bestCount };
}
