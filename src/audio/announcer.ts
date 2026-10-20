// Race commentary in the spirit of the film's two-headed announcers: short original lines spoken by the
// browser's own speech synthesis (no recordings), alternating two voices. Big moments interrupt small
// ones; small ones are dropped rather than queued so the commentary never lags behind the race.
import { speechLang, t, type StringKey } from '../i18n/i18n';

/** Minimum seconds between two low-priority lines. */
const CHATTER_GAP = 4;

export class Announcer {
  enabled = true;
  private voices: SpeechSynthesisVoice[] = [];
  private turn = 0;
  private busyUntil = 0;
  private lastLow = -1e9;
  private readonly synth: SpeechSynthesis | null = 'speechSynthesis' in window ? window.speechSynthesis : null;

  constructor() {
    this.synth?.addEventListener('voiceschanged', () => (this.voices = []));
  }

  private pickVoices(): SpeechSynthesisVoice[] {
    if (this.voices.length || !this.synth) return this.voices;
    const lang = speechLang().slice(0, 2);
    this.voices = this.synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
    return this.voices;
  }

  /** Speak a line. `big` lines cut in over whatever is playing; small ones wait their turn or are dropped. */
  say(key: StringKey, params?: Record<string, string | number>, big = false): void {
    if (!this.enabled || !this.synth) return;
    const now = performance.now() / 1000;
    if (!big && (now < this.busyUntil || now - this.lastLow < CHATTER_GAP)) return;
    if (big) this.synth.cancel();
    else this.lastLow = now;
    const text = t(key, params);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = speechLang();
    const voices = this.pickVoices();
    // Two commentators: alternate voices when the system has more than one, else alternate pitch.
    this.turn ^= 1;
    if (voices.length) u.voice = voices[this.turn % voices.length];
    u.pitch = this.turn ? 1.25 : 0.8;
    u.rate = big ? 1.15 : 1.1;
    u.volume = 0.9;
    this.busyUntil = now + text.length * 0.065;
    this.synth.speak(u);
  }

  stop(): void {
    this.synth?.cancel();
    this.busyUntil = 0;
  }
}
