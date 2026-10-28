// Live speaker labels whose numbers hold for the whole conversation.
//
// Who numbers speakers within one call, so diarizing only the recent audio renumbers them as the
// window slides. Instead, a short clip of each speaker's voice goes in front of the recent audio,
// and whichever lane a clip lands in is that speaker. A new voice gets a number once it has spoken
// alone long enough to cut its own clip. An enrolled voice is simply the first clip.
const RATE = 16000;
const CLIP = 12;     // seconds of a new speaker's solo speech kept as their clip
const MIN_SOLO = 10; // solo speech a new voice needs first; Who misses the voice in ~20% of clips of 10s or less
const BUDGET = 55;   // clips + recent audio under 60s keep Who on its fast 60s graph

const concat = (...xs) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
};

export function speakerTracker(who) {
  let clips = []; // { id, samples, enrolled }, in the order they go in front of the audio
  let prev = [];  // the previous call's labeled turns

  return {
    get speakers() { return clips.map(({ id, enrolled }) => ({ id, enrolled })); },
    enroll(samples) { clips = [{ id: 0, samples, enrolled: true }]; prev = []; },
    unenroll() { clips = []; prev = []; },
    reset() { clips = clips.filter((c) => c.enrolled); prev = []; },

    // `audio` is the end of the recording so far (the last 40s is enough), starting `offset` seconds
    // into it. Returns its recent turns as { speaker, start, end } in recording time; `speaker` is a
    // clip id, or null for a voice that has no clip yet.
    async label(audio, offset = 0) {
      const clipLen = clips.reduce((n, c) => n + c.samples.length, 0);
      const recent = Math.max(15 * RATE, Math.min(40 * RATE, BUDGET * RATE - clipLen));
      const from = Math.max(0, audio.length - recent);
      const r = await who.diarize(concat(...clips.map((c) => c.samples), audio.subarray(from)));

      // The lane holding most of each clip is that clip's speaker. When Who puts two clips in one
      // lane (mostly when one of them is silent in the window), picking either by position would
      // pass one person's speech off as another's; see below.
      const clipsIn = new Map(); // lane -> clip ids
      let o = 0;
      for (const c of clips) {
        const s = o / RATE, e = (o += c.samples.length) / RATE, overlap = {};
        for (const t of r.turns) {
          const x = Math.min(t.end, e) - Math.max(t.start, s);
          if (x > 0) overlap[t.speaker] = (overlap[t.speaker] || 0) + x;
        }
        const best = Object.entries(overlap).sort((p, q) => q[1] - p[1])[0];
        if (best) clipsIn.set(+best[0], [...(clipsIn.get(+best[0]) ?? []), c.id]);
      }
      const idOf = (lane) => (clipsIn.get(lane)?.length === 1 ? clipsIn.get(lane)[0] : null);

      const base = clipLen / RATE, shift = offset + from / RATE - base;
      const turns = r.turns.filter((t) => t.end > base).map((t) => ({
        lane: t.speaker,
        speaker: idOf(t.speaker),
        start: Math.max(t.start, base) + shift,
        end: t.end + shift,
      }));

      // A lane two clips share takes whichever of them the previous call gave the same audio; with
      // no such history its speech stays unlabeled.
      for (const [lane, ids] of clipsIn) {
        if (ids.length < 2) continue;
        const votes = {};
        for (const t of turns) if (t.lane === lane) for (const p of prev) if (ids.includes(p.speaker)) {
          const x = Math.min(p.end, t.end) - Math.max(p.start, t.start);
          if (x > 0) votes[p.speaker] = (votes[p.speaker] || 0) + x;
        }
        const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
        if (best) for (const t of turns) if (t.lane === lane) t.speaker = +best[0];
      }

      // A lane with no clip and enough solo speech becomes a new speaker, cut from that speech.
      for (const lane of new Set(turns.filter((t) => !clipsIn.has(t.lane)).map((t) => t.lane))) {
        const solo = turns.filter((t) => t.lane === lane && t.end - t.start >= 1 &&
          turns.filter((u) => u.lane !== lane)
            .reduce((n, u) => n + Math.max(0, Math.min(u.end, t.end) - Math.max(u.start, t.start)), 0) < 0.3);
        if (solo.reduce((n, t) => n + t.end - t.start, 0) < MIN_SOLO) continue;
        const parts = [];
        let n = 0;
        for (const t of solo) {
          if (n >= CLIP * RATE) break;
          const s = Math.round((t.start - offset) * RATE), e = Math.min(Math.round((t.end - offset) * RATE), s + CLIP * RATE - n);
          parts.push(audio.subarray(s, e));
          n += e - s;
        }
        const id = clips.length;
        clips.push({ id, samples: concat(...parts), enrolled: false });
        for (const t of turns) if (t.lane === lane) t.speaker = id;
      }
      prev = turns.map(({ speaker, start, end }) => ({ speaker, start, end }));
      return prev;
    },
  };
}
