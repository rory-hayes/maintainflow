/** Only application-owned provider messages are safe for persisted diagnostics. */
export class SchemaSuggestionProviderError extends Error {
  constructor(message:string,readonly permanent=true){super(message);this.name='SchemaSuggestionProviderError';}
}
