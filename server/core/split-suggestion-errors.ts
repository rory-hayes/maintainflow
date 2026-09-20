/** Application-owned diagnostics may be persisted; upstream text may not. */
export class SplitSuggestionProviderError extends Error {
 constructor(message:string,readonly permanent=true){super(message);this.name='SplitSuggestionProviderError';}
}
