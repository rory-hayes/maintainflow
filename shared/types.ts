export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export type FieldType = 'string' | 'number' | 'currency' | 'date' | 'boolean' | 'multiline' | 'array' | 'object';
export interface SchemaField { key: string; label: string; type: FieldType; required?: boolean; instructions?: string; default?: unknown; transform?: 'trim' | 'uppercase' | 'lowercase'; fields?: SchemaField[]; anchor?: string; enum?: string[]; }
export interface ParserSchema { fields: SchemaField[]; }
export interface Evidence { page: number; text: string; source?: 'matched-text' | 'model-visual'; }
export interface ValidationIssue { field: string; code: string; message: string; }
export interface Actor { userId: string; workspaceId: string; role: Role; authType: 'session' | 'api'; scopes?: string[]; }
export type DocumentStatus = 'received'|'queued'|'processing'|'needs_review'|'processed'|'exporting'|'exported'|'failed';
export interface PageText { page: number; text: string; }
export interface ExtractionResult { rawValues: Record<string, unknown>; normalizedValues: Record<string, unknown>; evidence: Record<string, Evidence[]>; issues: ValidationIssue[]; model: string; engine: string; promptVersion?: string; tokenUsage?: unknown; costUsd?: number; }
export interface ProviderInput { bytes: Buffer; mimeType: string; pages: PageText[]; schema: ParserSchema; instructions: string; locale: string; signal?: AbortSignal; }
export interface ExtractionProvider { configured(): boolean; extract(input: ProviderInput): Promise<ExtractionResult>; }
