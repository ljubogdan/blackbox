// Stripe in test mode, over its REST API. Only test keys are accepted: the hackathon's rule is no
// real money moving, so a live key is refused here rather than trusted to the person's care.

export interface PaymentGateway {
  run: string; // this engine run, in every payment's metadata, so one run can be told from another
  // Authorise without capturing: the money is reserved on the card but has not moved.
  authorise(ref: string, cents: number, description: string): Promise<string>;
  // Authorise and capture at once: a purchase that settled straight away.
  charge(ref: string, cents: number, description: string): Promise<string>;
  capture(paymentId: string): Promise<void>;
  cancel(paymentId: string): Promise<void>;
  refund(paymentId: string, cents: number): Promise<string>;
}

export const isTestKey = (key: string) => /^(sk|rk)_test_/.test(key);
export const dashboardUrl = (paymentId: string) => `https://dashboard.stripe.com/test/payments/${paymentId}`;

type Fetch = typeof fetch;

export function stripeGateway(key: string, fetchFn: Fetch = fetch, run = Date.now().toString(36)): PaymentGateway {
  if (!isTestKey(key)) throw new Error('Blackbox accepts only a Stripe test key (sk_test_… or rk_test_…)');

  // `ref` ties a request to its case, and the run id keeps case ids from an earlier run of the
  // engine (they restart at C-0001) from being taken for repeats of the same request.
  const post = async (path: string, params: Record<string, string>, idempotency?: string) => {
    const res = await fetchFn(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotency ? { 'Idempotency-Key': `blackbox-${run}-${idempotency}` } : {}),
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `Stripe answered ${res.status}`);
    return body;
  };

  const intent = async (ref: string, cents: number, description: string, capture: 'manual' | 'automatic') =>
    String(
      (
        await post(
          'payment_intents',
          {
            amount: String(cents),
            currency: 'eur',
            capture_method: capture,
            confirm: 'true',
            payment_method: 'pm_card_visa', // Stripe's test card
            // Current accounts refuse payment_method_types. Without redirects, a card is confirmed
            // here and needs no return_url.
            'automatic_payment_methods[enabled]': 'true',
            'automatic_payment_methods[allow_redirects]': 'never',
            description,
            'metadata[blackbox_case]': ref,
            'metadata[blackbox_run]': run,
          },
          `${ref}-${capture}`,
        )
      ).id,
    );

  return {
    run,
    authorise: (ref, cents, description) => intent(ref, cents, description, 'manual'),
    charge: (ref, cents, description) => intent(ref, cents, description, 'automatic'),
    capture: async (id) => void (await post(`payment_intents/${id}/capture`, {}, `${id}-capture`)),
    cancel: async (id) => void (await post(`payment_intents/${id}/cancel`, {}, `${id}-cancel`)),
    refund: async (id, cents) => String((await post('refunds', { payment_intent: id, amount: String(cents) }, `${id}-refund`)).id),
  };
}
