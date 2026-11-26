import { FunctionCallItem, GeminiGenerateContent, type Endpoint, type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent } from '@mozaik-ai/core';

// Gemini 3 models sign each function call (a "thought signature") and refuse the next request of
// the same turn unless that signature comes back on the call it was issued for. Mozaik's Gemini
// mapper keeps neither the signature nor which calls arrived together in one response, so every
// step after a tool call fails with a 400. This runner remembers both, per context, and puts them
// back into the request Mozaik builds. Other providers pass through untouched.

interface Part {
  functionCall?: { id?: string };
  functionResponse?: { id?: string };
  thoughtSignature?: string;
}
interface Content {
  role: string;
  parts: Part[];
}
interface Seen {
  signature?: string;
  batch: number; // calls from one model response share a batch
}

export class GeminiSignatures implements InferenceRunner {
  private seen = new Map<string, Map<string, Seen>>(); // context id -> call id -> what Gemini sent with it
  private batches = 0;

  constructor(
    private readonly inner: InferenceRunner,
    models: { endpoint: Endpoint }[],
  ) {
    for (const { endpoint } of models) {
      if (!(endpoint instanceof GeminiGenerateContent)) continue;
      const mapper = endpoint.endpointMapper;
      endpoint.endpointMapper = {
        toResponse: (response) => mapper.toResponse(response),
        toRequest: (input: InferenceInput) => this.sign(input.context.id, mapper.toRequest(input)),
      };
    }
  }

  async run(request: InferenceInput): Promise<InferenceOutput> {
    return this.remember(request.context.id, await this.inner.run(request));
  }

  async *stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield* this.inner.stream(request);
  }

  // Note the signature each call came with, under an id that is unique in its context.
  private remember(contextId: string, output: InferenceOutput): InferenceOutput {
    const parts: Part[] | undefined = output.rowResponse?.candidates?.[0]?.content?.parts;
    const callParts = Array.isArray(parts) ? parts.filter((p) => p.functionCall) : [];
    if (callParts.length === 0) return output;

    const calls = this.seen.get(contextId) ?? new Map<string, Seen>();
    this.seen.delete(contextId);
    this.seen.set(contextId, calls); // most recently used last
    if (this.seen.size > 400) this.seen.delete(this.seen.keys().next().value!);

    const batch = ++this.batches;
    let n = 0;
    const items = output.items.map((item) => {
      if (!(item instanceof FunctionCallItem)) return item;
      const part = callParts[n++];
      // Gemini does not always give a call an id. Without a unique one, a result cannot be matched
      // to its call and a signature cannot find its way back.
      const callId = item.callId && !calls.has(item.callId) ? item.callId : `call-${crypto.randomUUID()}`;
      calls.set(callId, { signature: part?.thoughtSignature, batch });
      return callId === item.callId ? item : FunctionCallItem.rehydrate({ callId, name: item.name, args: item.args });
    });
    return { ...output, items };
  }

  // Put the request back into the shape Gemini produced: calls that arrived in one response sit in
  // one model step with their results in the step after it, and each call carries its signature.
  private sign<T extends { contents?: Content[] }>(contextId: string, request: T): T {
    const calls = this.seen.get(contextId);
    if (!calls || !Array.isArray(request.contents)) return request;

    const batchOf = (c: Content) => calls.get(c.parts[0]?.functionCall?.id ?? '')?.batch;
    const only = (c: Content | undefined, role: string, kind: 'functionCall' | 'functionResponse'): c is Content =>
      !!c && c.role === role && c.parts.length > 0 && c.parts.every((p) => p[kind]);

    const contents: Content[] = [];
    let results: Content | null = null; // where the result of a call folded into an earlier step goes
    for (const c of request.contents) {
      const [step, answers] = contents.length >= 2 ? contents.slice(-2) : [];
      if (only(c, 'model', 'functionCall') && only(step, 'model', 'functionCall') && only(answers, 'user', 'functionResponse') && batchOf(c) !== undefined && batchOf(c) === batchOf(step)) {
        step.parts.push(...c.parts);
        results = answers;
        continue;
      }
      if (results && c.role === 'user') {
        results.parts.push(...c.parts);
        results = null;
        continue;
      }
      results = null;
      contents.push({ ...c, parts: [...c.parts] });
    }

    for (const c of contents) {
      for (const part of c.parts) {
        const signature = part.functionCall && calls.get(part.functionCall.id ?? '')?.signature;
        if (signature) part.thoughtSignature = signature;
      }
    }
    return { ...request, contents };
  }
}
