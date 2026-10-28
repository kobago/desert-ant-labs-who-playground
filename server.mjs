import http from "node:http";
import { readFileSync } from "node:fs";
import { Who } from "@desert-ant-labs/who/native";
import { speakerTracker } from "./speakers.mjs";

const PORT = 5173;
const RATE = 16000;

console.log("Who を読み込み中… (初回はダウンロードと Neural Engine 向けの準備で1分ほどかかります)");
const loadStart = performance.now();
const who = await Who.load();
await who.diarize(new Float32Array(RATE * 5)); // load() is lazy; the first diarize loads the graphs
const loadMs = performance.now() - loadStart;
const page = readFileSync(new URL("index.html", import.meta.url));

// ponytail: one recording shared by every tab; per-session buffers if several people use it at once.
// Only the end of the recording is kept: the tracker reads at most the last 40s.
const KEEP = 45 * RATE;
let audio = new Float32Array(0), offset = 0; // `audio` starts `offset` seconds into the recording
const tracker = speakerTracker(who);
const enrolled = () => tracker.speakers.some((s) => s.enrolled);

const mem = () => ({
  rssMB: process.memoryUsage().rss / 2 ** 20,
  peakMB: process.resourceUsage().maxRSS / 1024,
});

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

// Body: mono float32 PCM at 16 kHz.
async function readSamples(req) {
  const buf = Buffer.concat(await req.toArray());
  return buf.length % 4 ? null : new Float32Array(new Uint8Array(buf).buffer);
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && req.url === "/stats") return json(res, 200, { loadMs, enrolled: enrolled(), ...mem() });
    if (req.method === "POST" && req.url === "/reset") {
      audio = new Float32Array(0);
      offset = 0;
      tracker.reset();
      return json(res, 200, {});
    }
    if (req.method === "DELETE" && req.url === "/enroll") {
      tracker.unenroll();
      return json(res, 200, {});
    }
    if (req.method === "POST" && req.url === "/enroll") {
      const samples = await readSamples(req);
      if (!samples || samples.length < 10 * RATE) return json(res, 400, { error: "10秒以上の音声が必要です" });
      const r = await who.diarize(samples);
      const speech = r.turnsOf(0).reduce((s, t) => s + t.duration, 0);
      if (speech < 5) return json(res, 400, { error: "声がほとんど聞き取れませんでした。もう一度録ってください" });
      tracker.enroll(samples);
      return json(res, 200, { speech, speakerCount: r.speakerCount });
    }
    if (req.method === "POST" && req.url === "/chunk") {
      const chunk = await readSamples(req);
      if (!chunk) return json(res, 400, { error: "body must be float32 samples" });
      const all = new Float32Array(audio.length + chunk.length);
      all.set(audio);
      all.set(chunk, audio.length);
      const drop = Math.max(0, all.length - KEEP);
      audio = all.slice(drop);
      offset += drop / RATE;

      const duration = offset + audio.length / RATE;
      let turns = [], diarizeMs = 0;
      if (duration >= 2) {
        const t = performance.now();
        turns = await tracker.label(audio, offset);
        diarizeMs = performance.now() - t;
      }
      return json(res, 200, { duration, turns, speakers: tracker.speakers, diarizeMs, enrolled: enrolled(), ...mem() });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`読み込み ${(loadMs / 1000).toFixed(1)}s → http://localhost:${PORT}`);
});
