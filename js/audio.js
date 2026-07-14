// ABOUTME: The wall's ear: microphone capture and per-frame FFT analysis. I/O and array
// ABOUTME: plumbing only — every number it derives comes from pure math in signals.js.
// @ts-check
import { aggregateBands, bandRanges, spectralFlux, spectrumLevel } from './signals.js';

const FFT_SIZE = 2048; // 1024 bins, ~23 Hz/bin at 48 kHz
const BAND_EDGES = [20, 250, 2000, 8000]; // bass | mid | treble boundaries in Hz
const RETRY_S = 3; // seconds between reacquire attempts after mic loss

/**
 * To the microphone what Vision is to the camera. start() asks for the mic and builds the
 * analysis chain; update(dt) reads one byte spectrum per frame and derives the raw
 * level/band/flux scalars Signals consumes. Everything is preallocated — the render loop
 * allocates nothing. Audio never leaves this object: no recording, no transmission.
 */
export class AudioEngine {
  constructor() {
    this.levelRaw = 0;
    this.bandsRaw = new Float32Array(3);
    this.fluxRaw = 0;
    this.micAlive = false;
    /** @type {AudioContext | null} */
    this._ctx = null;
    /** @type {AnalyserNode | null} */
    this._analyser = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    this._source = null;
    /** @type {MediaStream | null} */
    this._stream = null;
    this._spectrum = new Uint8Array(FFT_SIZE / 2);
    this._prev = new Uint8Array(FFT_SIZE / 2);
    /** @type {[number, number][]} */
    this._ranges = [];
    this._warm = false; // the first frame after (re)start has no previous spectrum for flux
    this._retry = false; // armed only by mic loss, never by a denied start
    this._retryT = 0;
    /** @type {Promise<void> | null} */
    this._starting = null;
  }

  /** Idempotent while a start is in flight — callers can race freely. */
  start() {
    this._starting ??= this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    // Browser speech processing (echo cancel, noise suppression, AGC) eats the ambient
    // texture we render and fights our own adaptive gain — ask for the raw room.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (this._stream) for (const t of this._stream.getTracks()) t.stop();
    this._stream = stream;
    // Normally created inside the Begin-click gesture so it is never born suspended;
    // the kiosk auto-start has no gesture, so resume() covers that path too.
    this._ctx ??= new AudioContext();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    if (!this._analyser) {
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._analyser.smoothingTimeConstant = 0; // smoothing lives in signals.js, time-correct
      this._ranges = bandRanges(this._ctx.sampleRate, FFT_SIZE, BAND_EDGES);
    }
    this._source?.disconnect();
    this._source = this._ctx.createMediaStreamSource(stream);
    this._source.connect(this._analyser);
    this._warm = false;
    this.micAlive = true;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      // Mic unplugged or OS-revoked. No UI consequence — retry quietly from update().
      this.micAlive = false;
      this._retry = true;
      this._retryT = RETRY_S;
    });
  }

  /** @param {number} dt */
  update(dt) {
    if (!this.micAlive || !this._analyser) {
      this.levelRaw = 0;
      this.bandsRaw.fill(0);
      this.fluxRaw = 0;
      if (this._retry) {
        this._retryT -= dt;
        if (this._retryT <= 0) {
          this._retryT = RETRY_S;
          this.start().catch(() => {
            // still gone; keep trying — the wall lives fine deaf
          });
        }
      }
      return;
    }
    // Swap current/previous spectra so flux compares frames without copying.
    const prev = this._prev;
    this._prev = this._spectrum;
    this._spectrum = prev;
    this._analyser.getByteFrequencyData(this._spectrum);
    this.levelRaw = spectrumLevel(this._spectrum);
    aggregateBands(this._spectrum, this._ranges, this.bandsRaw);
    this.fluxRaw = this._warm ? spectralFlux(this._spectrum, this._prev) : 0;
    this._warm = true;
  }

  /** Release the mic and close the context (test teardown; the wall itself never stops). */
  stop() {
    this._retry = false;
    this.micAlive = false;
    if (this._stream) for (const t of this._stream.getTracks()) t.stop();
    this._stream = null;
    this._source?.disconnect();
    this._source = null;
    this._ctx?.close().catch(() => {});
    this._ctx = null;
    this._analyser = null;
  }
}
