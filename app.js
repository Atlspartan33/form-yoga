// app.js — camera, MediaPipe loop, coaching, UI. All geometry lives in poses.js.
import { POSES, POSE_BY_ID, SEQUENCES, CONNECTIONS, evaluate, fmtValue, fmtRange } from './poses.js';
import { glyphSVG, fitRef, drawGhost } from './glyph.js';
import * as store from './store.js';
import { demoSource } from './demo.js';

// ?demo drives the session from a synthetic body — no camera, for testing and showing.
const DEMO = new URLSearchParams(location.search).has('demo');
let demoFn = null, demoT0 = 0;

const { settings } = store;
const MP = '0.10.14';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`;
const MODEL_URL = (k) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${k}/float16/1/pose_landmarker_${k}.task`;

const $ = (s) => document.querySelector(s);
const el = new Proxy({}, { get: (c, k) => (c[k] ||= document.getElementById(k)) });

// ---------------------------------------------------------------- voice
const voice = {
  lastAt: 0, lastText: '', ready: false,
  init() { if ('speechSynthesis' in window) { speechSynthesis.getVoices(); this.ready = true; } },
  pick() {
    const vs = speechSynthesis.getVoices();
    return vs.find((v) => /en-US/i.test(v.lang) && /Natural|Google|Zira|Aria/i.test(v.name))
      || vs.find((v) => /^en/i.test(v.lang)) || null;
  },
  say(text, { force = false, minGap = 4200, repeatGap = 9000 } = {}) {
    if (!settings.voice || !('speechSynthesis' in window) || !text) return false;
    const now = performance.now();
    if (!force) {
      if (now - this.lastAt < minGap) return false;
      if (text === this.lastText && now - this.lastAt < repeatGap) return false;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    const v = this.pick(); if (v) u.voice = v;
    speechSynthesis.speak(u);
    this.lastAt = now; this.lastText = text;
    return true;
  },
  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); },
};
voice.init();
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => voice.init();

// ---------------------------------------------------------------- camera + model
let landmarker = null, stream = null, rafId = 0, wakeLock = null, lastVideoTime = -1;

async function loadModel() {
  if (landmarker) return landmarker;
  setStatus('Loading pose model…');
  const { PoseLandmarker, FilesetResolver } = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}`);
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL(settings.model), delegate: 'GPU' },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  return landmarker;
}
async function startCamera() {
  stopCamera();
  if (DEMO) {
    demoFn = demoSource(S.pose); demoT0 = performance.now();
    setStatus('');
    el.stage.classList.remove('mirror');
    return;
  }
  setStatus('Starting camera…');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: settings.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  el.cam.srcObject = stream;
  await el.cam.play();
  el.stage.classList.toggle('mirror', settings.facing === 'user');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function stopCamera() {
  if (DEMO) clearTimeout(rafId); else cancelAnimationFrame(rafId);
  rafId = 0; lastVideoTime = -1;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  el.cam.srcObject = null;
  try { wakeLock?.release(); } catch {} wakeLock = null;
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && stream && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// ---------------------------------------------------------------- smoothing
const SMOOTH = 0.35;
let smooth = null;
function smoothed(raw, w, h) {
  const px = raw.map((p) => ({ x: p.x * w, y: p.y * h, z: p.z, visibility: p.visibility ?? 1 }));
  if (!smooth) { smooth = px; return px; }
  smooth = px.map((p, i) => ({
    x: smooth[i].x + SMOOTH * (p.x - smooth[i].x),
    y: smooth[i].y + SMOOTH * (p.y - smooth[i].y),
    z: p.z, visibility: p.visibility,
  }));
  return smooth;
}

// ---------------------------------------------------------------- session state
const HYST = 6, ENTER_FRAMES = 12, CALIBRATE_MS = 8000;
const S = {
  mode: 'pose',           // 'pose' | 'flow' | 'calibrate'
  pose: null, seq: null, stepIdx: 0,
  phase: 'idle',          // 'setup' | 'countdown' | 'hold' | 'done'
  inFrames: 0, nextFrames: 0, lostFrames: 0,
  holdStart: 0, holdMs: 0, countFrom: 0,
  chk: {}, flowLog: [], samples: {}, reps: 0, lastPhase: null, side: null,
  ev: null, lm: null,
};

function resetChecks(pose) {
  S.chk = {};
  for (const c of pose.checks) S.chk[c.id] = { shown: 'good', cand: 'good', n: 0, offSince: 0, good: 0, close: 0, off: 0, sum: 0, cnt: 0 };
  S.samples = {};
  for (const c of pose.checks) S.samples[c.id] = [];
}
const tuning = () => store.tuningFor(S.pose.id);

// ---------------------------------------------------------------- start
async function startPose(id, mode = 'pose') {
  S.mode = mode; S.pose = POSE_BY_ID[id]; S.seq = null; S.reps = 0; S.lastPhase = null;
  const title = mode === 'calibrate' ? `Calibrate · ${S.pose.name}` : S.pose.name;
  const sub = mode === 'calibrate' ? 'Hold your best version' : S.pose.sanskrit;
  await begin(title, sub, mode === 'calibrate'
    ? 'Get into your best version of this pose and hold still.'
    : S.pose.hint);
}
async function startFlow(id) {
  S.mode = 'flow'; S.seq = SEQUENCES.find((s) => s.id === id); S.stepIdx = 0; S.flowLog = [];
  S.pose = POSE_BY_ID[S.seq.steps[0]];
  await begin(S.seq.name, `Step 1 · ${S.pose.name}`, S.seq.hint);
}
async function begin(title, sub, hint) {
  show('session');
  el.poseName.textContent = title;
  el.poseSub.textContent = sub;
  el.sideChip.hidden = true; el.phaseChip.hidden = true; el.repChip.hidden = true;
  el.calibBar.hidden = S.mode !== 'calibrate';
  el.btnGhost.classList.toggle('on', settings.ghost);
  S.phase = 'setup'; S.inFrames = 0; S.nextFrames = 0; S.lostFrames = 0; S.holdMs = 0;
  smooth = null; voice.lastAt = 0; voice.lastText = '';
  resetChecks(S.pose);
  renderChecks(null); renderTimer(0); renderFlow(); renderScore(0);
  setState('Get in position'); cue(hint, '');
  try {
    await (DEMO ? startCamera() : Promise.all([loadModel(), startCamera()]));
    setStatus('');
    voice.say(S.mode === 'flow' ? `${title}. Start in ${S.pose.name}.` : `${title}. ${hint}`, { force: true });
    loop();
  } catch (e) {
    console.error(e);
    setStatus(e.name === 'NotAllowedError'
      ? 'Camera blocked. Allow camera access for this page, then tap here to retry.'
      : `Could not start: ${e.message}. Tap to retry.`, true);
  }
}
function endSession() { stopCamera(); voice.stop(); S.phase = 'idle'; }

// ---------------------------------------------------------------- loop
function loop() {
  // Demo mode runs off a timer so it keeps ticking in a hidden tab (rAF does not).
  rafId = DEMO ? setTimeout(loop, 33) : requestAnimationFrame(loop);
  const v = el.cam;
  let raw, w, h;

  if (DEMO) {
    const r = el.stage.getBoundingClientRect();
    w = Math.round(r.width) || 640; h = Math.round(r.height) || 480;
    if (el.overlay.width !== w) { el.overlay.width = w; el.overlay.height = h; }
    raw = demoFn((performance.now() - demoT0) / 1000, w, h);
  } else {
    if (!landmarker || v.readyState < 2 || v.currentTime === lastVideoTime) return;
    lastVideoTime = v.currentTime;
    w = v.videoWidth; h = v.videoHeight;
    if (el.overlay.width !== w) { el.overlay.width = w; el.overlay.height = h; }
    let res;
    try { res = landmarker.detectForVideo(v, performance.now()); } catch { return; }
    if (!res.landmarks?.length) {
      smooth = null;
      el.overlay.getContext('2d').clearRect(0, 0, w, h);
      onLost('Step into frame');
      return;
    }
    raw = res.landmarks[0];
  }

  const ctx = el.overlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const lm = smoothed(raw, w, h);
  const ev = evaluate(S.pose, lm, tuning());
  S.ev = ev; S.lm = lm;

  if (settings.ghost && S.phase !== 'done') {
    try { drawGhost(ctx, fitRef(S.pose, ev, lm), Math.max(1, w / 900)); } catch {}
  }
  drawSkeleton(ctx, lm, ev, Math.max(1, w / 640));

  if (ev.visible < 0.5) { onLost('Step back — I need your whole body'); return; }
  S.lostFrames = 0;

  if (S.mode === 'flow') tickFlow(ev);
  else if (S.mode === 'calibrate') tickCalibrate(ev);
  else tickPose(ev);
}
function onLost(msg) {
  S.lostFrames++;
  if (S.lostFrames > 45) { setState(msg); if (S.phase === 'hold') cue(msg, 'off'); }
}

// ---------------------------------------------------------------- pose mode
function tickPose(ev) {
  if (S.phase === 'setup') {
    renderChecks(ev); renderScore(ev.score);
    const ready = ev.inPose && ev.score >= 0.7;
    S.inFrames = ready ? S.inFrames + 1 : 0;
    setState(ev.inPose ? (ready ? 'Almost…' : 'Adjust') : 'Get in position');
    if (!ev.inPose) cue(S.pose.hint, '');
    if (S.inFrames >= ENTER_FRAMES) enterHold();
    return;
  }
  if (S.phase === 'countdown') {
    renderChecks(ev); renderScore(ev.score);
    const left = 3 - Math.floor((performance.now() - S.countFrom) / 1000);
    el.timer.textContent = Math.max(1, left);
    el.ring.style.setProperty('--p', 0);
    if (left <= 0) startHold();
    return;
  }
  if (S.phase !== 'hold') return;

  S.holdMs = performance.now() - S.holdStart;
  accumulate(ev);
  renderChecks(ev); renderScore(ev.score); renderTimer(S.holdMs);
  trackPhaseAndReps(ev);
  if (ev.side && !S.side) { S.side = ev.side; el.sideChip.hidden = false; el.sideChip.textContent = `${ev.side} side`; }
  coach(ev);
  if (S.holdMs >= settings.hold * 1000) finishPose();
}
function enterHold() {
  if (settings.countdown) {
    S.phase = 'countdown'; S.countFrom = performance.now();
    setState('Hold in'); voice.say('In position. Three. Two. One.', { force: true });
  } else startHold();
}
function startHold() {
  S.phase = 'hold'; S.holdStart = performance.now(); S.side = null;
  resetChecks(S.pose);
  setState('Holding'); cue('Hold it there', 'good');
  if (!settings.countdown) voice.say('In position. Hold.', { force: true });
}

function accumulate(ev) {
  const now = performance.now();
  for (const c of ev.checks) {
    const st = S.chk[c.id];
    if (c.status === 'unknown') continue;
    st[c.status]++; st.sum += c.value; st.cnt++;
    S.samples[c.id].push(c.value);
    if (c.status === st.cand) st.n++; else { st.cand = c.status; st.n = 1; }
    if (st.n >= HYST && st.shown !== st.cand) {
      st.shown = st.cand;
      st.offSince = st.shown === 'off' ? now : 0;
    }
  }
}
function trackPhaseAndReps(ev) {
  if (!ev.phase) return;
  el.phaseChip.hidden = false; el.phaseChip.textContent = ev.phase;
  if (S.pose.reps) {
    if (ev.phase === 'Cow' && S.lastPhase === 'Cat') {
      S.reps++;
      el.repChip.hidden = false; el.repChip.textContent = `${S.reps} rep${S.reps === 1 ? '' : 's'}`;
    }
    if (ev.phase !== 'Neutral') S.lastPhase = ev.phase;
  }
}

/** One cue at a time: the worst thing that has been visibly wrong for over a beat. */
function coach(ev) {
  const now = performance.now();
  if (!ev.inPose) { cue(S.pose.hint, 'off'); voice.say(S.pose.hint, { minGap: 6000 }); return; }
  const off = ev.checks
    .filter((c) => S.chk[c.id]?.shown === 'off' && now - S.chk[c.id].offSince > 1200)
    .sort((a, b) => b.severity - a.severity);
  if (off.length) { if (voice.say(off[0].cue)) cue(off[0].cue, 'off'); else cue(off[0].cue, 'off'); return; }
  const allGood = ev.checks.every((c) => S.chk[c.id]?.shown !== 'off');
  if (allGood && now - voice.lastAt > 8000) {
    if (voice.say('Good. Hold it there.', { minGap: 8000 })) cue('Good — hold it there', 'good');
  }
}

// ---------------------------------------------------------------- calibrate mode
function tickCalibrate(ev) {
  renderChecks(ev); renderScore(ev.score);
  if (S.phase === 'setup') {
    S.inFrames = ev.inPose ? S.inFrames + 1 : 0;
    setState(ev.inPose ? 'Hold still…' : 'Get in position');
    if (S.inFrames >= ENTER_FRAMES) {
      S.phase = 'hold'; S.holdStart = performance.now(); resetChecks(S.pose);
      voice.say('Hold your best version. Recording.', { force: true });
    }
    return;
  }
  if (S.phase !== 'hold') return;
  S.holdMs = performance.now() - S.holdStart;
  accumulate(ev);
  const p = Math.min(1, S.holdMs / CALIBRATE_MS);
  el.ring.style.setProperty('--p', p);
  el.timer.textContent = Math.max(0, Math.ceil((CALIBRATE_MS - S.holdMs) / 1000));
  cue('Hold still — measuring your range', '');
  if (S.holdMs >= CALIBRATE_MS) finishCalibrate();
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function finishCalibrate() {
  S.phase = 'done'; stopCamera(); voice.stop();
  const proposals = [];
  for (const c of S.pose.checks) {
    const vals = S.samples[c.id];
    if (vals.length < 15) continue;
    const m = median(vals);
    const [lo, hi] = (tuning()?.[c.id]) ?? c.range;
    const margin = c.unit === '°' ? 3 : 0.03;
    // Widen only — calibration should never make the checker stricter than shipped.
    const next = [Math.min(lo, m - margin), Math.max(hi, m + margin)];
    const changed = next[0] !== lo || next[1] !== hi;
    proposals.push({ id: c.id, label: c.label, unit: c.unit, median: m, from: [lo, hi], to: next, changed });
  }
  const changed = proposals.filter((p) => p.changed);
  el.sumTitle.textContent = `Calibrate · ${S.pose.name}`;
  el.sumLead.textContent = changed.length
    ? `Your hold sits outside the shipped target on ${changed.length} check${changed.length === 1 ? '' : 's'}. Widening those to include your range — the rest stay as they are.`
    : 'Your hold matched every shipped target. Nothing to change.';
  el.sumBody.innerHTML = proposals.map((p) => `
    <div class="row">
      <div class="lbl">${p.label}<span class="sub">you measured ${fmtValue(p.median, p.unit)}</span></div>
      <div class="pct ${p.changed ? 'warn' : 'ok'}">${p.changed ? `${fmtRange(p.from, p.unit)} → ${fmtRange(p.to, p.unit)}` : 'in range'}</div>
    </div>`).join('');
  el.sumActions.innerHTML = changed.length
    ? `<button class="btn primary" id="btnSaveCal">Save calibration</button><button class="btn" id="btnSkipCal">Discard</button>`
    : `<button class="btn primary" id="btnSkipCal">Back</button>`;
  $('#btnSaveCal')?.addEventListener('click', () => {
    store.saveTuning(S.pose.id, Object.fromEntries(changed.map((p) => [p.id, p.to])));
    voice.say('Calibration saved.', { force: true });
    renderHome(); show('home');
  });
  $('#btnSkipCal')?.addEventListener('click', () => { renderHome(); show('home'); });
  show('summary');
}

// ---------------------------------------------------------------- flow mode
function tickFlow(ev) {
  const now = performance.now();
  if (S.phase === 'setup') {
    renderChecks(ev); renderScore(ev.score);
    const ready = ev.inPose && ev.score >= 0.7;
    S.inFrames = ready ? S.inFrames + 1 : 0;
    setState(ready ? 'Almost…' : `Start in ${S.pose.name}`);
    if (S.inFrames >= 10) { S.phase = 'hold'; S.holdStart = now; enterStep(now); }
    return;
  }
  if (S.phase !== 'hold') return;
  S.holdMs = now - S.holdStart;
  renderTimer(S.holdMs, false); renderChecks(ev); renderScore(ev.score);
  accumulate(ev); coach(ev);
  const cur = S.flowLog.at(-1);
  cur.bestScore = Math.max(cur.bestScore, ev.score);

  const nextIdx = S.stepIdx + 1;
  if (nextIdx >= S.seq.steps.length) {
    if (ev.score >= 0.7 && now - cur.enteredAt > 1500) finishFlow();
    return;
  }
  const nextPose = POSE_BY_ID[S.seq.steps[nextIdx]];
  const nextEv = evaluate(nextPose, S.lm, store.tuningFor(nextPose.id));
  S.nextFrames = (nextEv.inPose && nextEv.score >= 0.7 && nextEv.score > ev.score) ? S.nextFrames + 1 : 0;
  if (S.nextFrames >= 8 && now - cur.enteredAt > 800) {
    S.stepIdx = nextIdx; S.pose = nextPose; S.nextFrames = 0;
    if (DEMO) { demoFn = demoSource(S.pose); demoT0 = performance.now(); }
    resetChecks(S.pose); enterStep(now);
  }
}
function enterStep(now) {
  S.flowLog.push({ id: S.pose.id, name: S.pose.name, bestScore: 0, enteredAt: now });
  el.poseSub.textContent = `Step ${S.stepIdx + 1} of ${S.seq.steps.length} · ${S.pose.name}`;
  setState(S.pose.name); renderFlow(); cue(S.pose.name, '');
  voice.say(S.pose.name, { force: true });
}

// ---------------------------------------------------------------- finish
function pct(x) { return `${Math.round(x * 100)}%`; }

function finishPose() {
  S.phase = 'done'; stopCamera(); voice.stop();
  const secs = Math.round(S.holdMs / 1000);
  const rows = S.pose.checks.map((c) => {
    const st = S.chk[c.id], n = st.cnt || 1;
    return {
      id: c.id, label: c.label, good: st.good / n, close: st.close / n, off: st.off / n,
      avg: st.sum / n, unit: c.unit, range: (tuning()?.[c.id]) ?? c.range, seen: st.cnt,
    };
  }).filter((r) => r.seen > 0).sort((a, b) => b.good - a.good);

  const overall = rows.length ? rows.reduce((t, r) => t + r.good + r.close * 0.5, 0) / rows.length : 0;
  store.addEntry({
    poseId: S.pose.id, name: S.pose.name, secs, score: overall, side: S.side,
    reps: S.pose.reps ? S.reps : null,
    checks: Object.fromEntries(rows.map((r) => [r.id, +r.good.toFixed(2)])),
  });

  const best = rows[0], worst = rows.at(-1);
  let text = `${S.pose.name}${S.side ? `, ${S.side} side` : ''}, ${secs} seconds. `;
  if (!rows.length) text += 'I could not see enough of you to score that one.';
  else if (worst.good >= 0.85) text += 'Solid hold. Everything stayed in range.';
  else {
    text += `${best.label} held well at ${pct(best.good)}. `;
    text += `${worst.label} needs the work — in range only ${pct(worst.good)} of the time.`;
  }
  if (S.pose.reps && S.reps) text += ` ${S.reps} rep${S.reps === 1 ? '' : 's'}.`;

  const stats = store.statsFor(S.pose.id);
  el.sumTitle.textContent = `${S.pose.name} · ${secs}s`;
  el.sumLead.textContent = text;
  el.sumBody.innerHTML = rows.map((r) => `
    <div class="row bars">
      <div class="lbl">${r.label}<span class="sub">avg ${fmtValue(r.avg, r.unit)} · target ${fmtRange(r.range, r.unit)}</span></div>
      <div class="pct">${pct(r.good)}</div>
      <div class="bar"><i class="g" style="width:${r.good * 100}%"></i><i class="c" style="width:${r.close * 100}%"></i><i class="o" style="width:${r.off * 100}%"></i></div>
    </div>`).join('') + (stats?.unbalanced ? `
    <p class="note">You have practised ${S.pose.name} ${stats.sides.Left} times on the left and ${stats.sides.Right} on the right. Even it up.</p>` : '');
  el.sumActions.innerHTML = `
    <button class="btn primary" id="btnAgain">Again</button>
    ${worst && worst.good < 0.6 ? `<button class="btn" id="btnCal">Calibrate</button>` : ''}
    <button class="btn" id="btnHome">Done</button>`;
  wireSummary();
  show('summary');
  setTimeout(() => voice.say(text, { force: true }), 300);
}

function finishFlow() {
  if (S.phase !== 'hold') return;
  S.phase = 'done'; stopCamera(); voice.stop();
  const total = Math.round((performance.now() - S.flowLog[0].enteredAt) / 1000);
  const weakest = [...S.flowLog].sort((a, b) => a.bestScore - b.bestScore)[0];
  const text = `${S.seq.name} complete in ${total} seconds. ${weakest.name} was your weakest shape, at ${pct(weakest.bestScore)}.`;
  store.addEntry({ poseId: S.seq.id, name: S.seq.name, secs: total, score: S.flowLog.reduce((t, s) => t + s.bestScore, 0) / S.flowLog.length, side: null });
  el.sumTitle.textContent = `${S.seq.name} · ${total}s`;
  el.sumLead.textContent = text;
  el.sumBody.innerHTML = S.flowLog.map((s, i) => `
    <div class="row bars">
      <div class="lbl">${i + 1}. ${s.name}</div>
      <div class="pct">${pct(s.bestScore)}</div>
      <div class="bar"><i class="g" style="width:${s.bestScore * 100}%"></i></div>
    </div>`).join('');
  el.sumActions.innerHTML = `<button class="btn primary" id="btnAgain">Again</button><button class="btn" id="btnHome">Done</button>`;
  wireSummary();
  show('summary');
  setTimeout(() => voice.say(text, { force: true }), 300);
}
function wireSummary() {
  $('#btnAgain')?.addEventListener('click', () => (S.mode === 'flow' ? startFlow(S.seq.id) : startPose(S.pose.id)));
  $('#btnHome')?.addEventListener('click', () => { renderHome(); show('home'); });
  $('#btnCal')?.addEventListener('click', () => startPose(S.pose.id, 'calibrate'));
}

// ---------------------------------------------------------------- drawing
function drawSkeleton(ctx, lm, ev, scale) {
  const bad = new Set(), warn = new Set();
  for (const c of ev.checks) {
    const shown = S.phase === 'hold' ? (S.chk[c.id]?.shown ?? c.status) : c.status;
    if (shown === 'off') c.joints.forEach((j) => bad.add(j));
    else if (shown === 'close') c.joints.forEach((j) => warn.add(j));
  }
  ctx.lineWidth = 4 * scale; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 6 * scale;
  for (const [a, b] of CONNECTIONS) {
    if (lm[a].visibility < 0.4 || lm[b].visibility < 0.4) continue;
    ctx.beginPath(); ctx.moveTo(lm[a].x, lm[a].y); ctx.lineTo(lm[b].x, lm[b].y); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < lm.length; i++) {
    if (i > 0 && i < 11) continue;
    if (lm[i].visibility < 0.4) continue;
    const isBad = bad.has(i), isWarn = warn.has(i);
    const r = (isBad ? 10 : isWarn ? 8 : 5) * scale;
    if (isBad) {
      ctx.fillStyle = 'rgba(255,92,92,0.25)';
      ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, r * 2.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = isBad ? '#FF5C5C' : isWarn ? '#FFC53D' : '#C6FF3D';
    ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, r, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------------------------------------------------------------- render
function renderChecks(ev) {
  el.checks.innerHTML = S.pose.checks.map((c) => {
    const r = ev?.checks.find((x) => x.id === c.id);
    const st = !r ? 'idle' : (S.phase === 'hold' && S.chk[c.id] && r.status !== 'unknown' ? S.chk[c.id].shown : r.status);
    const tuned = r?.tuned ? '<span class="tag">tuned</span>' : '';
    const v = !r ? '—' : r.status === 'unknown' ? 'hidden' : fmtValue(r.value, c.unit);
    return `<div class="chk ${st}"><span class="dot"></span><span class="lbl">${c.label}${tuned}</span><span class="val">${v}</span></div>`;
  }).join('');
}
function renderScore(s) {
  el.scoreNum.textContent = Math.round(s * 100);
  el.scoreNum.className = s >= 0.85 ? 'good' : s >= 0.6 ? 'close' : 'off';
}
function renderTimer(ms, countdown = true) {
  const total = settings.hold * 1000;
  el.timer.textContent = countdown ? Math.max(0, Math.ceil((total - ms) / 1000)) : Math.floor(ms / 1000);
  el.ring.style.setProperty('--p', countdown ? Math.min(1, ms / total) : 0);
}
function renderFlow() {
  if (S.mode !== 'flow') { el.flowSteps.hidden = true; return; }
  el.flowSteps.hidden = false;
  el.flowSteps.innerHTML = S.seq.steps.map((id, i) =>
    `<span class="step ${i < S.stepIdx ? 'done' : i === S.stepIdx ? 'now' : ''}"></span>`).join('');
}
function setState(t) { el.stateChip.textContent = t; }
function cue(text, kind) { el.cueBar.textContent = text; el.cueBar.className = `cue ${kind}`; }
function setStatus(t, isError = false) {
  el.statusMsg.textContent = t; el.statusMsg.hidden = !t;
  el.statusMsg.classList.toggle('err', isError);
}
function show(id) {
  for (const k of ['home', 'session', 'summary']) el[k].hidden = k !== id;
  if (id !== 'session') endSession();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- home
function renderHome() {
  const sum = store.summary();
  el.stats.innerHTML = `
    <div class="stat"><b>${sum.streak}</b><span>day streak</span></div>
    <div class="stat"><b>${sum.holdsThisWeek}</b><span>holds this week</span></div>
    <div class="stat"><b>${Math.round(sum.secondsThisWeek / 60)}</b><span>minutes</span></div>`;
  el.stats.hidden = sum.total === 0;

  el.poseGrid.innerHTML = POSES.map((p) => {
    const st = store.statsFor(p.id);
    return `<button class="tile" data-pose="${p.id}">
      <span class="cam ${p.camera}">${p.camera === 'side' ? 'Side-on' : 'Face camera'}</span>
      ${glyphSVG(p)}
      <span class="name">${p.name}</span>
      <span class="sub">${st ? `best ${pct(st.best)} · ${store.relativeTime(st.lastAt)}` : p.sanskrit}</span>
      ${store.isTuned(p.id) ? '<span class="tag abs">tuned</span>' : ''}
    </button>`;
  }).join('');

  el.flowGrid.innerHTML = SEQUENCES.map((s) => `
    <button class="tile flow" data-flow="${s.id}">
      <span class="cam side">Side-on</span>
      <span class="glyphrow">${s.steps.map((id) => glyphSVG(POSE_BY_ID[id], { size: 42, stroke: 9 })).join('')}</span>
      <span class="name">${s.name}</span>
      <span class="sub">${s.steps.length} poses · advances on its own</span>
    </button>`).join('');

  el.optVoice.checked = settings.voice;
  el.optGhost.checked = settings.ghost;
  el.optCountdown.checked = settings.countdown;
  el.optHold.value = settings.hold;
  el.optFacing.value = settings.facing;
  el.optModel.value = settings.model;

  const recent = store.history.slice(0, 8);
  el.historyList.innerHTML = recent.length
    ? recent.map((h) => `<li><span class="hn">${h.name}${h.side ? ` <em>${h.side}</em>` : ''}</span>
        <span class="hs">${pct(h.score)}</span><span class="ht">${store.relativeTime(h.ts)}</span></li>`).join('')
    : '<li class="empty">Nothing yet. Hold a pose and it shows up here.</li>';
}

// ---------------------------------------------------------------- events
el.poseGrid.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pose]'); if (b) startPose(b.dataset.pose);
});
el.flowGrid.addEventListener('click', (e) => {
  const b = e.target.closest('[data-flow]'); if (b) startFlow(b.dataset.flow);
});
el.optVoice.addEventListener('change', () => store.saveSettings({ voice: el.optVoice.checked }));
el.optGhost.addEventListener('change', () => store.saveSettings({ ghost: el.optGhost.checked }));
el.optCountdown.addEventListener('change', () => store.saveSettings({ countdown: el.optCountdown.checked }));
el.optHold.addEventListener('change', () => store.saveSettings({ hold: +el.optHold.value }));
el.optFacing.addEventListener('change', () => store.saveSettings({ facing: el.optFacing.value }));
el.optModel.addEventListener('change', () => {
  store.saveSettings({ model: el.optModel.value });
  try { landmarker?.close(); } catch {}
  landmarker = null;
});
el.btnReset.addEventListener('click', () => {
  if (!confirm('Clear practice history and all calibration on this device?')) return;
  store.clearHistory(); store.clearTuning(); renderHome();
});
el.btnBack.addEventListener('click', () => { renderHome(); show('home'); });
el.btnGhost.addEventListener('click', () => {
  store.saveSettings({ ghost: !settings.ghost });
  el.btnGhost.classList.toggle('on', settings.ghost);
});
el.btnDone.addEventListener('click', () => {
  if (S.phase === 'hold' && S.mode === 'flow') finishFlow();
  else if (S.phase === 'hold' && S.mode === 'calibrate') finishCalibrate();
  else if (S.phase === 'hold') finishPose();
  else { renderHome(); show('home'); }
});
el.statusMsg.addEventListener('click', () => {
  if (S.pose) startPose(S.pose.id, S.mode === 'calibrate' ? 'calibrate' : 'pose');
});

renderHome(); show('home');
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
