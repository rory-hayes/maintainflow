/** Minimal operational estimates, never document content or a provider invoice. */
export type AIUsageKind='extraction'|'schema_suggestion'|'split_suggestion';
export type AIUsageState='unknown'|'reported_unpriced'|'reported_priced';
export interface AIUsageObservation {
 model:string|null;requestId:string|null;responseId:string|null;httpStatus:number;
 responseStatus:'completed'|'incomplete'|'failed'|'cancelled'|'queued'|'in_progress'|'unknown';
 usageState:AIUsageState;inputTokens:number|null;cachedInputTokens:number|null;
 outputTokens:number|null;reasoningTokens:number|null;costUsd:number|null;pricingBasis:string|null;
}
export interface AIUsageObserver {
 /** Fails closed before dispatch. The returned UUID joins a successful result. */
 start():Promise<string>;
 /** Post-dispatch recording must never turn processing success into a paid retry. */
 observe(value:AIUsageObservation):Promise<void>;
 /** Called in the worker finally, after its processing/result fence. */
 finish():Promise<void>;
}
