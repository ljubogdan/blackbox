import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type ModelContext,
  type SemanticEvent,
} from '@mozaik-ai/core';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// How long a provider asks us to wait, in seconds: "retry in 21s", "retry in 19h32m54.02s",
// or a "retryDelay":"70374s" field. Null when it does not say.
export function retryDelay(text: string): number | null {
  const said = /retry in ((?:[\d.]+(?:ms|[hms]))+)/i.exec(text);
  if (said) {
    let seconds = 0;
    for (const [, n, unit] of said[1].matchAll(/([\d.]+)(ms|[hms])/g)) seconds += Number(n) * { h: 3600, m: 60, s: 1, ms: 0.001 }[unit as 'h' | 'm' | 's' | 'ms'];
    return seconds;
  }
  const field = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text);
  return field ? Number(field[1]) : null;
}

// What kind of failure this is: a quota ('limited'), a provider that cannot answer right now
// ('busy'), or anything else, which retrying will not fix.
export function failureKind(text: string): 'limited' | 'busy' | 'other' {
  if (/"code":\s*429\b|(?<![\d.,€])429(?!\d|[.,]\d)|RESOURCE_EXHAUSTED|rate.?limit/i.test(text)) return 'limited';
  // A bare status number counts only when it is not part of a longer figure, such as an amount.
  if (/"code":\s*5\d\d\b|(?<![\d.,€])(502|503|529)(?!\d|[.,]\d)|UNAVAILABLE|overloaded|high demand|inference timed out/i.test(text)) return 'busy';
  return 'other';
}

// A provider error as one readable line: the message out of its JSON, without the line breaks.
export function brief(text: string, max = 700): string {
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.error?.message ?? parsed?.message ?? text);
  } catch {
    // not JSON: use it as it is
  }
  return message
    .replace(/(For more information|To monitor)[^.]*head to:\s*\S+/gi, '') // pointers to the provider's docs push the reason out of view
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface GuardOptions {
  // Models to use instead, in order, when the one asked for is out of quota or cannot answer.
  fallbacks?: string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const LONG_WAIT_S = 90; // a wait longer than this is a daily cap, not a per-minute one
const BUSY_REST_MS = 120_000; // how long an overloaded model is left alone
const MAX_STEPS = 6; // tries per inference, across every model

// Wraps whichever runner is in use. Mozaik does not catch a rejected loop, so a
// provider error would surface as an unhandled rejection; here it becomes a
// final model message instead, and the loop ends cleanly where we can see it.
export class GuardedRunner implements InferenceRunner {
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private perContext = new Map<string, number>();
  private down = new Map<string, number>(); // model -> when it may be tried again
  private readonly fallbacks: string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  lastError: string | null = null;

  constructor(
    private readonly inner: InferenceRunner,
    private readonly maxConcurrent: number,
    private readonly maxPerContext = 14,
    private readonly timeoutMs = 90_000,
    // Requests per minute the provider allows (0 = no pacing). Free tiers are often single digits.
    private readonly maxRpm = 0,
    options: GuardOptions = {},
  ) {
    this.fallbacks = options.fallbacks ?? [];
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  private nextSlot = 0;

  // Space calls out evenly so a low requests-per-minute quota is never exceeded.
  private async pace() {
    if (this.maxRpm <= 0) return;
    const gap = 60_000 / this.maxRpm;
    const at = Math.max(this.now(), this.nextSlot);
    this.nextSlot = at + gap;
    if (at > this.now()) await this.sleep(at - this.now());
  }

  private isDown(model: string) {
    return (this.down.get(model) ?? 0) > this.now();
  }

  // The model to use for a request: the one asked for, or the first fallback that is not resting.
  // If every one of them is resting, the one asked for, so the error the caller sees is its own.
  private available(asked: string) {
    return this.candidates(asked).find((m) => !this.isDown(m)) ?? asked;
  }

  private candidates(asked: string) {
    return [asked, ...this.fallbacks.filter((m) => m !== asked)];
  }

  private async once(request: InferenceInput): Promise<InferenceOutput> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('inference timed out')), this.timeoutMs);
      });
      return await Promise.race([this.inner.run(request), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A short quota wait is sat out. A model that is out for the day, or that stays busy, is rested
  // and the request moves to the next model, so one bad model does not stop the room.
  private async attempt(request: InferenceInput): Promise<InferenceOutput> {
    let model = this.available(request.model);
    let busy = 0; // failures in a row on this model for being overloaded
    for (let step = 1; ; step++) {
      await this.pace();
      try {
        return await this.once(model === request.model ? request : { ...request, model });
      } catch (e) {
        const text = errorText(e);
        const kind = failureKind(text);
        if (kind === 'other' || step >= MAX_STEPS) throw e;

        const wait = kind === 'limited' ? (retryDelay(text) ?? 20) : null;
        const timedOut = /inference timed out/.test(text);
        if (wait === null) busy++;
        const elsewhere = this.candidates(request.model).find((m) => m !== model && !this.isDown(m));
        // Leave this model when it is out for the day, or when it stays busy and another can take over.
        const leave = wait !== null ? wait > LONG_WAIT_S : (timedOut || busy >= 2) && !!elsewhere;
        if (!leave) {
          if (timedOut && busy >= 2) throw e; // a second full timeout with no other model to try
          const pause = wait !== null ? (wait + 1) * 1000 : Math.min(2000 * 3 ** (busy - 1), 30_000);
          console.error(`[inference] ${model}: ${wait !== null ? 'rate limited' : 'busy'}; retrying in ${Math.ceil(pause / 1000)}s`);
          await this.sleep(pause);
          continue;
        }

        const known = this.isDown(model); // several requests can find the same model out at once: say it once
        this.down.set(model, this.now() + (wait !== null ? Math.min(wait, 86_400) * 1000 : BUSY_REST_MS));
        if (!elsewhere) throw e;
        if (!known) console.error(`[inference] ${model}: ${wait !== null ? 'out of quota' : timedOut ? 'timed out' : 'overloaded'} (${brief(text, 240)}); using ${elsewhere}`);
        model = elsewhere;
        busy = 0;
      }
    }
  }

  private async acquire() {
    if (this.inFlight >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }

  private release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  // Mozaik's loop runs one tool call per model response: the first. A model that asks for several
  // at once would have the rest dropped, so they wait here and are handed to the loop one at a
  // time, each as a step of its own. Every call is run and recorded before the model is asked again.
  private waiting = new Map<string, { after: string; calls: FunctionCallItem[] }>(); // by context id

  // The calls waiting for this context, if the loop is where they expect it to be: the context
  // must end with the result of the call handed out last. Otherwise the turn moved on without them.
  private queueFor(context: ModelContext) {
    const q = this.waiting.get(context.id);
    if (!q) return null;
    const last = context.getItems().at(-1);
    if (last instanceof FunctionCallOutputItem && last.callId === q.after) return q;
    this.waiting.delete(context.id);
    return null;
  }

  // True when the next step for this context is a waiting tool call, not a model call.
  hasQueued(context: ModelContext): boolean {
    return this.queueFor(context) !== null;
  }

  private oneCallAtATime(contextId: string, output: InferenceOutput): InferenceOutput {
    const calls = output.items.filter((it): it is FunctionCallItem => it instanceof FunctionCallItem);
    if (calls.length < 2) return output;
    this.waiting.set(contextId, { after: calls[0].callId, calls: calls.slice(1) });
    return { ...output, items: output.items.filter((it) => !(it instanceof FunctionCallItem) || it === calls[0]) };
  }

  async run(request: InferenceInput): Promise<InferenceOutput> {
    const q = this.queueFor(request.context);
    if (q) {
      const next = q.calls.shift()!;
      q.after = next.callId;
      if (q.calls.length === 0) this.waiting.delete(request.context.id);
      return { items: [next], tokenUsage: undefined, rowResponse: null };
    }

    const seen = (this.perContext.get(request.context.id) ?? 0) + 1;
    this.perContext.set(request.context.id, seen);
    if (seen > this.maxPerContext) return this.fail('inference limit reached for this context');

    await this.acquire();
    try {
      return this.oneCallAtATime(request.context.id, this.endsSomehow(request.model, await this.attempt(request)));
    } catch (e) {
      return this.fail(brief(errorText(e)));
    } finally {
      this.release();
    }
  }

  // Mozaik's loop moves on only from a tool call or a text answer. A model can end its turn with
  // neither (Claude does, after a tool result it has nothing to add to), and the loop then throws
  // and never goes idle, so whatever waits for that turn waits forever. An empty answer ends it.
  private endsSomehow(model: string, output: InferenceOutput): InferenceOutput {
    if (output.items.some((it) => it instanceof FunctionCallItem || it instanceof ModelMessageItem)) return output;
    console.error(`[inference] ${model}: answered with neither text nor a tool call; ending the turn`);
    return { ...output, items: [...output.items, ModelMessageItem.rehydrate({ text: '' })] };
  }

  // Streaming is not used by this app.
  async *stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield* this.inner.stream(request);
  }

  private fail(reason: string): InferenceOutput {
    this.lastError = reason;
    console.error(`[inference] failed: ${reason}`);
    return { items: [ModelMessageItem.rehydrate({ text: `INFERENCE_ERROR: ${reason}` })], tokenUsage: undefined, rowResponse: null };
  }
}
