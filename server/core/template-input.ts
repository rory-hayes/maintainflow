import {z} from 'zod';
import {templateLimits} from '../../shared/template-selection.js';
import {pdfRegionRuleSchema} from '../../shared/pdf-regions.js';
import {canonicalTemplateDefinition,templateDefinitionLimits,type TemplateDefinition} from '../../shared/template-definitions.js';

const common={name:z.string().trim().min(1).max(100),matchText:z.string().max(1000).default(''),enabled:z.boolean().default(true)};
const textDefinition=z.object({...common,kind:z.literal('text-v1').default('text-v1'),rules:z.array(z.object({field:z.string().max(259),anchor:z.string().min(1).max(200)}).strict()).max(templateLimits.rules)}).strict();
const regionDefinition=z.object({...common,kind:z.literal('native-pdf-region-v1'),rules:z.array(pdfRegionRuleSchema).max(templateLimits.rules)}).strict();
function boundedDefinition(value:TemplateDefinition,context:z.RefinementCtx){
  const limit=value.kind==='text-v1'?templateDefinitionLimits.legacyTextDefinitionBytes:templateDefinitionLimits.definitionBytes;
  if(Buffer.byteLength(canonicalTemplateDefinition(value))>limit)
    context.addIssue({code:'custom',message:'This template exceeds the supported definition size. Use fewer or shorter field rules.'});
}
export const templateDefinitionInput=z.union([regionDefinition,textDefinition]).superRefine(boundedDefinition);
const mutation={requestId:z.string().uuid().optional(),baseSchemaId:z.string().uuid().optional(),baseRevision:z.number().int().min(1).max(2_147_483_646).optional()};
export const templateBody=z.union([regionDefinition.extend(mutation),textDefinition.extend(mutation)]).superRefine(boundedDefinition);
export {canonicalTemplateDefinition};
