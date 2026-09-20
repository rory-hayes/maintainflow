import type {TemplateRule} from './template-selection.js';
import type {PdfRegionRule} from './pdf-regions.js';

export type TemplateKind = 'text-v1' | 'native-pdf-region-v1';
interface TemplateDefinitionBase { name:string; matchText:string; enabled:boolean; }
export type TemplateDefinition = TemplateDefinitionBase & (
  {kind:'text-v1';rules:TemplateRule[]} | {kind:'native-pdf-region-v1';rules:PdfRegionRule[]}
);
export type SavedTemplate = TemplateDefinition & {id:string;revision:number;createdAt?:string};
// Text definitions retain the pre-region per-field contract, including escaped
// characters in disabled legacy rules. Native regions keep their tighter cap.
export const templateDefinitionLimits=Object.freeze({definitionBytes:65_536,snapshotBytes:73_728,legacyTextDefinitionBytes:524_288,legacyTextSnapshotBytes:532_480});

export interface TemplateMutation {
  requestId:string;
  state:'accepted'|'closed';
  operation:'create'|'update'|'delete'|null;
  templateId:string|null;
  acceptedRevision:number|null;
  currentRevision:number|null;
  deleted:boolean;
  replayed:boolean;
}
export interface TemplateMutationResult {mutation:TemplateMutation;template:SavedTemplate|null;}
export interface TemplateDefinitionSnapshot {
  version:'folio-template-snapshot-v1';
  definitionDigest:string;
  template:TemplateDefinition & {id:string|null;revision:number};
  geometryVersion?:string;
}

/** Stable field order makes identity independent of JSONB's object-key order. */
export function canonicalTemplateDefinition(definition:TemplateDefinition):string {
  const rules=definition.kind==='native-pdf-region-v1'
    ?definition.rules.map(rule=>({field:rule.field,anchor:rule.anchor,page:rule.page,
      reference:{width:rule.reference.width,height:rule.reference.height,rotation:rule.reference.rotation},
      offset:{x:rule.offset.x,y:rule.offset.y,width:rule.offset.width,height:rule.offset.height}}))
    :definition.rules.map(rule=>({field:rule.field,anchor:rule.anchor}));
  return JSON.stringify({kind:definition.kind,name:definition.name,matchText:definition.matchText,enabled:definition.enabled,rules});
}
