import type {TemplateSelection} from '../../../shared/template-selection';
import type {TemplateDefinitionSnapshot} from '../../../shared/template-definitions';

export default function RunSelection({selection,templateSnapshot}:{selection?:TemplateSelection|null;templateSnapshot?:TemplateDefinitionSnapshot|null}){
  if(!selection)return <p className="small muted">Template selection was not recorded for this run.</p>;
  const reason=selection.reason==='no_templates'?'No enabled templates were saved for this run.':selection.reason==='no_readable_text'?'The document had no readable source text for template matching.':selection.reason==='limit'?'The saved template check exceeded the supported size limits.':'No enabled template was a complete match.';
  return <section className="run-selection" aria-label="Recorded template selection">
    {selection.outcome==='template'&&selection.template?<><strong>{selection.template.kind==='native-pdf-region-v1'?'Native PDF region template':'Text template'}: {selection.template.name}</strong><p>{selection.template.fieldCount} configured field{selection.template.fieldCount===1?'':'s'} matched. AI was not used for this extraction.</p>{selection.template.tieCount>1&&<p>{selection.template.tieCount} complete templates tied on field count. The oldest template won, then its ID.</p>}</>:<><strong>{selection.outcome==='ai'?'AI fallback':selection.outcome==='rules'?'Field-label rules':'Template matching failed'}</strong><p>{reason}</p></>}
    {selection.template?.kind==='native-pdf-region-v1'&&<p className="small muted">Saved template revision {selection.template.revision}. Native text regions were matched using {selection.template.geometryVersion}. No OCR was used.</p>}
    {templateSnapshot?.template.kind==='native-pdf-region-v1'&&<details className="run-template-snapshot"><summary>Inspect the saved native region definition</summary><p>This is the exact definition pinned to this run. Later template edits or deletion do not change it.</p><p>Template ID: {templateSnapshot.template.id} · Revision {templateSnapshot.template.revision}</p><p>Definition digest: {templateSnapshot.definitionDigest}</p><pre>{JSON.stringify(templateSnapshot.template,null,2)}</pre></details>}
    <p className="small muted">Recorded from this run’s saved settings · Matching policy: {selection.policy}</p>
  </section>;
}
