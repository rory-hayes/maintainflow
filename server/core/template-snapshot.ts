import {timestampPolicy} from './timestamps.js';
import {regionTemplatePolicy} from '../../shared/template-selection.js';

/** A single projection serves every intake and explicit reprocessing path. */
export function pinnedTemplateConfig(parser:any,templates:any[]){
  return {mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone,
    normalizationPolicy:timestampPolicy,templates:templates.map(template=>({id:template.id,name:template.name,match_text:template.match_text??template.matchText??'',
      enabled:template.enabled,rules:structuredClone(template.rules),created_at:template.created_at??template.createdAt,
      kind:template.kind??'text-v1',revision:template.revision??1})),templatePolicy:regionTemplatePolicy};
}
