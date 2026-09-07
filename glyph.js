// glyph.js — draw reference skeletons. The tile diagram and the in-session ghost
// come from the same data the checker scores against, so what you see is the target.
import { CONNECTIONS, refLandmarks, dist } from './poses.js';

const HEAD = [0];
const FAR = new Set([12, 14, 16, 24, 26, 28, 30, 32]);

/** Inline SVG diagram of a pose's reference skeleton. */
export function glyphSVG(pose, { size = 110, stroke = 6 } = {}) {
  const lm = refLandmarks(pose);
  const pts = lm.filter((p, i) => i === 0 || i >= 11);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const pad = 16;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = maxX - minX, h = maxY - minY, s = Math.max(w, h);
  const ox = minX - (s - w) / 2, oy = minY - (s - h) / 2;

  const line = (a, b) => {
    const far = FAR.has(a) && FAR.has(b);
    return `<line x1="${lm[a].x}" y1="${lm[a].y}" x2="${lm[b].x}" y2="${lm[b].y}" ${far ? 'class="far"' : ''}/>`;
  };
  const headR = dist(lm[11], lm[23]) * 0.22;
  return `<svg viewBox="${ox} ${oy} ${s} ${s}" width="${size}" height="${size}" class="glyph" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
      ${CONNECTIONS.map(([a, b]) => line(a, b)).join('')}
    </g>
    <circle cx="${lm[HEAD[0]].x}" cy="${lm[HEAD[0]].y}" r="${headR}" fill="currentColor"/>
  </svg>`;
}

/**
 * Transform a pose's reference skeleton into the user's frame: matched hip position,
 * torso scale, and facing direction. Returns a 33-point array in video pixels.
 */
export function fitRef(pose, ev, lm) {
  const r = refLandmarks(pose);
  const rHip = { x: (r[23].x + r[24].x) / 2, y: (r[23].y + r[24].y) / 2 };
  const rShoulder = { x: (r[11].x + r[12].x) / 2, y: (r[11].y + r[12].y) / 2 };
  const rTorso = dist(rHip, rShoulder) || 1;
  const k = ev.torso / rTorso;

  // Which way is the reference facing vs the user? Compare nose offset from the hips.
  const refDir = Math.sign(r[0].x - rHip.x) || 1;
  const userDir = Math.sign(lm[0].x - ev.hip.x) || 1;
  const flip = refDir === userDir ? 1 : -1;

  return r.map((p) => ({
    x: ev.hip.x + (p.x - rHip.x) * k * flip,
    y: ev.hip.y + (p.y - rHip.y) * k,
    visibility: p.visibility,
  }));
}

/** Draw a faint target skeleton on the canvas. */
export function drawGhost(ctx, ghost, scale = 1) {
  ctx.save();
  ctx.strokeStyle = 'rgba(198,255,61,0.34)';
  ctx.lineWidth = 10 * scale;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  for (const [a, b] of CONNECTIONS) {
    if (ghost[a].visibility < 0.4 || ghost[b].visibility < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(ghost[a].x, ghost[a].y);
    ctx.lineTo(ghost[b].x, ghost[b].y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(198,255,61,0.30)';
  const r = dist(ghost[11], ghost[23]) * 0.22;
  ctx.beginPath();
  ctx.arc(ghost[0].x, ghost[0].y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
