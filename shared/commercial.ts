/** Operator decisions confirmed on 26 September 2026. These do not activate billing. */
export const commercialTerms = {
  allowance: 'Page and AI suggestion allowances reset on the first day of each calendar month in UTC. Unused allowances do not roll over. Subscription renewal dates can differ from this reset date.',
  tax: 'Prices are in EUR. The operator is not currently VAT-registered; VAT is not added to these prices.',
  refunds: 'We do not offer discretionary refunds for a change of mind, unused page credits or a partially used subscription period. This does not affect any cancellation, refund or other rights that applicable law requires.',
} as const;
