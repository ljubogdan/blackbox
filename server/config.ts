import 'dotenv/config';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const provider = env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : null;
const live = provider !== null && env.BLACKBOX_MODE !== 'scripted';

const DEFAULT_MODELS: Record<string, { investigator: string; arbiter: string }> = {
  anthropic: { investigator: 'claude-haiku-4-5', arbiter: 'claude-sonnet-4-6' },
  openai: { investigator: 'gpt-5.4-mini', arbiter: 'gpt-5.4' },
  gemini: { investigator: 'gemini-3.5-flash', arbiter: 'gemini-3.5-flash' },
};
const models = provider ? DEFAULT_MODELS[provider] : { investigator: 'scripted', arbiter: 'scripted' };

export const config = {
  port: num(env.ENGINE_PORT, 8787),
  seed: num(env.SEED, 20261127),
  mode: (live ? 'live' : 'scripted') as 'live' | 'scripted',
  investigatorModel: env.INVESTIGATOR_MODEL ?? models.investigator,
  arbiterModel: env.ARBITER_MODEL ?? models.arbiter,
  // Scripted mode only: share of first submissions whose citation is deliberately
  // corrupted, so the verifier's rejection path is exercised and visible.
  faultRate: live ? 0 : num(env.FAULT_RATE, 0.15),
  // Rulings on orders at or above this amount (EUR) wait for a human.
  approvalThreshold: num(env.APPROVAL_THRESHOLD, 1000),
  premiumBps: num(env.PREMIUM_BPS, 90),
  maxOpenCases: num(env.MAX_OPEN_CASES, live ? 2 : 4),
  maxCases: num(env.MAX_CASES, live ? 12 : Infinity), // bounds model spend in live mode
  disputeEveryMs: num(env.DISPUTE_EVERY_MS, live ? 15000 : 6500),
  maxConcurrentInferences: num(env.MAX_CONCURRENT_INFERENCES, live ? 6 : 64),
  // Provider requests-per-minute cap; calls are spaced to stay under it. 0 = no pacing.
  maxRpm: num(env.MAX_RPM, 0),
  maxAttempts: 3,
};
