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
    return <select disabled={disabled} aria-label={label} value={selected} onChange={event=>{
      if(event.target.value==='missing')onChange(null);
      else if(event.target.value.startsWith('choice:'))onChange(choices[Number(event.target.value.slice(7))]);
    }}><option value="missing">Not found</option>{selected==='unknown'&&<option value="unknown">{current||'(Empty text)'} — not an allowed choice</option>}{choices.map((choice,choiceIndex)=><option key={choiceIndex} value={`choice:${choiceIndex}`}>{choice||'(Empty text)'}</option>)}</select>;
  }
  if(field.type==='boolean')return <select disabled={disabled} aria-label={label} value={value==null?'':String(value)} onChange={event=>onChange(event.target.value===''?null:event.target.value==='true')}><option value="">Not found</option><option value="true">Yes</option><option value="false">No</option></select>;
  if(field.type==='multiline')return <textarea disabled={disabled} aria-label={label} rows={3} value={value==null?'':String(value)} placeholder="Not found" onChange={event=>onChange(event.target.value||null)}/>;
  return <input disabled={disabled} aria-label={label} type={field.type==='date'?'date':'text'} inputMode={['number','currency'].includes(field.type)?'decimal':undefined} value={value==null?'':String(value)} placeholder="Not found" onChange={event=>onChange(event.target.value||null)}/>;
}
export default function ValueEditor({field,value,onChange,disabled,path=field.label}:EditorProps){
  if(field.type==='array'){
    const rows:unknown[]=Array.isArray(value)?value:[],columns=field.fields||[];
    const nested=columns.some(child=>child.type==='array'||child.type==='object');
    const update=(index:number,key:string,next:unknown)=>onChange(rows.map((row,i)=>i===index?{...(row&&typeof row==='object'&&!Array.isArray(row)?row:{}),[key]:next}:row));
    const remove=(index:number)=><button type="button" className="icon-button" aria-label={`Remove ${path} row ${index+1}`} disabled={disabled} onClick={()=>onChange(rows.filter((_,i)=>i!==index))}><Trash2 size={15}/></button>;
    return <div className="review-table-field"><h3>{field.label}{field.required?' *':''}</h3>{field.instructions&&<p className="small muted">{field.instructions}</p>}{nested?<div className="review-nested-rows">{rows.map((row,index)=><fieldset className="object-field review-nested-row" key={index}><legend>{field.label} · Row {index+1}</legend><div className="review-row-actions">{remove(index)}</div>{columns.map(child=><ValueEditor key={child.key} field={child} value={row&&typeof row==='object'?(row as Record<string,unknown>)[child.key]:null} path={`${path} row ${index+1}, ${child.label}`} disabled={disabled} onChange={next=>update(index,child.key,next)}/>)}</fieldset>)}</div>:<div className="table-wrap"><table><caption className="sr-only">{field.label}</caption><thead><tr>{columns.map(child=><th scope="col" key={child.key}>{child.label}{child.required?' *':''}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{columns.map(child=><td key={child.key}><ScalarInput field={child} value={row&&typeof row==='object'?(row as Record<string,unknown>)[child.key]:null} path={`${path} row ${index+1}, ${child.label}`} disabled={disabled} onChange={next=>update(index,child.key,next)}/></td>)}<td>{remove(index)}</td></tr>)}</tbody></table></div>}{!rows.length&&<p className="small muted">No rows found.</p>}<Button type="button" variant="ghost" disabled={disabled} onClick={()=>onChange([...rows,Object.fromEntries(columns.map(child=>[child.key,emptyFieldValue(child)]))])}><Plus/>Add row</Button></div>;
  }
  if(field.type==='object'){
    const object=(value&&typeof value==='object'&&!Array.isArray(value)?value:{}) as Record<string,unknown>;
    return <fieldset className="object-field"><legend>{field.label}{field.required?' *':''}</legend>{field.fields?.map(child=><ValueEditor key={child.key} field={child} value={object[child.key]} path={`${path}, ${child.label}`} disabled={disabled} onChange={next=>onChange({...object,[child.key]:next})}/>)}</fieldset>;
  }
  return <Field label={`${field.label}${field.required?' *':''}`} hint={field.instructions}><ScalarInput field={field} value={value} path={path} disabled={disabled} onChange={onChange}/></Field>;
}
