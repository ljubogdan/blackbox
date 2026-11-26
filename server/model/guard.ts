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

// Wraps whichever runner is in use. Mozaik does not catch a rejected loop, so a
// provider error would surface as an unhandled rejection; here it becomes a
// final model message instead, and the loop ends cleanly where we can see it.
export class GuardedRunner implements InferenceRunner {
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private perContext = new Map<string, number>();
  lastError: string | null = null;

  constructor(
    private readonly inner: InferenceRunner,
    private readonly maxConcurrent: number,
    private readonly maxPerContext = 14,
    private readonly timeoutMs = 90_000,
    // Requests per minute the provider allows (0 = no pacing). Free tiers are often single digits.
    private readonly maxRpm = 0,
  ) {}

  private nextSlot = 0;

  // Space calls out evenly so a low requests-per-minute quota is never exceeded.
  private async pace() {
    if (this.maxRpm <= 0) return;
    const gap = 60_000 / this.maxRpm;
    const at = Math.max(Date.now(), this.nextSlot);
    this.nextSlot = at + gap;
    if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
  }

  private async attempt(request: InferenceInput): Promise<InferenceOutput> {
    for (let tries = 0; ; tries++) {
      await this.pace();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('inference timed out')), this.timeoutMs);
        });
        return await Promise.race([this.inner.run(request), timeout]);
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        const limited = /\b429\b|RESOURCE_EXHAUSTED|rate.?limit/i.test(text);
        if (!limited || tries >= 3) throw e;
        const wait = Number(/retry in ([\d.]+)s/i.exec(text)?.[1] ?? 20);
        console.error(`[inference] rate limited; retrying in ${Math.ceil(wait + 1)}s`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      } finally {
        clearTimeout(timer);
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
      return this.oneCallAtATime(request.context.id, await this.attempt(request));
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.release();
    }
  }

  // Streaming is not used by this app.
  async *stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield* this.inner.stream(request);
  }

  private fail(reason: string): InferenceOutput {
    this.lastError = reason;
    console.error(`[inference] ${reason.slice(0, 300)}`);
    return { items: [ModelMessageItem.rehydrate({ text: `INFERENCE_ERROR: ${reason}` })], tokenUsage: undefined, rowResponse: null };
  }
}
