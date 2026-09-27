export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export type FieldType = 'string' | 'number' | 'currency' | 'date' | 'timestamp' | 'boolean' | 'multiline' | 'array' | 'object';
export interface SchemaField { key: string; label: string; type: FieldType; timezone?: string; sourceLocale?:import('./source-formats.js').SourceLocale; required?: boolean; instructions?: string; default?: unknown; transform?: 'trim' | 'uppercase' | 'lowercase'; fields?: SchemaField[]; anchor?: string; enum?: string[]; }
export interface ParserSchema { fields: SchemaField[]; }
export interface Evidence { page: number; text: string; source?: 'matched-text' | 'model-visual' | 'matched-region'; derivation?:import('./bank-evidence.js').NativeDescriptionDerivation; region?: {version:string;sourceSha256:string;rect:{x:number;y:number;width:number;height:number};anchor:{text:string;capturedText:string;rect:{x:number;y:number;width:number;height:number};itemIds:number[]};itemIds:number[]}; }
export interface ValidationIssue { field: string; code: string; message: string; }
export interface Actor { userId: string; workspaceId: string; role: Role; authType: 'session' | 'api'; scopes?: string[]; }
export type DocumentStatus = 'received'|'queued'|'processing'|'needs_review'|'processed'|'exporting'|'exported'|'failed';
export interface PageText { page: number; text: string; }
export interface ExtractionResult { rawValues: Record<string, unknown>; normalizedValues: Record<string, unknown>; evidence: Record<string, Evidence[]>; issues: ValidationIssue[]; model: string; engine: string; promptVersion?: string; tokenUsage?: unknown; costUsd?: number; templateSnapshot?:import('./template-definitions.js').TemplateDefinitionSnapshot; }
export interface VisualDocument {bytes:Buffer;mimeType:'application/pdf';pageCount:number;sourceSha256:string;renderVersion:string;}
export interface ProviderInput { bytes: Buffer; mimeType: string; pages: PageText[]; schema: ParserSchema; instructions: string; locale: string; timezone?: string; normalizationPolicy?:import('./source-formats.js').NormalizationPolicy; signal?: AbortSignal; visualDocument?:VisualDocument; bankPdfLayout?:import('./bank-pdf-layout.js').BankPdfLayoutInput; }
export interface ExtractionProvider { configured(): boolean; extract(input: ProviderInput): Promise<ExtractionResult>; }
