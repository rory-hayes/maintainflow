import type {PageText,ParserSchema} from './types';

export const schemaSuggestionLimits=Object.freeze({perDay:10,pendingPerWorkspace:3,maxAttempts:3,maxFields:60,maxDepth:4});
export type SchemaSuggestionState='queued'|'processing'|'ready'|'failed';
export interface SchemaSuggestionInput {bytes:Buffer;mimeType:string;pages:PageText[];locale:string;signal?:AbortSignal;}
export interface SchemaSuggestionResult {schema:ParserSchema;model:string;promptVersion:string;tokenUsage:Record<string,unknown>;costUsd:number;}
export interface SchemaSuggestionProvider {configured():boolean;suggest(input:SchemaSuggestionInput):Promise<SchemaSuggestionResult>;}
export interface SchemaSuggestion {
 id:string;parserId:string;documentId:string;documentName:string;baseSchemaId:string;
 state:SchemaSuggestionState;attempts:number;maxAttempts:number;createdAt:string;updatedAt:string;
 schema:ParserSchema|null;error:string|null;model:string|null;promptVersion:string|null;
 costUsd:number;tokenUsage:Record<string,unknown>;appliedSchemaId:string|null;
}
