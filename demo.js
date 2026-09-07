// demo.js — synthesise a moving body so the whole session UI can be driven without a
// camera (append ?demo to the URL). Also how the session screen gets tested.
import { refLandmarks } from './poses.js';

/**
 * Returns fn(tSeconds, w, h) → 33 normalised landmarks, built from the pose's own
 * reference skeleton with slow drift so checks travel good → close → off and back.
 */
export function demoSource(pose) {
  const base = refLandmarks(pose);
  // Joints that, when nudged, break a real check: hips, knees, elbows, head.
  const DRIFT = [23, 24, 25, 26, 13, 14, 0];
  return (t, w, h) => {
    const scale = Math.min(w, h) / 260;
    const ox = w / 2 - 100 * scale, oy = h / 2 - 100 * scale;
    const wobble = Math.sin(t * 0.55) * 26;          // slow, large: swings the verdict
    const breathe = Math.sin(t * 2.1) * 1.4;         // small: keeps the skeleton alive
    return base.map((p, i) => {
      const d = DRIFT.includes(i) ? wobble : 0;
      const x = p.x + breathe * 0.4;
      const y = p.y + d + breathe;
      return {
        x: (ox + x * scale) / w,
        y: (oy + y * scale) / h,
        z: 0,
        visibility: p.visibility,
      };
    });
  };
}
