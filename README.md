# FORM — live yoga form coach

Point a camera at yourself, hold a pose, get spoken corrections while you're still in it.
Everything runs in the browser on your own device. No account, no server, no video leaves the machine.

**Live:** https://atlspartan33.github.io/form-yoga/

---

## The architecture, and why it's built this way

The obvious approach — stream frames to a multimodal model and ask "how's my form?" — fails on
three axes at once: seconds of latency when you need feedback inside a held pose, cost per frame,
and non-determinism about geometry (ask twice about the same frame, get two different knee angles).

So the work is split by speed:

| Layer | Runs at | What it does |
|---|---|---|
| **Perception** | ~30 fps, on-device | MediaPipe Pose Landmarker → 33 body landmarks |
| **Judgment** | sub-millisecond | Trigonometry against declarative per-pose specs |
| **Smoothing** | every frame | EMA filter + 6-frame hysteresis so verdicts don't chatter |
| **Language** | every few seconds | Throttled voice cues; spoken summary after the hold |

There is deliberately **no LLM at runtime**. The pose specs in `poses.js` are exactly the JSON a
model would author, and the summary is templated. That's the natural v2: have a model write specs
for new poses from a description, and turn the numeric summary into real coaching.

## Gates vs. checks

Each pose spec has two kinds of measurement, and the split matters:

- **Gates** answer *"are you even in this shape?"* — coarse orientation: signed torso angle, where
  the hands sit relative to the hips, how far the feet are from under the hips.
- **Checks** answer *"how good is it?"* — the refinements you actually get coached on.

Gates exist because a spec made only of refinements matches poses it was never meant to. The
confusion matrix in `test.mjs` caught this: standing in **Mountain** scored a perfect 1.00 against
**Upward Dog**'s checks (arms straight ✓, knees below hips ✓, torso open ✓, shoulders over wrists ✓).
Without gates, the Sun Salutation flow would happily advance to the wrong pose. With them, every
pose beats every rival spec by a margin of at least 0.17.

## Reference skeletons

Every pose carries a reference skeleton — the ideal shape, hand-authored in a 200×200 box. It does
three jobs from one source of truth:

1. the SVG diagram on each tile,
2. the ghost target overlaid on your camera feed, scaled to your torso and flipped to your facing,
3. a self-test — **each reference must score 1.0 against its own spec**, so the picture on the tile
   is provably the thing the checker is looking for.

## Sign-aware checks

Absolute values make mirror-image faults invisible, and the two that matter are both
injury patterns:

- **Chair.** Hinging forward 19° and leaning *back* 19° are the same number to an unsigned
  torso angle. Leaning back in Utkatasana loads the low back — the app used to score it as
  perfect form. `leanSigned` resolves the torso against the direction you face, so leaning
  back reads −19° and fails.
- **Warrior II.** A knee splayed outside the ankle and a knee collapsing *inward* toward the
  midline are the same distance. Medial collapse is the classic Warrior II knee injury, and
  the check written to catch it couldn't see it. `kneeTrack` signs the offset along the foot's
  outward axis, so inward reads negative and gets its own cue.

Facing is measured from the head against the **shoulders**, not the hips: with a near-vertical
torso the head sits almost directly above the hips, so that comparison flips on noise.

## Honest timing

Hold time accrues **per frame actually seen**, never from a wall clock. Background the app or
step out of frame and the timer simply stops. Wall-clock timing meant a 30-second hold that you
walked away from for two minutes completed itself and wrote 120 seconds into your history,
scored from the handful of easy frames right after you entered.

## Calibration

Shipped target ranges are hand-authored guesses. If one is wrong for your body, hit **Calibrate**:
hold your best version for 8 seconds, and the app takes the median of each measurement and widens
the range to include it. Three rules keep it honest: it only ever **widens** (calibration can't make
the checker stricter than shipped), it always widens from the **shipped** range rather than from
your last calibration (so repeat sessions on off days can't ratchet a check open until it never
fails), and the result is **capped at 1.5×** the shipped width. There's a per-pose reset back to
shipped values.

## Running it

```bash
python -m http.server 5187 --directory .
```

Then open `http://localhost:5187`. Camera access needs `localhost` or HTTPS.

- `node test.mjs` — 88 assertions: geometry, reference self-validation, the confusion matrix,
  degradation cases, occlusion and malformed-landmark handling, corrupt calibration, the
  sign-aware checks, the flow advance rule, ghost-overlay fit, and `store.js` against an
  injected localStorage. No camera or browser needed.
- `?demo=1` — drives the whole session UI from a synthetic body. No camera. Useful for testing
  and for showing someone how it works.

## Setup that actually matters

Side-on poses want the device on the floor, propped, roughly knee height, 6–8 feet away.
Warrior II and Tree face the camera.

## What it can't do

One camera cannot measure depth. Twists and anything pointed at the lens read poorly, and the app
says `hidden` rather than guessing when a joint it needs isn't visible. These are alignment cues,
not verdicts, and never medical advice.

**Cat–Cow is only half-measured.** MediaPipe gives no mid-spine landmark, so spinal flexion — which
*is* the pose — can't be measured from these 33 points. What the checks actually score is the
tabletop base underneath it: shoulders over wrists, hips over knees, arms straight. The Cat/Cow
phase label and the rep counter track the movement from head height, which works, but nothing is
grading the shape of your spine.

**Depth is still invisible.** The sign-aware checks above fix the two mirror-image faults that
matter most, but they work in the image plane. A fault that happens along the camera axis — a hip
rotating toward or away from the lens — remains unmeasurable from one camera.

**Target ranges are hand-authored.** They're informed guesses, not population data. When one is
wrong for your body, that's a bug in the number, not in you — hit Calibrate.

## Files

| | |
|---|---|
| `poses.js` | Geometry, 11 pose specs, reference skeletons, evaluation. Pure — no DOM. |
| `glyph.js` | Reference → SVG diagram, and the fitted ghost overlay. |
| `store.js` | localStorage: settings, calibration, practice history, streaks. |
| `app.js` | Camera, MediaPipe loop, state machine, coaching, rendering. |
| `demo.js` | Synthetic body for `?demo=1`. |
| `test.mjs` | The test suite and spec self-eval. |
