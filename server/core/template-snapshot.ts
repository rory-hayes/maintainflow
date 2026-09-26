import {bankStatementWorkflow} from '../../shared/bank-statement-preset.js';
import {bankPdfLayoutVersion} from '../../shared/bank-pdf-layout.js';
import {normalizationPolicy,legacyNormalizationPolicy} from '../../shared/source-formats.js';
import {regionTemplatePolicy} from '../../shared/template-selection.js';

/** A single projection serves every intake and explicit reprocessing path. */
export function pinnedTemplateConfig(parser:any,templates:any[]){
  return {mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone,useCase:parser.use_case,
    ...(parser.use_case==='bank_statement'?{bankWorkflow:bankStatementWorkflow,bankPdfLayoutVersion}:{}),
    normalizationPolicy:parser.use_case==='bank_statement'?legacyNormalizationPolicy:normalizationPolicy,templates:(parser.use_case==='bank_statement'?[]:templates).map(template=>({id:template.id,name:template.name,match_text:template.match_text??template.matchText??'',
      enabled:template.enabled,rules:structuredClone(template.rules),created_at:template.created_at??template.createdAt,
      kind:template.kind??'text-v1',revision:template.revision??1})),templatePolicy:regionTemplatePolicy};
}
