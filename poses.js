// poses.js — geometry, pose specs, reference skeletons, evaluation. Pure. No DOM.
// Landmarks are MediaPipe Pose (33 pts) in PIXEL space: {x, y, z, visibility}.
// MediaPipe indices are ANATOMICAL (11 = the person's actual left shoulder), so
// left/right survive camera mirroring without correction.

export const LM = { NOSE: 0 };

const SIDE = {
  L: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, foot: 31 },
  R: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, foot: 32 },
};
const PARTS = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'heel', 'foot'];

export const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

// ---------- geometry ----------
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Interior angle at b, in degrees. */
export function angleAt(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, cbx = c.x - b.x, cby = c.y - b.y;
  const m = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!m) return 0;
  return deg(Math.acos(clamp((abx * cbx + aby * cby) / m, -1, 1)));
}
/** Angle of segment a→b from horizontal, 0..90. */
export function fromHorizontal(a, b) {
  return deg(Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)));
}
export function fromVertical(a, b) { return 90 - fromHorizontal(a, b); }
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Vertical offset of p from line a–b at p.x, normalised later. Positive = p is BELOW the line. */
function belowLine(p, a, b) {
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-6) return 0;
  return p.y - (a.y + (p.x - a.x) * ((b.y - a.y) / dx));
}

// ---------- context ----------
// Resolves role names ('near.knee', 'front.hip', 'mid.shoulder') and records which
// landmarks each measurement actually touched, so a check whose joints are hidden
// can report "unknown" instead of a confident wrong number.
export function makeContext(lm) {
  const vis = (i) => lm[i]?.visibility ?? 1;
  const sideVis = (s) => ['shoulder', 'hip', 'knee', 'ankle'].reduce((t, k) => t + vis(SIDE[s][k]), 0);
  const near = sideVis('L') >= sideVis('R') ? 'L' : 'R';
  const kneeAngle = (s) => angleAt(lm[SIDE[s].hip], lm[SIDE[s].knee], lm[SIDE[s].ankle]);
  const bent = kneeAngle('L') <= kneeAngle('R') ? 'L' : 'R';
  const roles = {
    near, far: near === 'L' ? 'R' : 'L',
    front: bent, back: bent === 'L' ? 'R' : 'L',   // lunges
    lift: bent, stand: bent === 'L' ? 'R' : 'L',   // tree
    L: 'L', R: 'R',
  };

  const touched = new Set();
  const idxOf = (name) => {
    if (name === 'nose') return 0;
    const [role, part] = name.split('.');
    return SIDE[roles[role]]?.[part];
  };
  const p = (name) => {
    if (name === 'nose') { touched.add(0); return lm[0]; }
    const [role, part] = name.split('.');
    if (role === 'mid') {
      touched.add(SIDE.L[part]); touched.add(SIDE.R[part]);
      return mid(lm[SIDE.L[part]], lm[SIDE.R[part]]);
    }
    const i = SIDE[roles[role]][part];
    touched.add(i);
    return lm[i];
  };

  const torso = dist(p('mid.shoulder'), p('mid.hip')) || 1;
  const shin = dist(p('near.knee'), p('near.ankle')) || 1;
  touched.clear();

  return {
    lm, p, roles, torso, shin, idxOf,
    angle: (a, b, c) => angleAt(p(a), p(b), p(c)),
    horiz: (a, b) => fromHorizontal(p(a), p(b)),
    vert: (a, b) => fromVertical(p(a), p(b)),
    below: (pt, a, b) => belowLine(p(pt), p(a), p(b)) / torso,
    dx: (a, b) => Math.abs(p(a).x - p(b).x),
    dy: (a, b) => p(a).y - p(b).y,   // positive = a lower on screen than b
    beginTouch: () => touched.clear(),
    touchedVis: () => (touched.size ? Math.min(...[...touched].map(vis)) : 1),
    touchedList: () => [...touched],
    // --- coarse orientation signature, used by gates ---
    // Signed torso angle: +90 = standing tall, 0 = horizontal, -90 = folded/inverted.
    tilt: () => {
      const s = p('mid.shoulder'), h = p('mid.hip');
      return fromHorizontal(h, s) * (s.y <= h.y ? 1 : -1);
    },
    // Where the hands are relative to the hips, in torso-lengths. +ve = below hips.
    reach: () => (p('near.wrist').y - p('mid.hip').y) / torso,
    // How far the feet are from under the hips. Separates Down Dog from a Forward Fold.
    spread: () => Math.abs(p('near.ankle').x - p('mid.hip').x) / torso,
    bodyVisible: () => PARTS.slice(0, 6).reduce((t, k) => t + vis(SIDE.L[k]) + vis(SIDE.R[k]), 0) / 12,
  };
}

// ---------- spec helpers ----------
const C = (id, label, measure, range, cue, o = {}) =>
  ({ id, label, measure, range, cue, slack: o.slack ?? 10, unit: o.unit ?? '°', joints: o.joints ?? [] });

// Gates answer "are you even in this shape?" before the checks refine it.
// Without them a spec made only of refinements matches poses it was never meant to:
// standing in Mountain satisfies every Upward Dog check. Gates are coarse and decisive.
const gate = (id, label, measure, range, slack, unit = '°') => ({ id, label, measure, range, slack, unit, joints: [], isGate: true });
const G = {
  tilt: (range, slack = 5) => gate('tilt', 'Body angle', (c) => c.tilt(), range, slack),
  reach: (range, slack = 0.25) => gate('reach', 'Hand position', (c) => c.reach(), range, slack, 'x'),
  spread: (range, slack = 0.15) => gate('spread', 'Feet position', (c) => c.spread(), range, slack, 'x'),
};

const sagOrPike = (v) => (v > 0 ? 'Lift your hips — squeeze your glutes' : 'Lower your hips into one straight line');

// Reference skeletons: the ideal shape, in a 200×200 box (y grows downward).
// Every one is asserted to score 1.0 against its own spec in test.mjs — so the
// drawing you see on the tile is literally the thing the checker is looking for.
const ref = (nose, L, R, sideOn = true) => ({ nose, L, R, sideOn });
const pt = (x, y) => ({ x, y });

export const POSES = [
  {
    id: 'mountain', name: 'Mountain', sanskrit: 'Tadasana', camera: 'side', family: 'standing',
    hint: 'Stand side-on to the camera, whole body in frame.',
    ref: ref(pt(86, 26),
      { shoulder: pt(90, 52), elbow: pt(90, 84), wrist: pt(90, 112), hip: pt(92, 110), knee: pt(92, 152), ankle: pt(92, 190), heel: pt(86, 194), foot: pt(104, 194) },
      { shoulder: pt(96, 52), elbow: pt(96, 84), wrist: pt(96, 112), hip: pt(98, 110), knee: pt(98, 152), ankle: pt(98, 190), heel: pt(92, 194), foot: pt(110, 194) }),
    gates: [G.tilt([80, 90]), G.reach([-0.35, 0.45])],
    checks: [
      C('legs', 'Legs straight', (c) => c.angle('near.hip', 'near.knee', 'near.ankle'), [168, 180], 'Straighten your legs', { slack: 8, joints: ['near.knee'] }),
      C('torso', 'Torso upright', (c) => c.vert('mid.hip', 'mid.shoulder'), [0, 6], 'Stack your shoulders over your hips', { slack: 6, joints: ['near.shoulder', 'near.hip'] }),
      C('head', 'Head over shoulders', (c) => c.dx('nose', 'mid.shoulder') / c.torso, [0, 0.3], 'Draw your chin back over your chest', { slack: 0.12, unit: 'x', joints: ['nose'] }),
    ],
  },
  {
    id: 'chair', name: 'Chair', sanskrit: 'Utkatasana', camera: 'side', family: 'standing',
    hint: 'Side-on. Sit back, arms overhead.',
    ref: ref(pt(84, 44),
      { shoulder: pt(92, 62), elbow: pt(84, 40), wrist: pt(77, 18), hip: pt(110, 114), knee: pt(76, 158), ankle: pt(90, 192), heel: pt(84, 196), foot: pt(102, 196) },
      { shoulder: pt(98, 62), elbow: pt(90, 40), wrist: pt(83, 18), hip: pt(116, 114), knee: pt(82, 158), ankle: pt(96, 192), heel: pt(90, 196), foot: pt(108, 196) }),
    gates: [G.tilt([62, 84]), G.reach([-2.3, -1.3], 0.3)],
    checks: [
      C('knees', 'Knee bend', (c) => c.angle('near.hip', 'near.knee', 'near.ankle'), [85, 125], (v) => (v > 125 ? 'Sit deeper, like into a chair' : 'Rise up a little'), { slack: 12, joints: ['near.knee'] }),
      C('lean', 'Torso lean', (c) => c.vert('mid.hip', 'mid.shoulder'), [15, 45], (v) => (v < 15 ? 'Hinge forward from the hips' : 'Lift your chest, do not collapse forward'), { slack: 10, joints: ['near.shoulder', 'near.hip'] }),
      C('arms', 'Arms overhead', (c) => c.angle('near.hip', 'near.shoulder', 'near.wrist'), [150, 180], 'Reach your arms up in line with your ears', { slack: 15, joints: ['near.shoulder', 'near.wrist'] }),
      C('weight', 'Weight in heels', (c) => c.dx('near.knee', 'near.ankle') / c.shin, [0, 0.45], 'Shift your weight back into your heels', { slack: 0.15, unit: 'x', joints: ['near.knee', 'near.ankle'] }),
    ],
  },
  {
    id: 'warrior2', name: 'Warrior II', sanskrit: 'Virabhadrasana II', camera: 'front', family: 'standing', asymmetric: true,
    hint: 'Face the camera. Legs wide, arms out.',
    ref: ref(pt(96, 46),
      { shoulder: pt(84, 74), elbow: pt(52, 75), wrist: pt(20, 76), hip: pt(88, 126), knee: pt(42, 130), ankle: pt(42, 192), heel: pt(50, 196), foot: pt(28, 194) },
      { shoulder: pt(108, 74), elbow: pt(140, 75), wrist: pt(172, 76), hip: pt(104, 126), knee: pt(140, 158), ankle: pt(174, 190), heel: pt(166, 194), foot: pt(188, 196) }, false),
    gates: [G.tilt([80, 90]), G.reach([-1.35, -0.65], 0.2)],
    checks: [
      C('frontKnee', 'Front knee', (c) => c.angle('front.hip', 'front.knee', 'front.ankle'), [80, 105], (v) => (v > 105 ? 'Bend deeper into your front knee' : 'Ease off the front knee'), { slack: 12, joints: ['front.knee'] }),
      C('backLeg', 'Back leg', (c) => c.angle('back.hip', 'back.knee', 'back.ankle'), [160, 180], 'Straighten your back leg', { slack: 10, joints: ['back.knee'] }),
      C('arms', 'Arms level', (c) => Math.max(c.horiz('L.shoulder', 'L.wrist'), c.horiz('R.shoulder', 'R.wrist')), [0, 12], 'Reach your arms out level with the floor', { slack: 8, joints: ['L.wrist', 'R.wrist'] }),
      C('torso', 'Torso upright', (c) => c.vert('mid.hip', 'mid.shoulder'), [0, 10], 'Stack your torso straight over your hips', { slack: 8, joints: ['L.shoulder', 'R.shoulder'] }),
      C('track', 'Knee over ankle', (c) => c.dx('front.knee', 'front.ankle') / c.shin, [0, 0.3], 'Track your front knee out over your ankle', { slack: 0.15, unit: 'x', joints: ['front.knee', 'front.ankle'] }),
    ],
  },
  {
    id: 'tree', name: 'Tree', sanskrit: 'Vrksasana', camera: 'front', family: 'balance', asymmetric: true,
    hint: 'Face the camera. Foot to calf or inner thigh.',
    ref: ref(pt(100, 46),
      { shoulder: pt(88, 66), elbow: pt(78, 40), wrist: pt(97, 20), hip: pt(92, 116), knee: pt(62, 142), ankle: pt(96, 158), heel: pt(100, 162), foot: pt(88, 152) },
      { shoulder: pt(112, 66), elbow: pt(122, 40), wrist: pt(103, 20), hip: pt(108, 116), knee: pt(110, 154), ankle: pt(110, 192), heel: pt(104, 196), foot: pt(120, 196) }, false),
    gates: [G.tilt([80, 90]), G.reach([-2.5, -1.45], 0.2)],
    checks: [
      C('stand', 'Standing leg', (c) => c.angle('stand.hip', 'stand.knee', 'stand.ankle'), [165, 180], 'Straighten your standing leg', { slack: 10, joints: ['stand.knee'] }),
      C('lift', 'Lifted knee open', (c) => c.angle('lift.hip', 'lift.knee', 'lift.ankle'), [30, 110], 'Draw your lifted foot higher up the leg', { slack: 15, joints: ['lift.knee'] }),
      C('hips', 'Hips level', (c) => Math.abs(c.dy('L.hip', 'R.hip')) / c.torso, [0, 0.08], 'Level your hips', { slack: 0.06, unit: 'x', joints: ['L.hip', 'R.hip'] }),
      C('torso', 'Torso upright', (c) => c.vert('mid.hip', 'mid.shoulder'), [0, 6], 'Grow tall through the crown of your head', { slack: 6, joints: ['L.shoulder', 'R.shoulder'] }),
    ],
  },
  {
    id: 'forwardfold', name: 'Forward Fold', sanskrit: 'Uttanasana', camera: 'side', family: 'standing',
    hint: 'Side-on. Fold from the hips, not the waist.',
    ref: ref(pt(90, 168),
      { shoulder: pt(96, 140), elbow: pt(94, 158), wrist: pt(96, 182), hip: pt(112, 88), knee: pt(108, 140), ankle: pt(104, 190), heel: pt(98, 194), foot: pt(116, 194) },
      { shoulder: pt(102, 140), elbow: pt(100, 158), wrist: pt(102, 182), hip: pt(118, 88), knee: pt(114, 140), ankle: pt(110, 190), heel: pt(104, 194), foot: pt(122, 194) }),
    gates: [G.tilt([-85, -62]), G.reach([1.35, 2.2], 0.3), G.spread([0, 0.4])],
    checks: [
      C('fold', 'Fold depth', (c) => c.angle('near.shoulder', 'near.hip', 'near.knee'), [0, 70], 'Fold deeper from the hips', { slack: 15, joints: ['near.hip'] }),
      C('legs', 'Legs long', (c) => c.angle('near.hip', 'near.knee', 'near.ankle'), [150, 180], 'Lengthen through the backs of your legs', { slack: 12, joints: ['near.knee'] }),
      C('head', 'Head hangs heavy', (c) => c.dy('nose', 'mid.hip') / c.torso, [0.2, 3], 'Let your head and neck hang heavy', { slack: 0.2, unit: 'x', joints: ['nose'] }),
    ],
  },
  {
    id: 'plank', name: 'Plank', sanskrit: 'Phalakasana', camera: 'side', family: 'floor',
    hint: 'Side-on, tablet on the floor.',
    ref: ref(pt(58, 112),
      { shoulder: pt(80, 120), elbow: pt(78, 148), wrist: pt(76, 176), hip: pt(126, 124), knee: pt(160, 128), ankle: pt(188, 132), heel: pt(196, 126), foot: pt(198, 142) },
      { shoulder: pt(86, 120), elbow: pt(84, 148), wrist: pt(82, 176), hip: pt(132, 124), knee: pt(166, 128), ankle: pt(194, 132), heel: pt(200, 126), foot: pt(202, 142) }),
    gates: [G.tilt([-12, 14]), G.reach([0.85, 1.5])],
    checks: [
      C('line', 'Body line', (c) => c.below('near.hip', 'near.shoulder', 'near.ankle'), [-0.1, 0.1], sagOrPike, { slack: 0.08, unit: 'x', joints: ['near.hip'] }),
      C('stack', 'Shoulders over wrists', (c) => c.dx('near.shoulder', 'near.wrist') / c.torso, [0, 0.25], 'Stack your shoulders over your wrists', { slack: 0.15, unit: 'x', joints: ['near.shoulder', 'near.wrist'] }),
      C('arms', 'Arms straight', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [160, 180], 'Press the floor away, straighten your arms', { slack: 10, joints: ['near.elbow'] }),
      C('legs', 'Legs straight', (c) => c.angle('near.hip', 'near.knee', 'near.ankle'), [160, 180], 'Straighten your legs', { slack: 10, joints: ['near.knee'] }),
    ],
  },
  {
    id: 'chaturanga', name: 'Chaturanga', sanskrit: 'Chaturanga Dandasana', camera: 'side', family: 'floor',
    hint: 'Side-on, tablet on the floor.',
    ref: ref(pt(68, 140),
      { shoulder: pt(92, 150), elbow: pt(64, 162), wrist: pt(72, 190), hip: pt(132, 150), knee: pt(162, 152), ankle: pt(190, 154), heel: pt(198, 150), foot: pt(196, 164) },
      { shoulder: pt(98, 150), elbow: pt(70, 162), wrist: pt(78, 190), hip: pt(138, 150), knee: pt(168, 152), ankle: pt(196, 154), heel: pt(204, 150), foot: pt(202, 164) }),
    gates: [G.tilt([-12, 12]), G.reach([0.75, 1.3])],
    checks: [
      C('elbows', 'Elbow bend', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [70, 110], 'Bend your elbows to about ninety degrees', { slack: 15, joints: ['near.elbow'] }),
      C('line', 'Body line', (c) => c.below('near.hip', 'near.shoulder', 'near.ankle'), [-0.12, 0.12], sagOrPike, { slack: 0.08, unit: 'x', joints: ['near.hip'] }),
      C('shoulders', 'Shoulders above elbows', (c) => c.dy('near.shoulder', 'near.elbow') / c.torso, [-3, 0.05], 'Keep your shoulders level with your elbows, no lower', { slack: 0.1, unit: 'x', joints: ['near.shoulder'] }),
    ],
  },
  {
    id: 'updog', name: 'Upward Dog', sanskrit: 'Urdhva Mukha Svanasana', camera: 'side', family: 'floor',
    hint: 'Side-on, tablet on the floor.',
    ref: ref(pt(104, 70),
      { shoulder: pt(94, 96), elbow: pt(90, 140), wrist: pt(86, 184), hip: pt(138, 160), knee: pt(166, 176), ankle: pt(192, 188), heel: pt(198, 184), foot: pt(196, 196) },
      { shoulder: pt(100, 96), elbow: pt(96, 140), wrist: pt(92, 184), hip: pt(144, 160), knee: pt(172, 176), ankle: pt(198, 188), heel: pt(204, 184), foot: pt(202, 196) }),
    gates: [G.tilt([44, 66], 4), G.reach([0.05, 0.62], 0.2)],
    checks: [
      C('arms', 'Arms straight', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [160, 180], 'Straighten your arms', { slack: 10, joints: ['near.elbow'] }),
      C('thighs', 'Thighs off the mat', (c) => c.dy('near.knee', 'near.hip') / c.torso, [0.05, 3], 'Lift your thighs off the mat', { slack: 0.05, unit: 'x', joints: ['near.hip', 'near.knee'] }),
      C('chest', 'Chest open', (c) => c.vert('mid.hip', 'mid.shoulder'), [0, 40], 'Open your chest, lift through the sternum', { slack: 12, joints: ['near.shoulder'] }),
      C('stack', 'Shoulders over wrists', (c) => c.dx('near.shoulder', 'near.wrist') / c.torso, [0, 0.3], 'Roll your shoulders back over your wrists', { slack: 0.15, unit: 'x', joints: ['near.shoulder', 'near.wrist'] }),
    ],
  },
  {
    id: 'cobra', name: 'Cobra', sanskrit: 'Bhujangasana', camera: 'side', family: 'floor',
    hint: 'Side-on, tablet on the floor.',
    ref: ref(pt(102, 96),
      { shoulder: pt(96, 124), elbow: pt(92, 158), wrist: pt(104, 184), hip: pt(140, 176), knee: pt(168, 178), ankle: pt(190, 180), heel: pt(198, 176), foot: pt(196, 190) },
      { shoulder: pt(102, 124), elbow: pt(98, 158), wrist: pt(110, 184), hip: pt(146, 176), knee: pt(174, 178), ankle: pt(196, 180), heel: pt(204, 176), foot: pt(202, 190) }),
    gates: [G.tilt([40, 60]), G.reach([-0.1, 0.4], 0.2)],
    checks: [
      C('elbows', 'Soft elbows', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [90, 155], (v) => (v > 155 ? 'Keep a soft bend in your elbows' : 'Press up a little more'), { slack: 15, joints: ['near.elbow'] }),
      C('hips', 'Hips on the mat', (c) => c.dy('near.knee', 'near.hip') / c.torso, [-0.1, 0.08], 'Keep your hips and thighs down on the mat', { slack: 0.06, unit: 'x', joints: ['near.hip'] }),
      C('chest', 'Chest lift', (c) => c.horiz('mid.hip', 'mid.shoulder'), [15, 55], (v) => (v < 15 ? 'Lift your chest higher' : 'Ease down a little, lead with the chest not the neck'), { slack: 10, joints: ['near.shoulder'] }),
    ],
  },
  {
    id: 'downdog', name: 'Downward Dog', sanskrit: 'Adho Mukha Svanasana', camera: 'side', family: 'floor',
    hint: 'Side-on, tablet on the floor.',
    ref: ref(pt(58, 132),
      { shoulder: pt(70, 110), elbow: pt(57, 144), wrist: pt(44, 178), hip: pt(120, 40), knee: pt(154, 116), ankle: pt(184, 182), heel: pt(192, 186), foot: pt(186, 196) },
      { shoulder: pt(76, 110), elbow: pt(63, 144), wrist: pt(50, 178), hip: pt(126, 40), knee: pt(160, 116), ankle: pt(190, 182), heel: pt(198, 186), foot: pt(192, 196) }),
    gates: [G.tilt([-66, -44]), G.reach([1.3, 2.0], 0.3), G.spread([0.5, 1.1])],
    checks: [
      C('hips', 'Hips high', (c) => c.angle('near.shoulder', 'near.hip', 'near.knee'), [55, 95], (v) => (v > 95 ? 'Push your hips up and back' : 'Walk your hands forward a touch'), { slack: 15, joints: ['near.hip'] }),
      C('legs', 'Legs straight', (c) => c.angle('near.hip', 'near.knee', 'near.ankle'), [160, 180], 'Straighten your legs, heels reach for the floor', { slack: 12, joints: ['near.knee'] }),
      C('arms', 'Arms straight', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [160, 180], 'Straighten your arms', { slack: 10, joints: ['near.elbow'] }),
      C('spine', 'Long spine', (c) => c.angle('near.wrist', 'near.shoulder', 'near.hip'), [160, 180], 'Lengthen your spine, press the floor away', { slack: 12, joints: ['near.shoulder'] }),
    ],
  },
  {
    id: 'catcow', name: 'Cat–Cow', sanskrit: 'Marjaryasana–Bitilasana', camera: 'side', family: 'floor', reps: true,
    hint: 'Side-on, on all fours. Move slowly with your breath.',
    ref: ref(pt(62, 98),
      { shoulder: pt(84, 116), elbow: pt(82, 150), wrist: pt(80, 182), hip: pt(142, 116), knee: pt(144, 182), ankle: pt(176, 186), heel: pt(184, 188), foot: pt(190, 180) },
      { shoulder: pt(90, 116), elbow: pt(88, 150), wrist: pt(86, 182), hip: pt(148, 116), knee: pt(150, 182), ankle: pt(182, 186), heel: pt(190, 188), foot: pt(196, 180) }),
    phase: (c) => { const v = c.dy('near.shoulder', 'nose') / c.torso; return v > 0.15 ? 'Cow' : v < -0.1 ? 'Cat' : 'Neutral'; },
    gates: [G.tilt([-12, 12]), G.reach([0.9, 1.45])],
    checks: [
      C('stackS', 'Shoulders over wrists', (c) => c.dx('near.shoulder', 'near.wrist') / c.torso, [0, 0.25], 'Stack your shoulders over your wrists', { slack: 0.15, unit: 'x', joints: ['near.shoulder', 'near.wrist'] }),
      C('stackH', 'Hips over knees', (c) => c.dx('near.hip', 'near.knee') / c.torso, [0, 0.25], 'Stack your hips over your knees', { slack: 0.15, unit: 'x', joints: ['near.hip', 'near.knee'] }),
      C('arms', 'Arms straight', (c) => c.angle('near.shoulder', 'near.elbow', 'near.wrist'), [160, 180], 'Straighten your arms', { slack: 10, joints: ['near.elbow'] }),
    ],
  },
];

export const POSE_BY_ID = Object.fromEntries(POSES.map((p) => [p.id, p]));

export const SEQUENCES = [
  {
    id: 'sunA', name: 'Sun Salutation A', camera: 'side',
    hint: 'Side-on, tablet on the floor. Flow at your own pace.',
    steps: ['mountain', 'forwardfold', 'plank', 'chaturanga', 'updog', 'downdog', 'forwardfold', 'mountain'],
  },
  {
    id: 'floor', name: 'Floor Set', camera: 'side',
    hint: 'Side-on, tablet on the floor. Cobra, dog, plank.',
    steps: ['catcow', 'cobra', 'downdog', 'plank', 'downdog'],
  },
];

/** Expand a compact reference into a 33-point landmark array. */
export function refLandmarks(pose) {
  const { nose, L, R, sideOn } = pose.ref;
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.15 }));
  lm[0] = { ...nose, z: 0, visibility: 1 };
  for (const part of PARTS) {
    if (L[part]) lm[SIDE.L[part]] = { ...L[part], z: 0, visibility: 1 };
    if (R[part]) lm[SIDE.R[part]] = { ...R[part], z: 0, visibility: sideOn ? 0.55 : 1 };
  }
  return lm;
}

// ---------- evaluation ----------
export function statusOf(range, slack, v) {
  const [lo, hi] = range;
  if (v >= lo && v <= hi) return 'good';
  if (v >= lo - slack && v <= hi + slack) return 'close';
  return 'off';
}
/** How far outside the good range, in slack-units. 0 when inside. Used to rank cues. */
export function severity(range, slack, v) {
  const [lo, hi] = range;
  if (v >= lo && v <= hi) return 0;
  return (v < lo ? lo - v : v - hi) / (slack || 1);
}

const MIN_JOINT_VIS = 0.5;

/**
 * Evaluate one pose against pixel-space landmarks.
 * `tuning` optionally overrides ranges per check id: { [checkId]: [lo, hi] }.
 */
export function evaluate(pose, lm, tuning = null) {
  const c = makeContext(lm);
  const run = (ch) => {
    c.beginTouch();
    const value = ch.measure(c);
    const vis = c.touchedVis();
    const range = tuning?.[ch.id] ?? ch.range;
    const status = vis < MIN_JOINT_VIS ? 'unknown' : statusOf(range, ch.slack, value);
    const cue = typeof ch.cue === 'function' ? ch.cue(value) : ch.cue;
    return {
      id: ch.id, label: ch.label, value, unit: ch.unit, status, cue, range, slack: ch.slack,
      isGate: !!ch.isGate,
      joints: (ch.joints || []).map((n) => c.idxOf(n)).filter((i) => i != null),
      severity: status === 'unknown' ? 0 : severity(range, ch.slack, value),
      tuned: !!tuning?.[ch.id],
    };
  };
  const gates = (pose.gates || []).map(run);
  const checks = pose.checks.map(run);

  const scoreOf = (list) => {
    const known = list.filter((k) => k.status !== 'unknown');
    return known.length
      ? known.reduce((t, k) => t + (k.status === 'good' ? 1 : k.status === 'close' ? 0.5 : 0), 0) / known.length
      : 0;
  };
  const all = [...gates, ...checks];
  const known = all.filter((k) => k.status !== 'unknown');
  // Gates are how the flow decides which pose you are in, so they count toward score.
  const score = scoreOf(all);
  // inPose = the shape is recognisable; only then is refinement coaching meaningful.
  const inPose = gates.every((g) => g.status !== 'off');

  return {
    gates, checks, score, formScore: scoreOf(checks), inPose,
    known: known.length, total: all.length,
    visible: c.bodyVisible(),
    phase: pose.phase ? pose.phase(c) : null,
    side: pose.asymmetric ? (c.roles.front === 'L' ? 'Left' : 'Right') : null,
    torso: c.torso,
    hip: { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 },
  };
}

export function fmtValue(v, unit) {
  return unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
}
export function fmtRange(range, unit) {
  return `${fmtValue(range[0], unit)}–${fmtValue(range[1], unit)}`;
}
