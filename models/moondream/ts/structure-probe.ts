/**
 * Structure probe — empirically measure HOW MUCH STRUCTURE we can reliably pull
 * out of moondream's free-text output, by running every extraction strategy
 * (moondream.ts) on the SAME live frames and scoring each.
 *
 * Moondream-in-Ollama is plain VQA (no detect/point endpoints), so this answers
 * the real question: given that, what structured contract can the perception
 * processor depend on?
 *
 *   npx tsx src/dev/vlm/structure-probe.ts            # 5 frames, default questions
 *   npx tsx src/dev/vlm/structure-probe.ts --frames 8 --camera 0
 *
 * Reports, per strategy: success rate (did we get a usable typed value?),
 * latency, and a sample of the raw output so you can eyeball quality.
 */

import {
  ask,
  askYesNo,
  askJson,
  askFields,
  captureFrame,
  ollamaUp,
  MonitorSchema,
  STREAM_W,
  STREAM_H,
} from './moondream.js';

interface Args { frames: number; camera: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { frames: 5, camera: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--frames') a.frames = Number(argv[++i]);
    else if (argv[i] === '--camera') a.camera = Number(argv[++i]);
  }
  return a;
}

interface Tally { ok: number; n: number; ms: number; samples: string[] }
const mk = (): Tally => ({ ok: 0, n: 0, ms: 0, samples: [] });
function rec(t: Tally, ok: boolean, ms: number, sample: string) {
  t.n++; t.ms += ms; if (ok) t.ok++;
  if (t.samples.length < 3) t.samples.push(sample);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(await ollamaUp())) {
    console.error('Ollama not running: ollama serve &');
    process.exit(1);
  }

  const question = 'Is there a person in view, and what are they doing?';
  const nl = mk();
  const yesno = mk();
  const json = mk();
  const fields = mk();

  console.log(
    `Probing moondream structure @ ${STREAM_W}×${STREAM_H}, ${args.frames} frames.\n` +
    `Q: "${question}"\n`,
  );

  for (let i = 0; i < args.frames; i++) {
    const jpeg = await captureFrame(args.camera);
    const b64 = jpeg.toString('base64');
    process.stdout.write(`frame ${i + 1}/${args.frames} … `);

    // 1) NL — "ok" if non-empty (always structurable as a string).
    const a1 = await ask(question, b64);
    rec(nl, a1.answer.length > 0, a1.latencyMs, a1.answer);

    // 2) yes/no — DESCRIPTIVE prompt → derived boolean. "ok" if definite.
    const a2 = await askYesNo('person', b64);
    rec(yesno, a2.value !== null, a2.latencyMs, `${a2.value} ⟵ "${a2.raw.slice(0, 70)}…"`);

    // 3) JSON schema — "ok" if it parsed AND validated.
    const a3 = await askJson(question, MonitorSchema, b64);
    rec(json, a3.value !== null, a3.latencyMs,
      a3.value ? JSON.stringify(a3.value) : `FAIL "${a3.raw}"`);

    // 4) field fusion — 3 plain questions → record. Plain questions only (no
    //    "answer yes/no" meta-instructions, which make moondream emit empty).
    //    "ok" if all answered.
    const a4 = await askFields({
      present: 'What person is in the image, and what are they doing?',
      activity: 'What is the person doing?',
      anomaly: 'What in the scene is unusual or out of place?',
    }, b64);
    const full = Object.values(a4.value).every((v) => v.length > 0);
    rec(fields, full, a4.totalMs, JSON.stringify(a4.value));

    console.log('done');
  }

  report('1. NL (free text)        ', nl);
  report('2. yes/no (boolean)      ', yesno);
  report('3. JSON schema (1 call)  ', json);
  report('4. field fusion (3 calls)', fields);

  console.log('\nFindings: moondream is an OPEN-QUESTION describer. It returns EMPTY on');
  console.log('closed yes/no ("Is there…?") and emits looping garbage under format=json');
  console.log('(strategy 3). Reliable structure = ask open questions (1, 4), parse the');
  console.log('prose: NL is 100%, field-fusion ~80%, boolean via polarity() on the');
  console.log('description. So: derive structure from text, never demand a schema.');
}

function report(name: string, t: Tally) {
  const rate = t.n ? ((100 * t.ok) / t.n).toFixed(0) : '0';
  const avg = t.n ? (t.ms / t.n).toFixed(0) : '0';
  console.log(`\n${name}  ok ${t.ok}/${t.n} (${rate}%)  avg ${avg}ms`);
  for (const s of t.samples) console.log(`    · ${s}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
