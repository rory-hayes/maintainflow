import {useId,useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {Plus,Layers3,ChevronRight,Archive,RotateCcw} from 'lucide-react';
import {useData,useAction,patch} from '../../lib/api';
import {useSession} from '../../lib/session';
import {useAiAvailability} from '../../lib/ai';
import {PageHeader,Loading,ErrorState,Empty,Button,Notice,Tabs,Field,Status} from '../../components/ui';
import SchemaEditor from './SchemaEditor';
import ParserSetup from './ParserSetup';
import TemplateEditor from './TemplateEditor';
import CopyParser from './CopyParser';
import Documents from '../documents/Documents';
import Upload from '../documents/Upload';
import {sourceFormats,type SourceFormat} from '../../../shared/source-formats';
export default function Parsers(){
  const {data,isPending,error,refetch}=useData('/api/parsers');const [params,setParams]=useSearchParams();const archived=params.get('view')==='archived';const setArchived=(value:boolean)=>setParams(current=>{const next=new URLSearchParams(current);next.set('view',value?'archived':'active');return next;},{replace:true});const action=useAction();const canEdit=useSession().data?.workspace.role!=='viewer';
  if(isPending)return <Loading/>;if(error)return <ErrorState error={error} retry={()=>void refetch()}/>;
  const parsers=data.parsers.filter((p:any)=>p.archived===archived);
  return <><PageHeader title="Parsers" description="A home for every kind of document.">{canEdit&&<Link className="button primary" to="/app/parsers/new"><Plus size={18}/>Create parser</Link>}</PageHeader><Tabs items={['Active','Archived']} value={archived?'Archived':'Active'} onChange={v=>setArchived(v==='Archived')}/><Notice error={action.error} message={action.message}/>{parsers.length?<div className="parser-list">{parsers.map((parser:any)=><div className="parser-row" key={parser.id}><div className="parser-icon"><Layers3 size={24} strokeWidth={1.5}/></div><Link className="parser-row-info" to={`/app/parsers/${parser.id}`}><h3>{parser.name}</h3><p>{parser.mode==='rules'?'Text-anchor rules':'AI extraction'} · {parser.locale}</p></Link><div className="parser-count"><strong>{parser.documentCount}</strong><span>documents</span></div>{parser.reviewCount>0&&<span className="status needs_review">{parser.reviewCount} to review</span>}<CopyParser parser={parser} canEdit={canEdit} compact/>{canEdit&&<button className="icon-button" aria-label={archived?`Restore ${parser.name}`:`Archive ${parser.name}`} onClick={()=>void action.run(()=>patch(`/api/parsers/${parser.id}`,{archived:!archived}),archived?'Parser restored.':'Parser archived.')} >{archived?<RotateCcw size={17}/>:<Archive size={17}/>}</button>}<Link to={`/app/parsers/${parser.id}`} aria-label={`Open ${parser.name}`}><ChevronRight size={20}/></Link></div>)}</div>:<Empty title={archived?'No archived parsers.':'Choose what you want to extract.'} description={archived?'Archived parsers will appear here.':'Create an invoice, receipt, purchase-order, lead-email or custom parser.'}>{!archived&&canEdit&&<Link className="button primary" to="/app/parsers/new">Create a parser</Link>}</Empty>}</>;
}
export function ParserDetail(){
  const {id}=useParams();const [params,setParams]=useSearchParams();const result=useData(`/api/parsers/${id}`);const canEdit=useSession().data?.workspace.role!=='viewer';
  if(result.isPending)return <Loading/>;if(result.error)return <ErrorState error={result.error} retry={()=>void result.refetch()}/>;
  const {parser,schema,templates}=result.data;
  const tabLabels:Record<string,string>={setup:'Setup','add-document':'Add a document',documents:'Documents',fields:'Fields',templates:'Templates',settings:'Settings'};
  const tab=tabLabels[params.get('tab')||'']||(params.get('onboarding')?'Add a document':'Documents');
  const setTab=(value:string)=>setParams(current=>{const next=new URLSearchParams(current);next.set('tab',Object.entries(tabLabels).find(([,label])=>label===value)?.[0]||'documents');return next;},{replace:true});
  const setupPending=Boolean(parser.fieldSetupState&&parser.fieldSetupState!=='ready'),hasSetup=setupPending||Boolean(parser.fieldSetupSuggestionId)||tab==='Setup';
  const items=[...(hasSetup?['Setup']:[]),...(params.get('onboarding')||tab==='Add a document'?['Add a document']:[]),'Documents','Fields','Templates','Settings'];
  return <><PageHeader title={parser.name} description="Choose what this parser extracts."><Button variant="secondary" onClick={()=>setTab('Fields')}>{canEdit?'Edit fields':'View fields'}</Button><CopyParser key={parser.id} parser={parser} canEdit={canEdit}/>{parser.archived&&<Status value="archived"/>}</PageHeader><Tabs items={items} value={tab} onChange={setTab}/>
    {(tab==='Setup'||setupPending&&tab!=='Fields')&&<ParserSetup key={parser.id} parserId={id!} canEdit={canEdit} archived={parser.archived} onEditFields={()=>setTab('Fields')} onAddSample={()=>setTab('Add a document')} onSettings={()=>setTab('Settings')} showAddSampleAction={tab!=='Add a document'}/>}
    {tab==='Add a document'&&<div className="onboarding"><h2>{setupPending?(parser.fieldSetupState==='failed'?'Upload another sample.':'Add your sample document.'):'Add your first document.'}</h2><p>{setupPending?(parser.fieldSetupState==='failed'?'After uploading, open Setup and select the new sample to retry.':'Upload one representative sample. The first accepted sample defines the initial fields for all waiting documents.'):'Try the synthetic sample to see a complete extraction, review and export workflow.'}</p><Upload parserId={id} compact/>{!setupPending&&<div className="schema-suggestion-discover"><p>After uploading, suggest fields from your document or edit them yourself.</p><Button variant="secondary" onClick={()=>setTab('Fields')}>Choose fields</Button></div>}</div>}
    {tab==='Documents'&&<Documents parserId={id} embedded/>}{tab==='Fields'&&<SchemaEditor key={parser.id} parserId={id!} schema={schema} canEdit={canEdit} archived={parser.archived} setupPending={setupPending} onOpenSettings={()=>setTab('Settings')} onUploadDocument={()=>setTab(params.get('onboarding')?'Add a document':'Documents')}/>} {tab==='Templates'&&<TemplateEditor parserId={id!} templates={templates} schema={schema} mode={parser.mode} locale={parser.locale} canEdit={canEdit}/>} {tab==='Settings'&&<ParserSettings key={JSON.stringify(parser)} parser={parser} canEdit={canEdit}/>}</>;
}
function ParserSettings({parser,canEdit}:{parser:any;canEdit:boolean}){
  const [form,setForm]=useState({name:parser.name,mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone});
  const [formatMode,setFormatMode]=useState<'all'|'choose'>(parser.allowedFormats==null?'all':'choose');
  const [selectedFormats,setSelectedFormats]=useState<SourceFormat[]>(parser.allowedFormats??[]);
  const formatFeedbackId=useId();const action=useAction(),ai=useAiAvailability();
  const emptyFormats=formatMode==='choose'&&selectedFormats.length===0;
  const allowedFormats=formatMode==='all'?null:sourceFormats.filter(format=>selectedFormats.includes(format.id)).map(format=>format.id);
  const originalFormats=parser.allowedFormats==null?null:sourceFormats.filter(format=>parser.allowedFormats.includes(format.id)).map(format=>format.id);
  const formatsChanged=JSON.stringify(allowedFormats)!==JSON.stringify(originalFormats);
  return <form className="settings-form" onSubmit={e=>{
    e.preventDefault();if(!canEdit||action.busy||emptyFormats)return;
    void action.run(()=>patch(`/api/parsers/${parser.id}`,{...form,...(formatsChanged?{allowedFormats}:{})}),'Parser settings saved.');
  }}>
    <div className="form-grid">
      <Field label="Parser name"><input disabled={!canEdit} required maxLength={100} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
      <Field label="Extraction mode" hint={ai.message}><select disabled={!canEdit} value={form.mode} onChange={e=>setForm({...form,mode:e.target.value})}><option value="rules">Text-anchor rules</option><option value="ai" disabled={ai.configured!==true}>{ai.optionLabel}</option></select></Field>
      <Field label="Locale" hint="Sets how dates and numbers are read, including day/month order and decimal separators."><select disabled={!canEdit} value={form.locale} onChange={e=>setForm({...form,locale:e.target.value})}>{['en-IE','en-US','en-GB','de-DE','fr-FR','es-ES'].map(v=><option key={v}>{v}</option>)}</select></Field>
      <Field label="Timezone" hint="Saved with this parser. Date fields keep the written calendar date; timestamp and timezone conversion are not supported."><select disabled={!canEdit} value={form.timezone} onChange={e=>setForm({...form,timezone:e.target.value})}>{['Europe/Dublin','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Asia/Singapore','UTC'].map(v=><option key={v}>{v}</option>)}</select></Field>
    </div>
    <Field label="Extraction instructions" hint="These instructions guide AI extraction. AI mode sends document content to the configured AI provider. Text-anchor rules use labels, anchors and templates instead."><textarea disabled={!canEdit} rows={4} maxLength={8000} value={form.instructions} onChange={e=>setForm({...form,instructions:e.target.value})}/></Field>
    <Field label="Accepted formats" hint="Choose the file formats this parser can receive.">
      <select disabled={!canEdit||action.busy} value={formatMode} onChange={event=>setFormatMode(event.target.value as 'all'|'choose')}>
        <option value="all">All supported formats</option><option value="choose">Choose formats</option>
      </select>
    </Field>
    {formatMode==='choose'&&<fieldset className="panel" disabled={!canEdit||action.busy} aria-describedby={formatFeedbackId} style={{margin:0,marginBottom:18,minWidth:0}}>
      <legend style={{fontSize:14,fontWeight:500,padding:'0 6px'}}>Choose formats</legend>
      <div className="form-grid">{sourceFormats.map(format=><label key={format.id} style={{display:'flex',alignItems:'center',gap:10,fontSize:13,minHeight:44}}>
        <input type="checkbox" checked={selectedFormats.includes(format.id)} onChange={event=>{
          const checked=event.target.checked;
          setSelectedFormats(current=>checked?[...current,format.id]:current.filter(id=>id!==format.id));
        }}/><span>{format.label}</span>
      </label>)}</div>
      <p id={formatFeedbackId} className="small" role={emptyFormats?'alert':undefined} style={{margin:0}}>{emptyFormats?'Choose at least one format before saving.':`${selectedFormats.length} format${selectedFormats.length===1?'':'s'} selected.`}</p>
    </fieldset>}
    <Notice error={action.error} message={action.message}/>
    <Button disabled={!canEdit||action.busy||emptyFormats||(form.mode==='ai'&&ai.configured!==true)}>Save settings</Button>
  </form>;
}
