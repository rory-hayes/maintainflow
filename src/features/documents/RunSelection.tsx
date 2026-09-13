import type {TemplateSelection} from '../../../shared/template-selection';

export default function RunSelection({selection}:{selection?:TemplateSelection|null}){
  if(!selection)return <p className="small muted">Template selection was not recorded for this run.</p>;
  const reason=selection.reason==='no_templates'?'No enabled templates were saved for this run.':selection.reason==='no_readable_text'?'The document had no readable source text for template matching.':selection.reason==='limit'?'The saved template check exceeded the supported size limits.':'No enabled template was a complete match.';
  return <section className="run-selection" aria-label="Recorded template selection">
    {selection.outcome==='template'&&selection.template?<><strong>Text template: {selection.template.name}</strong><p>{selection.template.fieldCount} configured field{selection.template.fieldCount===1?'':'s'} matched. AI was not used for this extraction.</p>{selection.template.tieCount>1&&<p>{selection.template.tieCount} complete templates tied on field count. The oldest template won, then its ID.</p>}</>:<><strong>{selection.outcome==='ai'?'AI fallback':selection.outcome==='rules'?'Field-label rules':'Template matching failed'}</strong><p>{reason}</p></>}
    <p className="small muted">Recorded from this run’s saved settings · Matching policy: {selection.policy}</p>
  </section>;
}
