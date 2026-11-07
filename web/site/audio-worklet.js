// Plays the Lisa's speaker: the main thread posts Float32Array chunks of mono PCM (already at this
// context's sample rate, see Lisa.audioStart), and this pulls them out in real time.
//
// The emulator runs in short bursts once per video frame, so the queue absorbs the jitter: playback
// starts once `startMs` of audio is queued, and if it ever runs dry it goes silent and re-buffers
// rather than stuttering. If the queue grows past `maxMs` (the emulator running fast) the oldest audio
// is dropped, which keeps the sound close to what is on screen.

class LisaSpeaker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.startN = Math.round(((o.startMs ?? 40) / 1000) * sampleRate);
    this.maxN = Math.round(((o.maxMs ?? 250) / 1000) * sampleRate);
    this.chunks = [];        // queued Float32Arrays
    this.head = 0;           // read offset into chunks[0]
    this.queued = 0;         // samples queued
    this.playing = false;
    this.underruns = 0;
    this.dropped = 0;
    this.peak = 0;           // peak |sample| since the last report
    this.sumSq = 0; this.count = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m instanceof Float32Array) {
        this.chunks.push(m); this.queued += m.length;
        while (this.queued > this.maxN && this.chunks.length > 1) {   // too far behind: drop the oldest
          const first = this.chunks[0], drop = first.length - this.head;
          this.chunks.shift(); this.head = 0; this.queued -= drop; this.dropped += drop;
        }
      } else if (m === 'flush') {
        this.chunks = []; this.head = 0; this.queued = 0; this.playing = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    if (!this.playing && this.queued >= this.startN) this.playing = true;
    let i = 0;
    if (this.playing) {
      while (i < n && this.chunks.length) {
        const c = this.chunks[0];
        const take = Math.min(n - i, c.length - this.head);
        out.set(c.subarray(this.head, this.head + take), i);
        i += take; this.head += take; this.queued -= take;
        if (this.head >= c.length) { this.chunks.shift(); this.head = 0; }
      }
      if (i < n) { this.playing = false; this.underruns++; }       // ran dry: re-buffer
    }
    for (let k = 0; k < i; k++) { const v = out[k]; this.sumSq += v * v; if (v > this.peak) this.peak = v; else if (-v > this.peak) this.peak = -v; }
    this.count += n;
    out.fill(0, i);
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    if (++this.frames % 22 === 0) {                                  // ~ every 60 ms
      this.port.postMessage({ queued: this.queued, underruns: this.underruns, dropped: this.dropped, peak: this.peak, rms: Math.sqrt(this.sumSq / Math.max(1, this.count)) });
      this.peak = 0; this.sumSq = 0; this.count = 0;
    }
    return true;
  }
}
registerProcessor('lisa-speaker', LisaSpeaker);
