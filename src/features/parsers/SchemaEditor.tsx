import {useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {Plus,Trash2,ArrowUp,ArrowDown,ChevronRight} from 'lucide-react';
import type {SchemaField,FieldType} from '../../../shared/types';
import type {SchemaSuggestion} from '../../../shared/schema-suggestions';
import {Button,Modal,Notice} from '../../components/ui';
import {api,ApiError,post,useAction,workspaceId} from '../../lib/api';
import SchemaSuggestions,{fieldTypeLabels} from './SchemaSuggestions';
import './schema-editor.css';

const fieldTypes=fieldTypeLabels;
const isNested=(type:FieldType)=>type==='array'||type==='object';
function newKey(fields:SchemaField[]){let number=fields.length+1;while(fields.some(field=>field.key===`field_${number}`))number++;return `field_${number}`;}
function initialDefault(type:FieldType):unknown{return type==='boolean'?false:type==='number'||type==='currency'?0:type==='array'?[]:type==='object'?{}:type==='date'?new Date().toISOString().slice(0,10):'';}
function optionSummary(field:SchemaField){
  return [field.anchor&&`Anchor: ${field.anchor}`,field.instructions&&'Instructions set',field.default!==undefined&&'Default set',field.enum?.length&&`${field.enum.length} allowed choice${field.enum.length===1?'':'s'}`,['string','multiline'].includes(field.type)&&field.transform&&field.transform!=='trim'&&field.transform].filter(Boolean).join(' · ');
}

function DefaultEditor({field,onChange,disabled}:{field:SchemaField;onChange:(value:unknown)=>void;disabled:boolean}){
  const [draft,setDraft]=useState(()=>isNested(field.type)?JSON.stringify(field.default,null,2):String(field.default??''));
  // Field keys distinguish reordered fields; typing retains its own draft and native validity.
  useEffect(()=>{setDraft(isNested(field.type)?JSON.stringify(field.default,null,2):String(field.default??''));},[field.key,field.type]);
  if(field.type==='boolean')return <label>Default value<select disabled={disabled} value={String(field.default)} onChange={event=>onChange(event.target.value==='true')}><option value="false">No</option><option value="true">Yes</option></select></label>;
  if(isNested(field.type))return <label className="schema-default-json">Default value (JSON)<textarea disabled={disabled} required rows={3} value={draft} onChange={event=>{
    setDraft(event.target.value);
    try{const value:unknown=JSON.parse(event.target.value);if(field.type==='array'?!Array.isArray(value):!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Enter a JSON ${field.type==='array'?'array':'object'}.`);event.target.setCustomValidity('');onChange(value);}catch(error){event.target.setCustomValidity(error instanceof SyntaxError?'Enter valid JSON.':error instanceof Error?error.message:'Enter a valid default.');}
  }}/></label>;
  return <label>Default value<input disabled={disabled} type={field.type==='date'?'date':field.type==='number'||field.type==='currency'?'number':'text'} step={field.type==='number'||field.type==='currency'?'any':undefined} required={field.type==='number'||field.type==='currency'||field.type==='date'} value={draft} onChange={event=>{setDraft(event.target.value);onChange(field.type==='number'||field.type==='currency'?(event.target.value===''?null:Number(event.target.value)):event.target.value);}}/></label>;
}

function AllowedChoicesEditor({field,onChange,disabled}:{field:SchemaField;onChange:(values:string[]|undefined)=>void;disabled:boolean}){
  const [draft,setDraft]=useState(()=>(field.enum||[]).join('\n'));
  useEffect(()=>{setDraft((field.enum||[]).join('\n'));},[field.key,field.type]);
  return <label className="schema-choices">Allowed choices<textarea disabled={disabled} rows={3} aria-label={`Allowed choices for ${field.label}`} placeholder={'Pending\nApproved\nDeclined'} value={draft} onChange={event=>{
    const text=event.target.value;setDraft(text);
    const choices=[...new Set(text.split(/\r?\n/).map(value=>value.trim()).filter(Boolean))];
    const error=choices.length>100?'Use 100 choices or fewer.':choices.some(value=>value.length>500)?'Each choice must be 500 characters or fewer.':'';
    event.target.setCustomValidity(error);
    if(!error)onChange(choices.length?choices:undefined);
  }}/><span className="small muted">One choice per line, up to 100. Leave blank to allow any text. Choices must match the normalized value, including capitalization.</span></label>;
}

export function FieldRows({fields,onChange,disabled=false,depth=0}:{fields:SchemaField[];onChange:(values:SchemaField[])=>void;disabled?:boolean;depth?:number}){
  function update(index:number,patch:Partial<SchemaField>){onChange(fields.map((field,i)=>i===index?{...field,...patch}:field));}
  function move(index:number,direction:number){const next=[...fields];[next[index],next[index+direction]]=[next[index+direction],next[index]];onChange(next);}
  const limit=depth?30:60;
  return <div className="schema-editor">{fields.map((field,index)=><div className="schema-field" key={index}>
    <div className="schema-field-top"><label>Field key<input disabled={disabled} required pattern="[a-zA-Z][a-zA-Z0-9_]{0,63}" title="Start with a letter; use only letters, numbers and underscores." maxLength={64} value={field.key} onChange={event=>update(index,{key:event.target.value})}/></label><label>Label<input disabled={disabled} required maxLength={120} value={field.label} onChange={event=>update(index,{label:event.target.value})}/></label><label>Type<select disabled={disabled} value={field.type} onChange={event=>{const type=event.target.value as FieldType;update(index,{type,default:undefined,enum:['string','multiline'].includes(type)?field.enum:undefined,fields:isNested(type)?field.fields||[{key:'description',label:'Description',type:'string',anchor:'Description'}]:undefined});}}>{Object.entries(fieldTypes).filter(([type])=>depth<3||!isNested(type as FieldType)).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label className="required"><input disabled={disabled} type="checkbox" checked={Boolean(field.required)} onChange={event=>update(index,{required:event.target.checked})}/>Required</label><div className="schema-field-actions" role="group" aria-label={`Field ${index+1} actions`}><button type="button" disabled={disabled||index===0} className="icon-button" aria-label={`Move ${field.label||'field'} up`} onClick={()=>move(index,-1)}><ArrowUp size={16}/></button><button type="button" disabled={disabled||index===fields.length-1} className="icon-button" aria-label={`Move ${field.label||'field'} down`} onClick={()=>move(index,1)}><ArrowDown size={16}/></button><button type="button" disabled={disabled||fields.length===1} aria-label={`Remove ${field.label||'field'}`} className="icon-button" onClick={()=>onChange(fields.filter((_,i)=>i!==index))}><Trash2 size={17}/></button></div></div>
    <details className="schema-advanced" onInvalidCapture={event=>{event.currentTarget.open=true;}}>
    <summary><ChevronRight size={15} aria-hidden="true"/><span>Extraction options<span className="sr-only"> for {field.label||`field ${index+1}`}</span></span><span className="schema-options-summary">{optionSummary(field)||'Anchors, instructions and defaults'}</span></summary>
    <div className="schema-field-details"><label>Text anchor<input disabled={disabled} maxLength={200} value={field.anchor||''} placeholder={field.label} onChange={event=>update(index,{anchor:event.target.value})}/></label><label>Instructions<input disabled={disabled} maxLength={2000} value={field.instructions||''} placeholder="Describe the value to extract" onChange={event=>update(index,{instructions:event.target.value})}/></label><label>Text transformation<select disabled={disabled||!['string','multiline'].includes(field.type)} value={field.transform||'trim'} onChange={event=>update(index,{transform:event.target.value as SchemaField['transform']})}><option value="trim">Trim whitespace</option><option value="uppercase">UPPERCASE</option><option value="lowercase">lowercase</option></select></label></div>
    {['string','multiline'].includes(field.type)&&<AllowedChoicesEditor key={`${field.key}:${field.type}`} field={field} onChange={values=>update(index,{enum:values})} disabled={disabled}/>}
    <div className="schema-default"><label className="schema-default-toggle"><input disabled={disabled} type="checkbox" checked={field.default!==undefined} onChange={event=>update(index,{default:event.target.checked?initialDefault(field.type):undefined})}/><span>Use a default when no value is found</span></label>{field.default!==undefined&&<DefaultEditor key={`${field.key}:${field.type}`} field={field} onChange={value=>update(index,{default:value})} disabled={disabled}/>}</div>
    </details>
    {isNested(field.type)&&depth<3&&<div className="schema-nested"><FieldRows fields={field.fields||[]} onChange={values=>update(index,{fields:values})} disabled={disabled} depth={depth+1}/></div>}
  </div>)}<Button type="button" variant="secondary" disabled={disabled||fields.length>=limit} onClick={()=>onChange([...fields,{key:newKey(fields),label:'New field',type:'string',required:false,anchor:'New field'}])}><Plus/>{depth?'Add child field':'Add field'}</Button></div>;
}

interface SavedSchema {id:string;version:number;fields:SchemaField[];}
interface FieldDraft {base:SavedSchema;fields:SchemaField[];suggestion?:Pick<SchemaSuggestion,'id'|'documentId'|'documentName'>;}
type DraftConfirmation={kind:'replace';suggestion:SchemaSuggestion}|{kind:'reload'|'discard'};
function savedDraft(schema:SavedSchema):FieldDraft{return {base:structuredClone(schema),fields:structuredClone(schema.fields)};}

export default function SchemaEditor({parserId,schema,canEdit,archived=false,onUploadDocument}:{parserId:string;schema:SavedSchema;canEdit:boolean;archived?:boolean;onUploadDocument:()=>void}){
  const [draft,setDraft]=useState<FieldDraft>(()=>savedDraft(schema)),[revision,setRevision]=useState(0),[conflict,setConflict]=useState(false),[confirmation,setConfirmation]=useState<DraftConfirmation|null>(null);
  // Invalid widget text can be unsaved even before it updates a SchemaField.
  const [inputEdited,setInputEdited]=useState(false);
  const editorHeading=useRef<HTMLHeadingElement>(null),focusEditorAfterDialog=useRef(false);
  const action=useAction(),client=useQueryClient(),parserPath=`/api/parsers/${parserId}`,parserKey=[workspaceId(),parserPath];
  const dirty=inputEdited||JSON.stringify(draft.fields)!==JSON.stringify(draft.base.fields),stale=conflict||draft.base.id!==schema.id;
  function reportConflict(){setConflict(true);void client.invalidateQueries({queryKey:parserKey});}
  function replaceDraft(next:FieldDraft){setInputEdited(false);setDraft(next);setRevision(current=>current+1);action.setError('');action.setMessage('');}
  function useSuggestion(suggestion:SchemaSuggestion){
    if(!canEdit||action.busy||!suggestion.schema||suggestion.appliedSchemaId)return;
    if(stale||suggestion.baseSchemaId!==draft.base.id){reportConflict();return;}
    replaceDraft({...draft,fields:structuredClone(suggestion.schema.fields),suggestion:{id:suggestion.id,documentId:suggestion.documentId,documentName:suggestion.documentName}});
    if(confirmation){focusEditorAfterDialog.current=true;setConfirmation(null);}else editorHeading.current?.focus();
  }
  async function loadLatest(){
    await action.run(async()=>{
      const result=await api<{schema:SavedSchema}>(parserPath);
      client.setQueryData(parserKey,result);
      replaceDraft(savedDraft(result.schema));setConflict(false);
      if(confirmation){focusEditorAfterDialog.current=true;setConfirmation(null);}else editorHeading.current?.focus();
      return result;
    },'Latest saved fields loaded.');
  }
  async function save(){
    if(!canEdit||action.busy||stale)return;
    await action.run(async()=>{
      try{
        const result=await post<{schema:SavedSchema}>(`${parserPath}/schema`,{fields:draft.fields,baseSchemaId:draft.base.id,...(draft.suggestion?{suggestionId:draft.suggestion.id}:{})});
        client.setQueryData<{schema:SavedSchema}>(parserKey,current=>current?{...current,schema:result.schema}:current);
        replaceDraft(savedDraft(result.schema));setConflict(false);
        return result;
      }catch(error){if(error instanceof ApiError&&error.status===409)reportConflict();throw error;}
    },'A new schema version was saved. Previous runs retain their original schema. Existing documents are not reprocessed automatically.');
  }
  function requestLatest(kind:'reload'|'discard'){
    if(dirty||draft.suggestion)setConfirmation({kind});else void loadLatest();
  }
  return <>
    <SchemaSuggestions parserId={parserId} baseSchemaId={draft.base.id} canEdit={canEdit} archived={archived} blocked={stale||action.busy} activeSuggestionId={draft.suggestion?.id} onUploadDocument={onUploadDocument} onConflict={reportConflict} onUse={suggestion=>{if(dirty||draft.suggestion)setConfirmation({kind:'replace',suggestion});else useSuggestion(suggestion);}}/>
    <form onChangeCapture={()=>setInputEdited(true)} onSubmit={event=>{event.preventDefault();void save();}}>
      <div className="schema-toolbar schema-save-toolbar"><div><h2 tabIndex={-1} ref={editorHeading}>Parser fields</h2><span className="small muted">Based on schema version {draft.base.version}{dirty?' · Unsaved changes':''}</span></div><Button disabled={!canEdit||action.busy||stale}>{action.busy?'Please wait…':'Save schema'}</Button></div>
      {stale&&<div className="schema-draft-notice" role="alert"><p>The saved fields changed or this draft is no longer available to apply. Your edits are preserved. Load the latest saved fields before continuing.</p><Button type="button" variant="secondary" disabled={action.busy} onClick={()=>requestLatest('reload')}>Load latest saved fields</Button></div>}
      {draft.suggestion&&<div className="schema-draft-notice"><p>Suggested draft from <Link className="link" to={`/app/documents/${draft.suggestion.documentId}`}>{draft.suggestion.documentName}</Link>. Review and edit the fields below, then save a new schema version.</p><Button type="button" variant="secondary" disabled={action.busy} onClick={()=>requestLatest('discard')}>Discard suggested draft</Button></div>}
      <Notice error={action.error} message={action.message}/>
      <FieldRows key={revision} fields={draft.fields} onChange={fields=>setDraft(current=>({...current,fields}))} disabled={!canEdit||action.busy}/>
      <p className="small muted" style={{marginTop:22}}>Saving creates a new version. Text-anchor mode reads a labelled value after a colon or a table beneath its anchor. Extraction instructions guide AI mode. Text-anchor rules use labels, anchors and saved templates instead. Defaults are explicit fallback values; review them before approval.</p>
    </form>
    <Modal open={confirmation!==null} onOpenChange={open=>{if(!open)setConfirmation(null);}} onCloseAutoFocus={event=>{if(focusEditorAfterDialog.current){event.preventDefault();focusEditorAfterDialog.current=false;editorHeading.current?.focus();}}}
      title={confirmation?.kind==='replace'?'Replace unsaved fields?':confirmation?.kind==='discard'?'Discard suggested draft?':'Load the latest saved fields?'}
      description={confirmation?.kind==='replace'?'This replaces your current unsaved fields with the suggested draft. You can edit the draft before saving.': 'Your unsaved edits will be replaced with the latest saved schema. This does not change any saved fields or documents.'}>
      <Notice error={action.error}/>
      <div className="schema-confirm-actions"><Button type="button" variant="secondary" disabled={action.busy} onClick={()=>setConfirmation(null)}>Keep editing</Button><Button type="button" disabled={action.busy} onClick={()=>{if(confirmation?.kind==='replace')useSuggestion(confirmation.suggestion);else void loadLatest();}}>{action.busy?'Loading…':confirmation?.kind==='replace'?'Replace draft':confirmation?.kind==='discard'?'Discard draft':'Load saved fields'}</Button></div>
    </Modal>
  </>;
}
