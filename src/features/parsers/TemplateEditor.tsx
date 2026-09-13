import {useId,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Plus,Trash2} from 'lucide-react';
import {api,patch,post,useAction,useData} from '../../lib/api';
import {Button,Field,Notice,Status} from '../../components/ui';
import type {ParserSchema} from '../../../shared/types';
import {templateFieldOptions,templateLimits,templateReasonLabels,type TemplateCandidate,type TemplateFieldOption,type TemplateRule,type TemplateSelection} from '../../../shared/template-selection';

type SavedTemplate={id:string;name:string;matchText:string;enabled:boolean;rules:TemplateRule[]};
type TemplateBody=Pick<SavedTemplate,'name'|'matchText'|'enabled'|'rules'>;
type CheckResult={selection:TemplateSelection;candidates:TemplateCandidate[];availableSourceText:boolean};
type DocumentPage={documents:{id:string;name:string}[];total:number;page:number;pageSize:number};
const kindLabels={scalar:'Field',column:'Table column',table:'Table heading'};
const templateBody=(template:SavedTemplate):TemplateBody=>({name:template.name,matchText:template.matchText,enabled:template.enabled,rules:template.rules});

export default function TemplateEditor({parserId,templates,schema,mode,locale,canEdit}:{parserId:string;templates:SavedTemplate[];schema:ParserSchema;mode:'ai'|'rules';locale:string;canEdit:boolean}){
  const options=templateFieldOptions(schema);
  return <div className="template-editor">
    <header><h2>Saved text templates</h2><p>Enabled templates are checked before AI. Every configured anchor and required field must have a valid source value. The complete match with the most configured fields wins; ties use the oldest template, then its ID.</p><p className="small muted">Changes apply to new documents and explicit reprocessing. Existing jobs and runs keep their saved settings.</p></header>
    <TemplateCheck key={parserId} parserId={parserId} schema={schema} templates={templates} mode={mode} locale={locale} options={options} canEdit={canEdit}/>
    <section aria-label="Saved templates" className="template-list">
      {!templates.length&&<p className="muted">No saved templates yet. AI parsers use AI when no complete template matches. Text-anchor parsers without enabled templates use field labels.</p>}
      {templates.map(template=><TemplateCard key={template.id} template={template} parserId={parserId} options={options} canEdit={canEdit}/>)}
    </section>
    {canEdit&&<section className="panel template-create"><h3>Create a template</h3>{templates.length>=templateLimits.templates?<p role="status">This parser has reached the limit of {templateLimits.templates} templates. Delete a template before creating another.</p>:<TemplateForm parserId={parserId} options={options}/>}</section>}
  </div>;
}

function TemplateCard({template,parserId,options,canEdit}:{template:SavedTemplate;parserId:string;options:TemplateFieldOption[];canEdit:boolean}){
  const [editing,setEditing]=useState(false),action=useAction();
  return <article className="panel template-card" aria-label={`Template ${template.name}`}>
    <div className="template-card-heading"><div><h3>{template.name}</h3><p>{template.matchText?`Contains “${template.matchText}”`:'No document phrase required'} · {template.rules.length} anchor{template.rules.length===1?'':'s'}</p></div><Status value={template.enabled?'enabled':'disabled'}/></div>
    {editing?<TemplateForm parserId={parserId} options={options} initial={template} onClose={()=>setEditing(false)}/>:<>
      <details className="template-saved-anchors"><summary>View saved anchors</summary>{template.rules.length?<ul>{template.rules.map((rule,index)=>{const option=options.find(item=>item.path===rule.field);return <li key={index}><strong>{option?.label||`Unsupported field: ${rule.field}`}</strong><span>{rule.anchor}</span>{!option&&<small>This anchor needs editing before this template can be enabled.</small>}</li>;})}</ul>:<p className="small">This template has no field anchors and cannot fully match.</p>}</details>
      {canEdit&&<div className="actions template-actions"><Button type="button" variant="secondary" disabled={action.busy} onClick={()=>setEditing(true)}>Edit template</Button><Button type="button" variant="secondary" disabled={action.busy} onClick={()=>void action.run(()=>patch(`/api/templates/${template.id}`,{...templateBody(template),enabled:!template.enabled}),template.enabled?'Template disabled.':'Template enabled.')}>{template.enabled?'Disable':'Enable'}</Button><Button type="button" variant="ghost" disabled={action.busy} aria-label={`Delete template ${template.name}`} onClick={()=>void action.run(()=>api(`/api/templates/${template.id}`,{method:'DELETE'}),'Template deleted.')}><Trash2 size={17}/>Delete</Button></div>}
    </>}
    <Notice error={action.error} message={action.message}/>
  </article>;
}

function TemplateForm({parserId,options,initial,onClose}:{parserId:string;options:TemplateFieldOption[];initial?:SavedTemplate;onClose?:()=>void}){
  const [name,setName]=useState(initial?.name||''),[matchText,setMatchText]=useState(initial?.matchText||''),[enabled,setEnabled]=useState(initial?.enabled??true);
  const [rows,setRows]=useState(()=>(initial?.rules||[]).map((rule,index)=>({...rule,rowId:index})));
  const nextRow=useRef(rows.length),feedbackId=useId(),action=useAction();
  const rules=rows.map(({field,anchor})=>({field,anchor}));
  const rulesChanged=JSON.stringify(rules)!==JSON.stringify(initial?.rules||[]);
  const unsupported=rules.some(rule=>!options.some(option=>option.path===rule.field));
  const repeated=new Set(rules.map(rule=>rule.field)).size!==rules.length;
  const missing=rules.some(rule=>!rule.anchor.trim());
  const invalidRules=rules.length===0||unsupported||repeated||missing;
  const mustValidate=enabled||!initial||rulesChanged;
  const feedback=rules.length===0?'Add at least one field anchor.':unsupported?'Choose a supported field for every new anchor. Remove unsupported saved anchors explicitly before enabling or changing the anchors.':repeated?'Use each field only once. Remove or change repeated anchors.':missing?'Enter source text for every anchor.':'';
  return <form className="template-form" onSubmit={event=>{
    event.preventDefault();if(action.busy||mustValidate&&invalidRules)return;
    void action.run(async()=>{
      const body={name,matchText,enabled,rules};
      const result=initial?await patch(`/api/templates/${initial.id}`,body):await post(`/api/parsers/${parserId}/templates`,body);
      if(onClose)onClose();else{setName('');setMatchText('');setEnabled(true);setRows([]);}
      return result;
    },'Template saved. Check it against a document or reprocess a document to apply it.');
  }}>
    <fieldset disabled={action.busy} className="template-form-fields">
      <div className="form-grid"><Field label="Template name"><input required maxLength={100} value={name} onChange={event=>setName(event.target.value)}/></Field><Field label="Document contains" hint="An exact, case-sensitive phrase. Leave blank to require only the field anchors."><input maxLength={1000} value={matchText} onChange={event=>setMatchText(event.target.value)} placeholder="A supplier name or unique phrase"/></Field></div>
      <label className="template-enabled"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>Enable this template</label>
      <div className="template-anchor-intro"><h4>Field anchors</h4><p className="small muted">Choose a field and the source label to read from. Table headings must appear before the table and end with a colon or equals sign; enter the heading text without that punctuation. Column anchors match the table headers. Nested object fields and flat table columns are supported.</p></div>
      <div className="template-anchor-list">{rows.map((rule,index)=>{
        const option=options.find(item=>item.path===rule.field);
        const legacyUnsupported=Boolean(rule.field&&!option);
        return <div className="template-anchor-row" key={rule.rowId}>
          <Field label={`Field ${index+1}`} hint={option?`${kindLabels[option.kind]} · ${option.path}`:legacyUnsupported?'Unsupported saved field. Remove this row explicitly to replace it.':undefined}>
            <select value={rule.field} disabled={legacyUnsupported} onChange={event=>setRows(current=>current.map(item=>item.rowId===rule.rowId?{...item,field:event.target.value}:item))}>
              <option value="">Choose a field</option>{legacyUnsupported&&<option value={rule.field}>Unsupported field: {rule.field}</option>}{options.map(item=><option key={item.path} value={item.path}>{item.label} — {kindLabels[item.kind]}</option>)}
            </select>
          </Field>
          <Field label={`Anchor ${index+1}`}><input maxLength={200} value={rule.anchor} readOnly={legacyUnsupported} placeholder={option?.field.anchor||option?.field.label||'Source label'} onChange={event=>setRows(current=>current.map(item=>item.rowId===rule.rowId?{...item,anchor:event.target.value}:item))}/></Field>
          <Button type="button" variant="ghost" aria-label={`Remove anchor ${index+1}${legacyUnsupported?' (unsupported field)':''}`} onClick={()=>setRows(current=>current.filter(item=>item.rowId!==rule.rowId))}><Trash2 size={17}/><span>Remove</span></Button>
        </div>;
      })}</div>
      <Button type="button" variant="secondary" disabled={!options.length||rows.length>=templateLimits.rules} onClick={()=>{const rowId=nextRow.current++;setRows(current=>[...current,{rowId,field:'',anchor:''}]);}}><Plus size={17}/>Add field anchor</Button>
      {!options.length&&<p className="small" role="status">Add supported fields in the Fields tab before creating anchors.</p>}
      {rows.length>=templateLimits.rules&&<p className="small">A template can have up to {templateLimits.rules} anchors.</p>}
      <p id={feedbackId} className="small template-feedback" role={invalidRules&&rows.length?'status':undefined}>{feedback||'All configured anchors must match source values. Defaults do not count as a match.'}</p>
      <div className="actions template-actions"><Button type="submit" aria-describedby={feedbackId} disabled={mustValidate&&invalidRules}>{action.busy?'Saving…':initial?'Save changes':'Save template'}</Button>{onClose&&<Button type="button" variant="secondary" onClick={onClose}>Cancel editing</Button>}</div>
    </fieldset>
    <Notice error={action.error} message={action.message}/>
  </form>;
}

function TemplateCheck({parserId,schema,templates,mode,locale,options,canEdit}:{parserId:string;schema:ParserSchema;templates:SavedTemplate[];mode:'ai'|'rules';locale:string;options:TemplateFieldOption[];canEdit:boolean}){
  const [page,setPage]=useState(1),[documentId,setDocumentId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const running=useRef(false);
  const [result,setResult]=useState<{documentId:string;signature:string;check:CheckResult}|null>(null);
  const documents=useData<DocumentPage>(`/api/parsers/${parserId}/documents?page=${page}&pageSize=20`);
  const signature=JSON.stringify({schema,templates,mode,locale});
  const stale=Boolean(result&&(result.signature!==signature||result.documentId!==documentId));
  async function check(){
    if(!documentId||running.current)return;running.current=true;setBusy(true);setError('');setResult(null);
    try{const response=await post<CheckResult>(`/api/parsers/${parserId}/templates/check`,{documentId});setResult({documentId,signature,check:response});}
    catch(cause){setError(cause instanceof Error?cause.message:'The templates could not be checked.');}
    finally{running.current=false;setBusy(false);}
  }
  return <section className="panel template-check" aria-label="Check saved templates">
    <h3>Check saved templates</h3><p>See which template would be selected for a document using the current saved fields and templates. Unsaved edits are excluded. This check does not run AI, save an extraction result or use page credits.</p>
    {documents.isPending?<p role="status">Loading documents…</p>:documents.error?<><Notice error={documents.error instanceof Error?documents.error.message:'Documents could not be loaded.'}/><Button type="button" variant="secondary" onClick={()=>void documents.refetch()}>Retry loading documents</Button></>:documents.data&&<>
      {documents.data.total===0?<p>No documents are available to check.{canEdit&&<> <Link className="link" to={`/app/parsers/${parserId}?tab=documents`}>Add a document</Link>.</>}</p>:<>
        <div className="template-check-controls"><Field label="Document to check"><select disabled={busy} value={documentId} onChange={event=>{setDocumentId(event.target.value);setResult(null);setError('');}}><option value="">Choose a document</option>{documents.data.documents.map(document=><option key={document.id} value={document.id}>{document.name}</option>)}</select></Field><Button type="button" disabled={!documentId||busy} onClick={()=>void check()}>{busy?'Checking…':'Check templates'}</Button></div>
        {documents.data.total>20&&<div className="actions template-pagination"><Button type="button" variant="ghost" disabled={page<=1||busy} onClick={()=>{setPage(current=>current-1);setDocumentId('');setResult(null);}}>Previous documents</Button><span className="small">Page {page} of {Math.ceil(documents.data.total/20)}</span><Button type="button" variant="ghost" disabled={page*20>=documents.data.total||busy} onClick={()=>{setPage(current=>current+1);setDocumentId('');setResult(null);}}>Next documents</Button></div>}
      </>}
    </>}
    <Notice error={error}/>{busy&&<p role="status">Checking saved templates against this document…</p>}
    {stale&&<p role="status">Saved settings changed. Check templates again to see the current selection.</p>}
    {result&&!stale&&!busy&&<div className="template-check-result" role="status"><PreviewSelection selection={result.check.selection}/>{!result.check.availableSourceText&&<p>This document has no readable source text for template matching.</p>}{result.check.candidates.length>0&&<ul className="template-candidates">{result.check.candidates.map((candidate,index)=>{
      const selected=candidate.matched&&result.check.selection.template?.id===candidate.id;
      return <li key={candidate.id||index} className={selected?'selected':''}><div className="template-candidate-heading"><strong>{candidate.name}</strong><span className="small">{selected?'Selected':candidate.matched?'Complete match':'Not a complete match'}</span></div><p className="small">{candidate.matchedFields} of {candidate.fieldCount} configured field{candidate.fieldCount===1?'':'s'} matched</p>{candidate.reasons.map(reason=><p className="small" key={reason}>{templateReasonLabels[reason]||'This template could not be matched.'}</p>)}{candidate.unmatchedFields.length>0&&<p className="small">Check fields: {candidate.unmatchedFields.map(path=>options.find(option=>option.path===path)?.label||path).join(', ')}</p>}</li>;
    })}</ul>}<Link className="link small" to={`/app/documents/${result.documentId}`}>Open the source document</Link></div>}
  </section>;
}

function PreviewSelection({selection}:{selection:TemplateSelection}){
  if(selection.outcome==='template'&&selection.template)return <><h4>Would use text template: {selection.template.name}</h4><p>{selection.template.fieldCount} configured field{selection.template.fieldCount===1?'':'s'} matched. AI would not be used.{selection.template.tieCount>1&&` ${selection.template.tieCount} complete templates tied on field count; the oldest template wins, then its ID.`}</p></>;
  if(selection.outcome==='rules')return <><h4>Would use field-label rules</h4><p>No enabled templates are saved for this parser.</p></>;
  const reason=selection.reason==='no_templates'?'There are no enabled templates.':selection.reason==='no_readable_text'?'Template matching needs readable source text.':selection.reason==='limit'?'This document or template set exceeds the supported check limits.':'No enabled template is a complete match.';
  return <><h4>{selection.outcome==='ai'?'Would fall back to AI':'No template can be used'}</h4><p>{reason} {selection.outcome==='ai'?'Extraction requires an available AI provider.':'Edit the templates or parser fields before reprocessing.'}</p></>;
}
