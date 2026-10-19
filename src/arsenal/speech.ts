// Speaking A.R.S.E.N.A.L's answers aloud. Two engines:
//   - "kokoro": Kokoro-82M (Apache-2.0, hexgrad), a small natural-sounding TTS model run locally with
//     kokoro-js (ONNX on the CPU). The model (~90 MB) is downloaded once from Hugging Face into
//     data/models. Sentence by sentence: the next one is prepared while the current one plays.
//   - "system": macOS's built-in `say` (also the fallback if Kokoro can't load).
// No shell anywhere: `say` gets options as arguments and the text on stdin (`-f -`); audio files go to
// data/tts/ and are played with `afplay` (macOS; other OSes: silent for now).
// It never speaks while the mic is listening (push-to-talk first stops any speech).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../core/paths.ts";

const MAX_SPOKEN_CHARS = 700;
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

export type SpeakEngine = "kokoro" | "system";

export interface SpeakOptions {
  engine?: SpeakEngine | undefined;
  /** `say` voice name (system engine) or Kokoro voice id (e.g. af_heart). */
  voice?: string | undefined;
  /** Words per minute; 0/undefined = normal speed. */
  rate?: number | undefined;
}

/** Text → 16-bit PCM WAV (Kokoro). Tests pass a fake. */
export interface Synth {
  voices(): string[];
  wav(text: string, voice: string, speed: number): Promise<Buffer>;
}

/** Loads Kokoro on first use (~1-2 s from the local cache; the first time it downloads ~90 MB). */
export async function loadKokoro(cacheDir = join(DATA_DIR, "models")): Promise<Synth> {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir; // keep the model inside the project, not in ~/.cache
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" });
  return {
    voices: () => Object.keys(tts.voices),
    wav: async (text, voice, speed) => {
      const audio = await tts.generate(text, { voice: voice as never, speed });
      return Buffer.from(audio.toWav());
    },
  };
}

/** Split into sentences (and long sentences at commas) so speech can start after the first one. */
export function sentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (p.length <= 220) out.push(p);
    else out.push(...p.split(/(?<=[,;:])\s+/).filter(Boolean));
  }
  return out;
}

export class Speaker {
  private current: ChildProcess | null = null;
  /** Bumped by stop(): an utterance in progress checks it before every sentence. */
  private generation = 0;
  private active = false;
  private listening = false;
  private listeners = new Set<(speaking: boolean) => void>();
  private kokoro: Promise<Synth> | null = null;
  private kokoroFailed: string | null = null;
  private seq = 0;

  constructor(
    private deps: {
      sayPath?: string | null;
      playerPath?: string | null;
      loadSynth?: () => Promise<Synth>;
      audioDir?: string;
    } = {},
  ) {
    const mac = process.platform === "darwin";
    this.deps = {
      sayPath: deps.sayPath !== undefined ? deps.sayPath : mac ? "/usr/bin/say" : null,
      playerPath: deps.playerPath !== undefined ? deps.playerPath : mac ? "/usr/bin/afplay" : null,
      loadSynth: deps.loadSynth ?? (() => loadKokoro()),
      audioDir: deps.audioDir ?? join(DATA_DIR, "tts"),
    };
  }

  get available(): boolean {
    return !!this.deps.sayPath || !!this.deps.playerPath;
  }

  get speaking(): boolean {
    return this.active;
  }

  /** Why Kokoro isn't used (it fell back to `say`), if it failed to load. */
  get kokoroError(): string | null {
    return this.kokoroFailed;
  }

  onChange(fn: (speaking: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    for (const fn of this.listeners) fn(on);
  }

  /** The mic is on (push-to-talk held): stop talking and stay quiet until it's off. */
  setListening(on: boolean): void {
    this.listening = on;
    if (on) this.stop();
  }

  /** Load Kokoro now (e.g. when the user picks it), so the first answer isn't delayed. */
  warmUp(): Promise<Synth> | null {
    if (!this.deps.playerPath) return null;
    if (!this.kokoro) {
      this.kokoro = this.deps.loadSynth!();
      this.kokoro.then(
        () => (this.kokoroFailed = null),
        (err) => {
          this.kokoroFailed = err instanceof Error ? err.message : String(err);
          this.kokoro = null; // try again next time
        },
      );
    }
    return this.kokoro;
  }

  async kokoroVoices(): Promise<string[]> {
    try {
      return (await this.warmUp())?.voices() ?? [];
    } catch {
      return [];
    }
  }

  /** Speak (replacing anything still being said). False if it can't right now. */
  speak(text: string, opts: SpeakOptions = {}): boolean {
    if (!this.available || this.listening) return false;
    const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_SPOKEN_CHARS);
    if (!clean) return false;
    this.stop();
    const gen = ++this.generation;
    this.setActive(true);
    const done = () => {
      if (this.generation === gen) this.setActive(false);
    };
    const useKokoro = (opts.engine ?? "kokoro") === "kokoro" && !!this.deps.playerPath;
    (useKokoro ? this.speakKokoro(clean, opts, gen).catch(() => this.speakSay(clean, opts, gen)) : this.speakSay(clean, opts, gen)).finally(done);
    return true;
  }

  stop(): void {
    this.generation++;
    const c = this.current;
    this.current = null;
    c?.kill();
    this.setActive(false);
  }

  /** Run a child to completion (or until stop() kills it). */
  private run(path: string, args: string[], stdin?: string): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(path, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
      this.current = child;
      const end = () => {
        if (this.current === child) this.current = null;
        resolve();
      };
      child.on("exit", end);
      child.on("error", end);
      if (stdin !== undefined) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(stdin);
      }
    });
  }

  private async speakSay(text: string, opts: SpeakOptions, gen: number): Promise<void> {
    if (!this.deps.sayPath || gen !== this.generation) return;
    const args: string[] = [];
    // A Kokoro voice id means nothing to `say` (fallback): use the system voice then.
    if (opts.voice && opts.engine === "system") args.push("-v", opts.voice);
    if (opts.rate) args.push("-r", String(Math.round(opts.rate)));
    args.push("-f", "-");
    await this.run(this.deps.sayPath, args, text);
  }

  private async speakKokoro(text: string, opts: SpeakOptions, gen: number): Promise<void> {
    const synth = await this.warmUp()!;
    const voices = synth.voices();
    const voice = opts.voice && voices.includes(opts.voice) ? opts.voice : DEFAULT_KOKORO_VOICE;
    // ~175 wpm is Kokoro's normal pace.
    const speed = opts.rate ? Math.max(0.6, Math.min(1.8, opts.rate / 175)) : 1;
    mkdirSync(this.deps.audioDir!, { recursive: true });
    const parts = sentences(text);
    // Prepare the next sentence while the current one plays.
    let next = synth.wav(parts[0]!, voice, speed);
    for (let i = 0; i < parts.length; i++) {
      const wav = await next;
      if (gen !== this.generation) return;
      if (i + 1 < parts.length) next = synth.wav(parts[i + 1]!, voice, speed);
      const file = join(this.deps.audioDir!, `say-${process.pid}-${++this.seq}.wav`);
      writeFileSync(file, wav);
      try {
        await this.run(this.deps.playerPath!, [file]);
      } finally {
        if (existsSync(file)) rmSync(file, { force: true });
      }
    }
  }

  /** Installed `say` voices (name + language). */
  voices(): Promise<Array<{ name: string; lang: string }>> {
    if (!this.deps.sayPath) return Promise.resolve([]);
    return new Promise((resolve) => {
      execFile(this.deps.sayPath!, ["-v", "?"], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        const list: Array<{ name: string; lang: string }> = [];
        for (const line of out.split("\n")) {
          const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/);
          if (m) list.push({ name: m[1]!.trim(), lang: m[2]! });
        }
        resolve(list);
      });
    });
  }
}
