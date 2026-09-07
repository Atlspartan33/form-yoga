// node test.mjs — geometry unit tests + a self-eval of the pose specs.
// No camera, no browser. Synthetic skeletons only.
import { POSES, POSE_BY_ID, SEQUENCES, evaluate, angleAt, refLandmarks, severity, statusOf } from './poses.js';

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
for (const s of SEQUENCES) {
  ok(`${s.id} steps all exist`, s.steps.every((id) => POSE_BY_ID[id]), s.steps.join(' → '));
}

// ---------------------------------------------------------------------------
// Ghost overlay fit: the reference must land on the user's hips, scale to their
// torso, and flip when they face the other way.
// ---------------------------------------------------------------------------
console.log('\n— ghost overlay fit —');
const { fitRef } = await import('./glyph.js');
const { dist } = await import('./poses.js');

const wd = POSE_BY_ID.downdog;
const base = refLandmarks(wd);
// A user twice the size of the reference, shifted to (1000, 400).
const big = base.map((p) => ({ ...p, x: p.x * 2 + 880, y: p.y * 2 + 320 }));
let bev = evaluate(wd, big);
let g = fitRef(wd, bev, big);
const gHip = { x: (g[23].x + g[24].x) / 2, y: (g[23].y + g[24].y) / 2 };
ok('ghost hips land on the user hips',
  Math.abs(gHip.x - bev.hip.x) < 0.5 && Math.abs(gHip.y - bev.hip.y) < 0.5,
  `${gHip.x.toFixed(1)},${gHip.y.toFixed(1)} vs ${bev.hip.x.toFixed(1)},${bev.hip.y.toFixed(1)}`);
const gTorso = dist({ x: (g[11].x + g[12].x) / 2, y: (g[11].y + g[12].y) / 2 }, gHip);
ok('ghost torso matches user torso', Math.abs(gTorso - bev.torso) < 0.5, `${gTorso.toFixed(1)} vs ${bev.torso.toFixed(1)}`);
ok('ghost lands on the user when they match the reference',
  fitRef(wd, evaluate(wd, base), base).every((p, i) => i < 11 && i > 0 ? true : Math.abs(p.x - base[i].x) < 0.5 && Math.abs(p.y - base[i].y) < 0.5));

// Mirror the user horizontally: the ghost must flip to face the same way.
const flipped = base.map((p) => ({ ...p, x: 400 - p.x }));
const fev = evaluate(wd, flipped);
const gf = fitRef(wd, fev, flipped);
const noseSideUser = Math.sign(flipped[0].x - fev.hip.x);
const noseSideGhost = Math.sign(gf[0].x - (gf[23].x + gf[24].x) / 2);
ok('ghost flips to match the user facing', noseSideUser === noseSideGhost, `user ${noseSideUser}, ghost ${noseSideGhost}`);

// ---------------------------------------------------------------------------
// Malformed input must degrade to 'unknown', never throw and never score.
// ---------------------------------------------------------------------------
console.log('\n— malformed landmarks —');
const mp = POSE_BY_ID.warrior2;
for (const [name, input] of [
  ['empty array', []],
  ['truncated array', refLandmarks(mp).slice(0, 20)],
  ['null entry', refLandmarks(mp).map((p, i) => (i === 25 ? null : p))],
  ['NaN coordinate', refLandmarks(mp).map((p, i) => (i === 25 ? { ...p, x: NaN } : p))],
  ['undefined entry', refLandmarks(mp).map((p, i) => (i === 13 ? undefined : p))],
]) {
  let threw = null, ev = null;
  try { ev = evaluate(mp, input); } catch (e) { threw = e; }
  ok(`${name} does not throw`, !threw, threw ? threw.message : '');
  if (ev) ok(`${name} scores nothing it cannot see`, ev.checks.every((c) => c.status !== 'unknown' ? Number.isFinite(c.value) : true));
}
ok('empty array yields no known checks', evaluate(mp, []).known === 0);
ok('empty array scores 0', evaluate(mp, []).score === 0);

// Degenerate geometry must read 'unknown', not land mid-range as a perfect score.
const flatPlank = refLandmarks(POSE_BY_ID.plank).map((p, i) => (i === 27 || i === 28 ? { ...p, x: (refLandmarks(POSE_BY_ID.plank)[11].x) } : p));
const degEv = evaluate(POSE_BY_ID.plank, flatPlank);
ok('degenerate body line is not a free pass', st(degEv, 'line') !== 'good', String(st(degEv, 'line')));

// ---------------------------------------------------------------------------
// Corrupt calibration must be ignored rather than silently failing every frame.
// ---------------------------------------------------------------------------
console.log('\n— corrupt tuning is ignored —');
const dd = POSE_BY_ID.downdog, ddlm = refLandmarks(dd);
for (const [name, bad] of [
  ['NaN range', { hips: [NaN, NaN] }],
  ['reversed range', { hips: [95, 55] }],
  ['wrong length', { hips: [90] }],
  ['not an array', { hips: 90 }],
]) {
  const ev = evaluate(dd, ddlm, bad);
  ok(`${name} falls back to shipped`, st(ev, 'hips') === 'good' && ev.checks.find((c) => c.id === 'hips').tuned === false);
}

// ---------------------------------------------------------------------------
// Mirror-image faults must not score identically to correct form.
// ---------------------------------------------------------------------------
console.log('\n— sign-aware checks —');
// Leaning BACK means the torso goes behind the hips while you still face the same
// way. (Mirroring the head too would just be turning around, which is not a fault.)
const chairBack = structuredClone(POSE_BY_ID.chair.ref);
const cRef = POSE_BY_ID.chair.ref;
const shMidX = (cRef.L.shoulder.x + cRef.R.shoulder.x) / 2;
const hipMidX = (cRef.L.hip.x + cRef.R.hip.x) / 2;
const headLead = cRef.nose.x - shMidX;          // where the head sits on the shoulders
for (const side of ['L', 'R']) {
  for (const part of ['shoulder', 'elbow', 'wrist']) {
    chairBack[side][part] = { ...chairBack[side][part], x: 2 * hipMidX - chairBack[side][part].x };
  }
}
chairBack.nose = { ...cRef.nose, x: (2 * hipMidX - shMidX) + headLead };   // head still leads the same way
const cbEv = evaluate(POSE_BY_ID.chair, refLandmarks({ ref: chairBack }));
ok('leaning back is not the same as hinging forward', st(cbEv, 'lean') !== 'good',
  `${val(cbEv, 'lean').toFixed(1)} vs +${val(evaluate(POSE_BY_ID.chair, refLandmarks(POSE_BY_ID.chair)), 'lean').toFixed(1)} forward`);
ok('lean-back cue names the fault', /leaning back/.test(cbEv.checks.find((c) => c.id === 'lean').cue));

const w2In = structuredClone(POSE_BY_ID.warrior2.ref);
w2In.L.knee = { x: 60, y: 130 };    // knee collapses inward toward the midline
const inEv = evaluate(POSE_BY_ID.warrior2, refLandmarks({ ref: w2In }));
ok('medial knee collapse is caught', st(inEv, 'track') !== 'good', val(inEv, 'track').toFixed(3));
ok('collapse cue names the fault', /falling inward/.test(inEv.checks.find((c) => c.id === 'track').cue));
const w2Out = structuredClone(POSE_BY_ID.warrior2.ref);
w2Out.L.knee = { x: 24, y: 130 };   // same distance, but splayed outward
const outEv = evaluate(POSE_BY_ID.warrior2, refLandmarks({ ref: w2Out }));
ok('inward and outward are told apart', val(inEv, 'track') < 0 && val(outEv, 'track') > 0,
  `in ${val(inEv, 'track').toFixed(2)}, out ${val(outEv, 'track').toFixed(2)}`);

// ---------------------------------------------------------------------------
// The flow advance rule itself, walked step by step.
// ---------------------------------------------------------------------------
console.log('\n— flow advance rule —');
// Mirrors tickFlow: advance when the NEXT pose is entered and beats the current one.
const advances = (curId, nextId, bodyId) => {
  const body = refLandmarks(POSE_BY_ID[bodyId]);
  const cur = evaluate(POSE_BY_ID[curId], body);
  const nxt = evaluate(POSE_BY_ID[nextId], body);
  return nxt.inPose && nxt.score >= 0.7 && nxt.score > cur.score;
};
for (const seq of SEQUENCES) {
  let good = true, detail = '';
  for (let i = 0; i < seq.steps.length - 1; i++) {
    const [a, b] = [seq.steps[i], seq.steps[i + 1]];
    if (advances(a, b, a)) { good = false; detail = `${a}→${b} fires while still in ${a}`; break; }
    if (!advances(a, b, b)) { good = false; detail = `${a}→${b} does not fire when in ${b}`; break; }
  }
  ok(`${seq.id} advances once per step, never early`, good, detail);
}
// A body in some unrelated pose must not trigger an advance.
ok('an unrelated shape does not advance the flow',
  !advances('mountain', 'forwardfold', 'warrior2') && !advances('plank', 'chaturanga', 'tree'));

// ---------------------------------------------------------------------------
// store.js against an injected localStorage.
// ---------------------------------------------------------------------------
console.log('\n— store —');
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
mem.set('yf.history', JSON.stringify({ not: 'an array' }));
mem.set('yf.tuning', JSON.stringify({ downdog: { hips: [NaN, NaN] }, plank: { line: [-0.4, 0.4] } }));
const store = await import('./store.js');
ok('wrong-shaped history degrades to empty', Array.isArray(store.history) && store.history.length === 0);
ok('summary survives a corrupt history', store.summary().total === 0);
ok('invalid tuning range is dropped', !store.tuningFor('downdog'));
ok('valid tuning range survives', store.tuningFor('plank')?.line?.[0] === -0.4);
ok('statsFor on an unpractised pose is null', store.statsFor('tree') === null);

store.addEntry({ poseId: 'tree', name: 'Tree', secs: 20, score: 0.8, side: 'Left' });
store.addEntry({ poseId: 'tree', name: 'Tree', secs: 20, score: 0.5, side: 'Right' });
ok('statsFor pools both sides by default', store.statsFor('tree').count === 2);
ok('statsFor can filter to one side', store.statsFor('tree', 'Right').best === 0.5,
  String(store.statsFor('tree', 'Right').best));
ok('streak counts today', store.streak() === 1);
ok('write failure does not corrupt memory', (() => {
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  store.addEntry({ poseId: 'plank', name: 'Plank', secs: 5, score: 1 });
  return store.history.length === 3;
})());

console.log(fails ? `\n${fails} FAILING\n` : `\nall passing\n`);
process.exit(fails ? 1 : 0);
