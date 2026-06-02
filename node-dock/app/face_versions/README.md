# Face renderer iteration log

Each `vN_*/gallery.png` is an `adb screencap` of `FaceGalleryActivity`
showing all 12 face cells (11 expressions + privacy) rendered with
`staticForScreenshot = true` for deterministic comparison.

| Version | Change | Result |
|---|---|---|
| **v0_baseline** | Starting point — pre-iteration. | Eyes read as flat-bottomed squares. Expressions only differ by subtle eye-lid pulls and color. Hard to tell happy/excited/love apart. |
| **v1_round_pupils** | Rewrote `buildEyePath` cubic curves with bezier constant k=0.62. Pupil radius 0.30 → 0.42. Deepened `shapeFor` deltas (happy lid clamp, surprised scale, angry lid pull). | Eyes are dome-shaped; pupils properly present. But eyes still capsule-y at neutral (control point math left bottom flat). |
| **v2_brows** | Added `drawBrow` — a stroke arc above each eye, animated via `ExpressionShape` brow fields (innerY/outerY/tilt/arch/thick). Per-expression brow shapes (sad puppy, angry V, surprised arches, etc.). | Biggest readability gain so far — every emotion is now distinct at a glance thanks to brows. |
| **v3_mouths_wink** | Added `drawMouth` with 6 mouth shapes (smile / frown / O / big-smile / flat / grin-teeth). Per-expression mouth assignment. Replaced broken winked-eye geometry with a proper `^` arc smile. | Mouths reinforce each expression. Wink finally reads as wink. |
| **v4_accents** | Per-emotion overlays: tear (sad), sweat (concerned), `?` (curious), sparkles (excited), hearts (love), anger marks (angry), zZz (sleepy). | Each emotion now has a signature accent — instant readability without text. |
| **v5_round_eyes** | Replaced eye path with proper 4-quadrant ellipse using K=0.5523. Bumped eye radius 0.16 → 0.18. Bigger mouths. Moved love hearts to the sides (avoid clip). | Eyes are now truly round/oval; no longer feel like tombstones. |
| **v6_polish** | Excited mouth: closed blob → open D-shape with pink tongue. Angry mouth: stroke zigzag → trapezoid outline + filled toothy zigzag. Concerned mouth bigger. | Excited reads as open-laugh; angry reads as bared-teeth grin. |
| **v7_catchlight** | Bigger upper catchlight (0.085 → 0.13 radius), shifted up-left to suggest a glossy 3D pupil. Stronger secondary lower-right highlight. | Eyes feel alive — light source consistent across all expressions. |
| **v8_balance** | Happy lid clamp 0.7 → 0.9 (less squinty). Concerned eyeScaleY 0.9 → 1, lidTopCurveInner 0.55 → 0.4 (less squished). | Happy reads as happy not squinting; concerned reads as worried not narrow. |
| **v9_shape_punch** | Aggressively bumped per-expression deltas: surprised gets tiny-pupil-huge-eye "deer in headlights", angry gets pinprick pupils and 0.42 lidClamp (narrow slits), sad gets gazeYBias=0.42 (eyes WAY down) + droopy lid, excited gets pupilScale=1.6, happy gets lidBottomCurve=1.6 + lidClamp=0.55 (kawaii smile-eyes), sleepy lidClamp 0.28 → 0.18. Bigger brow deltas across all expressions. | Every expression now visibly distinct at thumbnail size — surprised reads as shocked, angry as menacing, sad as droopy. The "they all look the same" problem is fixed. |
| **v10_eye_personality** | Curious: more tilt + asymmetry + brow tilt. Concerned: keep eyes OPEN and dilated (was squinted, blending with sad). Wink: open eye gets +15% scale + +20% pupil dilation so the contrast reads as a wink not just one-eye-closed. | Concerned vs Sad now cleanly separated (concerned = alert/anxious, sad = droopy). Wink reads as playful. |
| **v11_sparkle_pupils** | Excited now gets a 4-point sparkle drawn over each pupil (drawSparkle overlay). | Excited finally feels different from Happy at a glance — sparkly pupils sell the buzz. |
| **v12_red_angry** | Angry pupil color overridden to deep crimson (0.35,0,0) instead of standard ink. | Angry reads as intense + dangerous immediately; doesn't depend solely on brow shape. |
| **v13_crescent_happy** | Raised lidBottomCurve clamp 1.2 → 1.8 to let happy's smile-arc actually reach the top of the eye (full ^^ crescent). | Subtle but noticeable improvement in the gallery; bigger effect on the full-screen live face. |
| **v14_unified_tween** | Replaced ~15 independent `animateFloatAsState` calls (one per shape field, each on its own 240–320 ms clock) with a single `Animatable(0..1)` progress that lerps between a remembered `prevShape` and the current `targetShape`. Discrete fields (mouthKind, accent) snap at t=0.5. | Transitions used to look like "fifteen things sliding independently". Now the whole face morphs together in a single coordinated 280 ms tween — calm, readable, much less twitchy. |

## Settled on v14.

Static expression set unchanged from v13 (every cell is still distinct
and fun). What v14 fixes is the **between-state** experience: the face
morphs as one shape, not as fifteen overlapping tweens.

## Reproducing

```bash
cd app
./gradlew :app:installDebug -q
./scripts/capture-faces.sh <version-name>
# Saves face_versions/<version-name>/gallery.png
```

Or launch the gallery activity directly:
```
adb shell am start -n dev.orbit.dock/.FaceGalleryActivity
```
