import 'dotenv/config';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const provider = env.LOCAL_BASE_URL ? 'local' : env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : null;
const live = provider !== null && env.BLACKBOX_MODE !== 'scripted';

const DEFAULT_MODELS: Record<string, { investigator: string; arbiter: string }> = {
  anthropic: { investigator: 'claude-haiku-4-5', arbiter: 'claude-sonnet-4-6' },
  openai: { investigator: 'gpt-5.4-mini', arbiter: 'gpt-5.4' },
  gemini: { investigator: 'gemini-3.5-flash', arbiter: 'gemini-3.5-flash' },
  // A model on your own server (Ollama, LM Studio): LOCAL_BASE_URL, and LOCAL_MODEL for its name.
  local: { investigator: env.LOCAL_MODEL ?? 'qwen3:4b', arbiter: env.LOCAL_MODEL ?? 'qwen3:4b' },
};
const models = provider ? DEFAULT_MODELS[provider] : { investigator: 'scripted', arbiter: 'scripted' };
// Models to move to when the chosen one is out of quota or overloaded. Gemini's free tier counts
// 20 requests a day per model, so its neighbours are worth having; paid providers need none.
const DEFAULT_FALLBACKS: Record<string, string[]> = { gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] };
const list = (v: string | undefined) => (v !== undefined ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export const config = {
  port: num(env.ENGINE_PORT, 8787),
  seed: num(env.SEED, 20261127),
  mode: (live ? 'live' : 'scripted') as 'live' | 'scripted',
  localBaseUrl: env.LOCAL_BASE_URL,
  // A Stripe test key mirrors each case's money in Stripe test mode. Live keys are refused.
  stripeKey: env.STRIPE_SECRET_KEY || undefined,
  investigatorModel: env.INVESTIGATOR_MODEL ?? models.investigator,
  arbiterModel: env.ARBITER_MODEL ?? models.arbiter,
  fallbackModels: list(env.FALLBACK_MODELS) ?? (provider ? (DEFAULT_FALLBACKS[provider] ?? []) : []),
  // Scripted mode only: share of first submissions whose citation is deliberately
  // corrupted, so the verifier's rejection path is exercised and visible.
  faultRate: live ? 0 : num(env.FAULT_RATE, 0.15),
  // Rulings on orders at or above this amount (EUR) wait for a human.
  approvalThreshold: num(env.APPROVAL_THRESHOLD, 1000),
  // How many rulings may wait for a person before the stream stops producing more that would need one.
  maxAwaiting: num(env.MAX_AWAITING, 2),
  premiumBps: num(env.PREMIUM_BPS, 90),
  maxOpenCases: num(env.MAX_OPEN_CASES, live ? 2 : 4),
  // Live mode only: bounds model spend. The stand-in costs nothing, so a cap set for a real key does not apply to it.
  maxCases: live ? num(env.MAX_CASES, 12) : Infinity,
  disputeEveryMs: num(env.DISPUTE_EVERY_MS, live ? 15000 : 6500),
  // How long one model call may take before it is abandoned. A small model on a shared server needs longer.
  inferenceTimeoutMs: num(env.INFERENCE_TIMEOUT_S, 90) * 1000,
  maxConcurrentInferences: num(env.MAX_CONCURRENT_INFERENCES, live ? 6 : 64),
  // Live mode only: provider requests-per-minute cap; calls are spaced to stay under it. 0 = no pacing.
  maxRpm: live ? num(env.MAX_RPM, 0) : 0,
  // Live mode only: dollars the run may spend on model calls, at list prices (server/model/cost.ts). Unset = no cap.
  spendCapUsd: live ? num(env.SPEND_CAP_USD, Infinity) : Infinity,
  maxAttempts: 3,
  // STREAM=off: open no cases on a timer, only on request (npm run eval).
  stream: env.STREAM !== 'off',
  // NETWORK=off: learn no attack signatures, so every case is decided by the team rather than by a match.
  networkLearning: env.NETWORK !== 'off',
};
