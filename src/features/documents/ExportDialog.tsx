import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {maximumExportFieldPathLength} from '../../../shared/export-contract';
import {Download,Save} from 'lucide-react';
import type {SchemaField} from '../../../shared/types';
import {Modal,Field,Button,Notice} from '../../components/ui';
import {api,post,useAction,useData,workspaceId} from '../../lib/api';
import {useSession} from '../../lib/session';
import ColumnMappingEditor,{type ExportColumn} from './ColumnMappingEditor';
import './export.css';
export type ApprovalRevision={documentId:string;approvalId:string};
type Mapping={id:string;parserId:string;name:string;columns:ExportColumn[];lineItems:string|null};
type Parser={id:string;name:string;archived:boolean};
const metadata:ExportColumn[]=[{source:'$filename',label:'File name'},{source:'$documentId',label:'Document ID'},{source:'$runId',label:'Run ID'},{source:'$revision',label:'Revision'},{source:'$approvalId',label:'Approval ID'}];
function schemaSources(fields:SchemaField[],prefix='',table=''):ExportColumn[]{return fields.flatMap(field=>{const path=prefix+field.key;if(field.type==='object')return schemaSources(field.fields||[],path+'.',table);if(field.type==='array'&&path===table)return schemaSources(field.fields||[],'$item.',table);return [{source:path,label:field.label}];});}
export default function ExportDialog({ids,open,onOpenChange,parserId,revisions}:{ids:string[];open:boolean;onOpenChange:(open:boolean)=>void;parserId?:string;revisions?:ApprovalRevision[]}){
  const [format,setFormat]=useState('csv'),[mapping,setMapping]=useState(''),[lineItems,setLineItems]=useState(''),[columns,setColumns]=useState<ExportColumn[]>([]),[mappingName,setMappingName]=useState(''),[saveParserId,setSaveParserId]=useState(parserId||''),[exporting,setExporting]=useState(false);
  const client=useQueryClient(),form=useRef<HTMLFormElement>(null),action=useAction(),query=useData<{mappings:Mapping[]}>('/api/export-mappings'),parsers=useData<{parsers:Parser[]}>('/api/parsers');
  const exportGeneration=useRef(0),exportController=useRef<AbortController|null>(null);
  const session=useSession().data,selectedWorkspace=workspaceId(),scopeKey=JSON.stringify([session?.user.id??null,session?.workspace.id??null,selectedWorkspace,ids,parserId??null,revisions??null,open]);
  useLayoutEffect(()=>{
    exportGeneration.current++;setExporting(false);action.setError('');action.setMessage('');
    return ()=>{exportGeneration.current++;exportController.current?.abort();exportController.current=null;};
  },[scopeKey]);
  const busy=action.busy||exporting;
  const pinned=Boolean(revisions?.length);
  const canSave=['owner','admin','editor'].includes(session?.workspace.role||'');
  const schema=useQuery<{schema:{fields:SchemaField[]}}>({queryKey:[workspaceId(),`/api/parsers/${saveParserId}`],queryFn:({signal})=>api(`/api/parsers/${saveParserId}`,{signal}),enabled:open&&Boolean(saveParserId)});
  useEffect(()=>{setSaveParserId(parserId||'');setMapping('');setColumns([]);setMappingName('');setLineItems('');},[parserId]);
  const availableMappings=query.data?.mappings.filter(item=>!parserId||item.parserId===parserId)||[];
  const selected=availableMappings.find(item=>item.id===mapping);
  const missingMapping=mapping!==''&&mapping!=='custom'&&!query.isPending&&!selected;
  const fieldSuggestions=schema.data?schemaSources(schema.data.schema.fields,'',lineItems):[];
  const suggestions=[...fieldSuggestions,...metadata];
  function editColumns(next:ExportColumn[]){setColumns(next);setMapping('custom');action.setMessage('');}
  function chooseMapping(id:string){setMapping(id);setMappingName('');action.setError('');action.setMessage('');if(id==='custom'){setColumns([{source:'',label:''}]);return;}const saved=availableMappings.find(item=>item.id===id);setColumns(saved?.columns.map(column=>({...column}))||[]);if(saved){setLineItems(saved.lineItems||'');if(!parserId)setSaveParserId(saved.parserId);}}
  function validatedColumns(){if(mapping==='')return undefined;const cleaned=columns.map(column=>({source:column.source.trim(),label:column.label.trim()}));if(!cleaned.length||cleaned.some(column=>!column.source||!column.label))throw new Error('Give every export column a source field and heading.');if(cleaned.some(column=>column.source.startsWith('$item.'))&&!lineItems.trim())throw new Error('Enter the table field to repeat when using $item columns.');return cleaned;}
  async function saveMapping(){if(!form.current?.reportValidity())return;if(!saveParserId){action.setError('Choose a parser to save a reusable mapping.');return;}if(!mappingName.trim()){action.setError('Give the reusable mapping a name.');return;}const generation=exportGeneration.current;const result=await action.run(()=>post<Mapping>('/api/export-mappings',{parserId:saveParserId,name:mappingName.trim(),columns:validatedColumns(),lineItems:lineItems.trim()||undefined}),'Reusable mapping saved.');if(generation!==exportGeneration.current){action.setError('');action.setMessage('');return;}if(result){setMapping(result.id);setMappingName('');}}
  async function exportSelection(){
    if(!open||action.busy||exportController.current)return;
    const generation=exportGeneration.current,controller=new AbortController();exportController.current=controller;
    const current=()=>exportGeneration.current===generation&&exportController.current===controller&&!controller.signal.aborted;
    setExporting(true);action.setError('');action.setMessage('');
    try{
      if(missingMapping&&format!=='json')throw new Error('This saved mapping is no longer available. Choose another mapping or All fields.');
      const result=await api<{id:string;downloadUrl:string}>('/api/exports',{method:'POST',signal:controller.signal,body:JSON.stringify({documentIds:ids,format,revisions,columns:format==='json'?undefined:validatedColumns(),lineItems:format==='json'?undefined:lineItems.trim()||undefined})});
      await client.invalidateQueries({refetchType:'none'});
      if(!current())return;
      await client.invalidateQueries();
      if(!current())return;
      if(result.downloadUrl!==`/api/exports/${result.id}/download`)throw new Error('The export download could not be opened. Please try again.');
      const response=await fetch(result.downloadUrl,{signal:controller.signal,headers:selectedWorkspace?{'X-Workspace-Id':selectedWorkspace}:undefined,credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('The download could not be completed.');
      const blob=await response.blob();if(!current())return;
      const href=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=href;anchor.download=`folio-export.${format}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(href),5000);
      action.setMessage('Export saved and downloaded.');
    }catch(error){if(current())action.setError(error instanceof Error?error.message:'The export could not be completed.');}
    finally{if(current()){exportController.current=null;setExporting(false);}}
  }
  return <Modal title="Export approved data" description={pinned?'This download uses the exact approval selected in document review, even if newer results are saved.':'A saved snapshot keeps this download tied to its approved document revision.'} open={open} onOpenChange={onOpenChange}><form ref={form} className="export-form" onSubmit={event=>{event.preventDefault();void exportSelection();}}><div className="form-grid"><Field label="Format"><select disabled={busy} value={format} onChange={event=>setFormat(event.target.value)}><option value="csv">CSV spreadsheet</option><option value="xlsx">Excel workbook</option><option value="json">JSON with revision metadata</option></select></Field><Field label="Column mapping"><select value={mapping} disabled={busy||format==='json'} onChange={event=>chooseMapping(event.target.value)}><option value="">All fields</option><option value="custom">Custom columns…</option>{availableMappings.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}{missingMapping&&<option value={mapping}>Unavailable mapping</option>}</select></Field></div>{format==='json'?<p className="small muted">JSON includes the complete approved values and revision metadata. Spreadsheet column mappings and row expansion apply to CSV and Excel.</p>:<><Field label="Repeat rows for a table (optional)" hint="Enter a table field path to create one row per item. Leave empty to keep tables in one cell."><input disabled={busy} value={lineItems} onChange={event=>setLineItems(event.target.value)} placeholder="line_items" pattern="[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*" maxLength={maximumExportFieldPathLength}/></Field>{mapping!==''&&!missingMapping&&<><ColumnMappingEditor columns={columns} onChange={editColumns} suggestions={suggestions} disabled={busy}/>{fieldSuggestions.length>0&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>editColumns([...columns.filter(column=>column.source.trim()||column.label.trim()),...fieldSuggestions.filter(suggestion=>!columns.some(column=>column.source===suggestion.source))].slice(0,100))}>Add schema fields</Button>}<div className="export-mapping-save">{!parserId&&<Field label="Parser for reusable mapping" hint="Custom columns work for this download. Choose a parser to save them for future exports; this does not change the selected documents."><select value={saveParserId} disabled={busy||!canSave} onChange={event=>setSaveParserId(event.target.value)}><option value="">Choose a parser (optional)</option>{parsers.data?.parsers.map(parser=><option key={parser.id} value={parser.id}>{parser.name}{parser.archived?' (archived)':''}</option>)}</select></Field>}{canSave?<><Field label="Reusable mapping name (optional)"><input value={mappingName} maxLength={100} disabled={busy} placeholder="Accounts payable export" onChange={event=>setMappingName(event.target.value)}/></Field><Button type="button" variant="secondary" disabled={busy||!saveParserId||!mappingName.trim()} onClick={()=>void saveMapping()}><Save size={16}/>Save reusable mapping</Button></>:<p className="small muted">You can customize this download. An owner, admin or editor can save reusable mappings.</p>}</div></>}</>}<p className="small">{ids.length} document{ids.length===1?'':'s'} selected. {pinned?'Using the approval selected in document review.':'Every selected document needs an approved revision before export.'}</p><Notice error={action.error||(query.error instanceof Error?query.error.message:parsers.error instanceof Error?parsers.error.message:undefined)} message={action.message}/>{missingMapping&&format!=='json'&&<Notice error="This saved mapping is unavailable. Choose All fields, custom columns or another saved mapping."/>}<Button type="submit" disabled={busy||!ids.length||(missingMapping&&format!=='json')}><Download/>{exporting?'Exporting…':'Download export'}</Button><span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{exporting?'Exporting approved data. Your download will start when it is ready.':''}</span></form></Modal>;
}
