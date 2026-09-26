import {useLayoutEffect,useRef} from 'react';
import {Plus,Trash2} from 'lucide-react';
import type {SchemaField} from '../../../shared/types';
import {Button,Field} from '../../components/ui';
import {emptyFieldValue} from './value-editing';

type EditorProps={field:SchemaField;value:unknown;onChange:(value:unknown)=>void;disabled:boolean;path?:string};
function ScalarInput({field,value,onChange,disabled,path}:EditorProps){
  const label=path||field.label;
  if(['string','multiline'].includes(field.type)&&field.enum?.length){
    const choices=field.enum,index=typeof value==='string'?choices.indexOf(value):-1;
    const selected=value==null?'missing':index>=0?`choice:${index}`:'unknown';
    const current=typeof value==='object'?JSON.stringify(value):String(value);
    return <select disabled={disabled} aria-label={label} aria-required={field.required||undefined} value={selected} onChange={event=>{
      if(event.target.value==='missing')onChange(null);
      else if(event.target.value.startsWith('choice:'))onChange(choices[Number(event.target.value.slice(7))]);
    }}><option value="missing">Not found</option>{selected==='unknown'&&<option value="unknown">{current||'(Empty text)'} — not an allowed choice</option>}{choices.map((choice,choiceIndex)=><option key={choiceIndex} value={`choice:${choiceIndex}`}>{choice||'(Empty text)'}</option>)}</select>;
  }
  if(field.type==='boolean')return <select disabled={disabled} aria-label={label} aria-required={field.required||undefined} value={value==null?'':String(value)} onChange={event=>onChange(event.target.value===''?null:event.target.value==='true')}><option value="">Not found</option><option value="true">Yes</option><option value="false">No</option></select>;
  if(field.type==='multiline')return <textarea disabled={disabled} aria-label={label} aria-required={field.required||undefined} rows={3} value={value==null?'':String(value)} placeholder="Not found" onChange={event=>onChange(event.target.value||null)}/>;
  return <input disabled={disabled} aria-label={label} aria-required={field.required||undefined} type={field.type==='date'?'date':'text'} inputMode={['number','currency'].includes(field.type)?'decimal':undefined} value={value==null?'':String(value)} placeholder={field.type==='timestamp'?'2026-09-17T14:30:00+01:00':'Not found'} onChange={event=>onChange(event.target.value||null)}/>;
}
function ArrayEditor({field,value,onChange,disabled,path}:EditorProps&{path:string}){
    const container=useRef<HTMLDivElement>(null),rowElements=useRef<Array<HTMLElement|null>>([]),focusRow=useRef<number|null>(null);
    const rows:unknown[]=Array.isArray(value)?value:[],columns=field.fields||[];
    const nested=columns.some(child=>child.type==='array'||child.type==='object');
    useLayoutEffect(()=>{
      if(focusRow.current===null)return;
      const index=Math.min(focusRow.current,rows.length-1);focusRow.current=null;
      const row=index>=0?rowElements.current[index]:null;
      const target=row?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')
        ||row?.querySelector<HTMLElement>('.review-table-field > button:not(:disabled)')
        ||container.current?.querySelector<HTMLElement>(':scope > button:not(:disabled)');
      target?.focus();
    },[value,rows.length]);
    const update=(index:number,key:string,next:unknown)=>onChange(rows.map((row,i)=>i===index?{...(row&&typeof row==='object'&&!Array.isArray(row)?row:{}),[key]:next}:row));
    const remove=(index:number)=><button type="button" className="icon-button" aria-label={`Remove ${path} row ${index+1}`} disabled={disabled} onClick={()=>{focusRow.current=index;onChange(rows.filter((_,i)=>i!==index));}}><Trash2 size={15}/></button>;
    return <div className="review-table-field" ref={container}><h3>{field.label}{field.required?' *':''}</h3>{field.instructions&&<p className="small muted">{field.instructions}</p>}{nested?<div className="review-nested-rows">{rows.map((row,index)=><fieldset className="object-field review-nested-row" key={index} ref={element=>{rowElements.current[index]=element;}}><legend>{field.label} · Row {index+1}</legend><div className="review-row-actions">{remove(index)}</div>{columns.map(child=><ValueEditor key={child.key} field={child} value={row&&typeof row==='object'?(row as Record<string,unknown>)[child.key]:null} path={`${path} row ${index+1}, ${child.label}`} disabled={disabled} onChange={next=>update(index,child.key,next)}/>)}</fieldset>)}</div>:<div className="table-wrap"><table><caption className="sr-only">{path}</caption><thead><tr>{columns.map(child=><th scope="col" key={child.key}>{child.label}{child.required?' *':''}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row,index)=><tr key={index} ref={element=>{rowElements.current[index]=element;}}>{columns.map(child=><td key={child.key}><ScalarInput field={child} value={row&&typeof row==='object'?(row as Record<string,unknown>)[child.key]:null} path={`${path} row ${index+1}, ${child.label}`} disabled={disabled} onChange={next=>update(index,child.key,next)}/></td>)}<td>{remove(index)}</td></tr>)}</tbody></table></div>}{!rows.length&&<p className="small muted">No rows found.</p>}<Button type="button" variant="ghost" aria-label={`Add row to ${path}`} disabled={disabled} onClick={()=>{focusRow.current=rows.length;onChange([...rows,Object.fromEntries(columns.map(child=>[child.key,emptyFieldValue(child)]))]);}}><Plus/>Add row</Button></div>;
}
export default function ValueEditor({field,value,onChange,disabled,path=field.label}:EditorProps){
  if(field.type==='array')return <ArrayEditor field={field} value={value} onChange={onChange} disabled={disabled} path={path}/>;
  if(field.type==='object'){
    const object=(value&&typeof value==='object'&&!Array.isArray(value)?value:{}) as Record<string,unknown>;
    return <fieldset className="object-field"><legend>{field.label}{field.required?' *':''}</legend>{field.fields?.map(child=><ValueEditor key={child.key} field={child} value={object[child.key]} path={`${path}, ${child.label}`} disabled={disabled} onChange={next=>onChange({...object,[child.key]:next})}/>)}</fieldset>;
  }
  return <Field label={`${field.label}${field.required?' *':''}`} hint={field.type==='timestamp'?`${field.instructions?field.instructions+' ':''}Date and 24-hour time; include Z or a numeric offset to identify the instant. Saved output uses UTC.`:field.instructions}><ScalarInput field={field} value={value} path={path} disabled={disabled} onChange={onChange}/></Field>;
}
