// node test.mjs — geometry unit tests + a self-eval of the pose specs.
// No camera, no browser. Synthetic skeletons only.
import { POSES, POSE_BY_ID, evaluate, angleAt, refLandmarks, severity, statusOf } from './poses.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? ' pass' : ' FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!cond) fails++;
};
const st = (ev, id) => ev.checks.find((c) => c.id === id).status;
const val = (ev, id) => ev.checks.find((c) => c.id === id).value;

// Build a 33-point skeleton from named joints (far side mirrors near unless given).
function body(joints, far = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.15 }));
  const S = { shoulder: [11, 12], elbow: [13, 14], wrist: [15, 16], hip: [23, 24], knee: [25, 26], ankle: [27, 28], heel: [29, 30], foot: [31, 32] };
  for (const [k, [L, R]] of Object.entries(S)) {
    if (joints[k]) {
      lm[L] = { ...joints[k], z: 0, visibility: joints[k].visibility ?? 1 };
      const r = far[k] ?? joints[k];
      lm[R] = { ...r, z: 0, visibility: r.visibility ?? 1 };
    }
  }
  if (joints.nose) lm[0] = { ...joints.nose, z: 0, visibility: 1 };
  return lm;
}

console.log('\n— geometry —');
ok('angleAt right angle', Math.abs(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }) - 90) < 1e-9);
ok('angleAt straight line', Math.abs(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }) - 180) < 1e-9);
ok('statusOf inside range', statusOf([80, 100], 10, 90) === 'good');
ok('statusOf in slack band', statusOf([80, 100], 10, 105) === 'close');
ok('statusOf outside', statusOf([80, 100], 10, 130) === 'off');
ok('severity 0 inside', severity([80, 100], 10, 90) === 0);
ok('severity scales with slack', severity([80, 100], 10, 110) === 1);

// ---------------------------------------------------------------------------
// Every reference skeleton must score 1.0 against its OWN spec.
// If this fails, the drawing on the tile is not the thing the checker wants.
// ---------------------------------------------------------------------------
console.log('\n— reference poses pass their own spec —');
for (const p of POSES) {
  const ev = evaluate(p, refLandmarks(p));
  const bad = ev.checks.filter((c) => c.status !== 'good');
  ok(`${p.id} scores 1.0`, ev.score === 1 && ev.known === ev.total,
    bad.length ? bad.map((c) => `${c.id}=${c.value.toFixed(2)}(${c.status}) want ${c.range}`).join(' ') : `${ev.known}/${ev.total} checks`);
}

// Asymmetric poses must report which side is working.
console.log('\n— side detection —');
for (const p of POSES.filter((x) => x.asymmetric)) {
  ok(`${p.id} reports a side`, evaluate(p, refLandmarks(p)).side === 'Left');
}
ok('symmetric pose reports no side', evaluate(POSE_BY_ID.plank, refLandmarks(POSE_BY_ID.plank)).side === null);
ok('catcow ref reads as Cow', evaluate(POSE_BY_ID.catcow, refLandmarks(POSE_BY_ID.catcow)).phase === 'Cow');

// ---------------------------------------------------------------------------
// Confusion matrix: score every reference skeleton against every pose spec.
// The diagonal must win its own row, or the flow will advance to the wrong pose.
// ---------------------------------------------------------------------------
console.log('\n— spec discrimination (rows = reference skeleton, cols = spec) —');
const ids = POSES.map((p) => p.id);
const M = {};
for (const rp of POSES) {
  const lm = refLandmarks(rp);
  M[rp.id] = {};
  for (const sp of POSES) M[rp.id][sp.id] = evaluate(sp, lm).score;
}
const w = 12;
console.log(''.padEnd(w) + ids.map((i) => i.slice(0, 5).padStart(6)).join(''));
for (const r of ids) {
  console.log(r.padEnd(w) + ids.map((cid) => {
    const v = M[r][cid];
    return (r === cid ? `[${v.toFixed(1)}]` : v.toFixed(2)).padStart(6);
  }).join(''));
}
for (const r of ids) {
  const others = ids.filter((c) => c !== r).map((c) => M[r][c]);
  const best = Math.max(...others);
  const worst = ids.filter((c) => c !== r).find((c) => M[r][c] === best);
  ok(`${r} beats every other spec`, M[r][r] > best, `self 1.00 vs best rival ${worst} ${best.toFixed(2)}`);
}
const margins = ids.map((r) => M[r][r] - Math.max(...ids.filter((c) => c !== r).map((c) => M[r][c])));
console.log(`  min margin ${Math.min(...margins).toFixed(2)}, mean ${(margins.reduce((a, b) => a + b) / margins.length).toFixed(2)}`);

// ---------------------------------------------------------------------------
// Degradation: a correct pose that gets worse must be caught, with the right cue.
// ---------------------------------------------------------------------------
console.log('\n— bad form is caught —');
const plankSag = body(
  { nose: { x: 58, y: 112 }, shoulder: { x: 80, y: 120 }, elbow: { x: 78, y: 148 }, wrist: { x: 76, y: 176 },
    hip: { x: 126, y: 168 }, knee: { x: 160, y: 128 }, ankle: { x: 188, y: 132 }, heel: { x: 196, y: 126 }, foot: { x: 198, y: 142 } });
let ev = evaluate(POSE_BY_ID.plank, plankSag);
ok('sagging plank flagged', st(ev, 'line') === 'off', val(ev, 'line').toFixed(3));
ok('cue tells him to lift hips', /Lift your hips/.test(ev.checks.find((c) => c.id === 'line').cue));

const w2Shallow = structuredClone(POSE_BY_ID.warrior2.ref);
w2Shallow.L.knee = { x: 60, y: 160 };            // knee drifts back, too straight
ev = evaluate(POSE_BY_ID.warrior2, refLandmarks({ ref: w2Shallow }));
ok('shallow warrior knee flagged', st(ev, 'frontKnee') !== 'good', val(ev, 'frontKnee').toFixed(1));
ok('cue tells him to bend deeper', /Bend deeper/.test(ev.checks.find((c) => c.id === 'frontKnee').cue));

const treeDrop = structuredClone(POSE_BY_ID.tree.ref);
treeDrop.L.hip = { x: 92, y: 132 };              // hip drops on the lifted side
ev = evaluate(POSE_BY_ID.tree, refLandmarks({ ref: treeDrop }));
ok('dropped hip flagged in tree', st(ev, 'hips') !== 'good', val(ev, 'hips').toFixed(3));

const cobraRef = POSE_BY_ID.cobra.ref;
ev = evaluate(POSE_BY_ID.updog, refLandmarks(POSE_BY_ID.cobra));
ok('cobra fails updog thighs-off-mat', st(ev, 'thighs') !== 'good', val(ev, 'thighs').toFixed(3));
ok('cobra ref does not satisfy updog', evaluate(POSE_BY_ID.updog, refLandmarks(POSE_BY_ID.cobra)).score < 0.75, cobraRef && '');

// ---------------------------------------------------------------------------
// Occlusion: hidden joints must report "unknown", never a confident wrong answer.
// ---------------------------------------------------------------------------
console.log('\n— occlusion is admitted, not guessed —');
const hidden = refLandmarks(POSE_BY_ID.warrior2).map((p, i) => (i === 25 || i === 26 ? { ...p, visibility: 0.1 } : p));
ev = evaluate(POSE_BY_ID.warrior2, hidden);
ok('knee checks go unknown when knees hidden', st(ev, 'frontKnee') === 'unknown' && st(ev, 'backLeg') === 'unknown');
ok('visible checks still scored', st(ev, 'arms') === 'good');
ok('score ignores unknown checks', ev.score === 1 && ev.known < ev.total, `${ev.known}/${ev.total} known`);

const ghost = refLandmarks(POSE_BY_ID.mountain).map((p) => ({ ...p, visibility: 0.1 }));
ok('whole body hidden ⇒ low visibility', evaluate(POSE_BY_ID.mountain, ghost).visible < 0.5);
ok('whole body hidden ⇒ score 0', evaluate(POSE_BY_ID.mountain, ghost).score === 0);

// ---------------------------------------------------------------------------
// Tuning overrides (calibration) must actually change the verdict.
// ---------------------------------------------------------------------------
console.log('\n— calibration overrides —');
const strict = evaluate(POSE_BY_ID.downdog, refLandmarks(POSE_BY_ID.downdog), { hips: [80, 95] });
ok('tightened range can fail a good pose', st(strict, 'hips') !== 'good', val(strict, 'hips').toFixed(1));
ok('tuned flag is set', strict.checks.find((c) => c.id === 'hips').tuned === true);
const loose = evaluate(POSE_BY_ID.plank, plankSag, { line: [-1.2, 1.2] });
ok('widened range can pass a bad pose', st(loose, 'line') === 'good');

// ---------------------------------------------------------------------------
console.log('\n— sequences —');
const { SEQUENCES } = await import('./poses.js');
for (const s of SEQUENCES) {
  ok(`${s.id} steps all exist`, s.steps.every((id) => POSE_BY_ID[id]), s.steps.join(' → '));
}

console.log(fails ? `\n${fails} FAILING\n` : `\nall passing\n`);
process.exit(fails ? 1 : 0);
