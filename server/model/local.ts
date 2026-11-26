import { OpenAIResponses, type supportedModels } from '@mozaik-ai/core';

type GenerativeModel = (typeof supportedModels)[number];

// A model served on your own machine or LAN (Ollama, LM Studio, vLLM) through the OpenAI
// Responses API. Mozaik only runs models it knows by name, so each local one is added to its
// list here, pointed at the server's address.
export function localModels(baseURL: string, names: string[]): GenerativeModel[] {
  const endpoint = new OpenAIResponses(undefined, { baseURL, apiKey: 'local' }); // the server ignores the key, the SDK needs one
  // A local server cuts a prompt that is longer than its context window without saying so (Ollama
  // defaults to 4096 tokens). Report each new largest prompt, so a cut can be spotted.
  const infer = endpoint.infer.bind(endpoint);
  let largest = 0;
  endpoint.infer = async (input) => {
    const output = await infer(input);
    const tokens = output.tokenUsage?.inputTokens ?? 0;
    if (tokens > largest) {
      largest = tokens;
      console.log(`[local] largest prompt so far: ${tokens} tokens`);
    }
    return output;
  };
  return [...new Set(names)].map((name) => ({
    endpoint,
    specification: {
      name,
      provider: 'local',
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      supportsStreaming: true,
      contextWindowSize: 32_768,
      supportedContextItemTypes: ['message', 'function_call', 'function_call_output', 'reasoning'],
      maxOutputTokens: 8192,
      supportsFunctionCalling: true,
      supportsStructuredOutput: false,
    },
  }));
}
