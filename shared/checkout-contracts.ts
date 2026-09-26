/** Contract acceptance evidence is separate from payment, entitlement and delivery. */
export type CheckoutTermsCompletion = {
  state: 'accepted' | 'not_recorded';
  providerEventCreatedAt: string;
  observedAt: string;
  source: 'verified_stripe_checkout_session';
};
export type CheckoutTermsSummary = {
  id: string;
  mode: 'test' | 'live';
  planId: 'standard' | 'team';
  policyVersion: string;
  language: string;
  createdAt: string;
  completion: CheckoutTermsCompletion | null;
};
export type CheckoutTermsList = {
  captureEnabled: boolean;
  records: CheckoutTermsSummary[];
  nextCursor: string | null;
  legacyCheckout: {mode: 'test' | 'live'; state: 'unknown'} | null;
};
export type CheckoutTermsRecord = CheckoutTermsSummary & {
  policy: {version: string; language: string; title: string; text: string; url: string; sha256: string};
  offer: {planName: string; currency: 'eur'; amountMinor: number; interval: 'month'; pagesPerCalendarMonth: number; aiSuggestionsPerCalendarMonth: number};
  agreementText: string;
  evidenceNotice: string;
};
