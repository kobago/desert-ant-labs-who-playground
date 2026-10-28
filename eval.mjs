// Live speaker labels three ways, scored against whole-file labels from `da who --json`:
//   full     re-diarize the whole recording every second (slows down as it grows; past 5 min, numbers drift)
//   window40 diarize only the last 40s (fast, numbers shift)
//   tracked  speakers.mjs: each speaker's clip in front of the recent audio
// usage: ffmpeg -i talk.mp3 -ac 1 -ar 16000 talk.wav && da who talk.wav --json > ref.json
//        node eval.mjs talk.wav ref.json <start s> <length s> [full|window40|tracked ...]
import { readFileSync } from "node:fs";
import { Who } from "@desert-ant-labs/who/native";
import { speakerTracker } from "./speakers.mjs";

const RATE = 16000;
const [wav, refPath, off, len, ...methods] = process.argv.slice(2);
const OFF = +off, LEN = +len, ref = JSON.parse(readFileSync(refPath));
const b = readFileSync(wav);
const data = b.indexOf("data") + 8; // 16-bit PCM WAV
const pcm = Float32Array.from(new Int16Array(b.buffer, b.byteOffset + data, (b.length - data) / 2 | 0), (v) => v / 32768);
const who = await Who.load();

// --- the baselines; `tracked` (bottom) is speakers.mjs. Each returns turns {label, start, end} in recording time.
const full = async (audio) => (await who.diarize(audio)).turns.map((t) => ({ label: `L${t.speaker}`, start: t.start, end: t.end }));

const window40 = async (audio) => {
  const from = Math.max(0, audio.length - 40 * RATE), shift = from / RATE;
  return (await who.diarize(audio.subarray(from))).turns.map((t) => ({ label: `L${t.speaker}`, start: t.start + shift, end: t.end + shift }));
};

// --- simulate the mic: 1s at a time; the second that ended 1s ago gets its live label
async function run(name, track) {
  const hyp = Array.from({ length: LEN * 100 }, () => new Set());
  const ms = [];
  for (let i = 2; i <= LEN; i++) {
    const t = performance.now();
    const turns = await track(pcm.subarray(OFF * RATE, (OFF + i) * RATE));
    ms.push(performance.now() - t);
    for (const u of turns) for (let f = Math.max(u.start, i - 2) * 100 | 0; f < Math.min(u.end, i - 1) * 100; f++) hyp[f].add(u.label ?? "?");
  }
  // Score with one fixed mapping per label (its majority reference speaker), so renumbering counts as an error.
  const refAt = (f) => ref.turns.filter((t) => t.start <= OFF + f / 100 && OFF + f / 100 < t.end).map((t) => t.speaker);
  const votes = {};
  for (let f = 0; f < hyp.length; f++) for (const h of hyp[f]) for (const s of refAt(f)) (votes[h] ??= {})[s] = (votes[h][s] || 0) + 1;
  const map = Object.fromEntries(Object.entries(votes).map(([h, v]) => [h, +Object.entries(v).sort((p, q) => q[1] - p[1])[0][0]]));
  let speech = 0, right = 0, wrong = 0, pending = 0, missed = 0;
  for (let f = 0; f < hyp.length; f++) {
    const r = refAt(f);
    if (!r.length) continue;
    speech++;
    const hs = [...hyp[f]];
    if (!hs.length) missed++;
    else if (hs.every((h) => h === "?")) pending++;
    else if (hs.some((h) => h !== "?" && r.includes(map[h]))) right++;
    else wrong++;
  }
  const pct = (x) => `${(100 * x / speech).toFixed(1)}%`;
  ms.sort((a, b) => a - b);
  const labels = Object.keys(votes).filter((h) => h !== "?");
  console.log(`${name.padEnd(9)} right ${pct(right)}  wrong ${pct(wrong)}  pending ${pct(pending)}  missed ${pct(missed)}  ` +
    `labels ${labels.length} (${labels.map((h) => `${h}->${map[h]}`).join(" ")})  diarize median ${ms[ms.length >> 1].toFixed(0)}ms p95 ${ms[ms.length * 0.95 | 0].toFixed(0)}ms` +
    "");
}

const refIn = {};
for (const t of ref.turns) { const x = Math.min(t.end, OFF + LEN) - Math.max(t.start, OFF); if (x > 0) refIn[t.speaker] = (refIn[t.speaker] || 0) + x; }
console.log(`${OFF}s-${OFF + LEN}s, reference speakers: ${Object.entries(refIn).map(([s, x]) => `${s}=${x.toFixed(0)}s`).join(" ")}`);
const tracker = speakerTracker(who);
const tracked = async (audio) => (await tracker.label(audio)).map((t) => ({ label: t.speaker == null ? null : `S${t.speaker}`, start: t.start, end: t.end }));
const all = { full, window40, tracked };
for (const m of methods.length ? methods : Object.keys(all)) await run(m, all[m]);
