import {useId,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {useQueryClient} from '@tanstack/react-query';
import {Copy} from 'lucide-react';
import {ApiError,post} from '../../lib/api';
import {Button,Field,Modal,Notice} from '../../components/ui';

type CopySource={id:string;name:string;fieldSetupState:string};
type CopyResponse={parser:{id:string}};
function copyName(name:string){return name.trim().slice(0,93).replace(/[\uD800-\uDBFF]$/,'').trimEnd()+' (copy)';}

export default function CopyParser({parser,canEdit,compact=false}:{parser:CopySource;canEdit:boolean;compact?:boolean}){
  const [open,setOpen]=useState(false),[name,setName]=useState(()=>copyName(parser.name));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
  const running=useRef(false),triggerId=useId(),navigate=useNavigate(),client=useQueryClient();
  const setupPending=parser.fieldSetupState!=='ready';
  function changeOpen(next:boolean){if(running.current)return;setOpen(next);}
  async function submit(){
    if(!canEdit||setupPending||uncertain||running.current||!name.trim())return;
    running.current=true;setBusy(true);setError('');
    let result:CopyResponse;
    try{
      result=await post<CopyResponse>(`/api/parsers/${parser.id}/copy`,{name:name.trim()});
      if(typeof result?.parser?.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.parser.id))throw new Error('The created parser could not be confirmed.');
    }
    catch(cause){
      if(cause instanceof ApiError&&cause.status<500)setError(cause.message);
      else setUncertain(true);
      // Refresh the list after an uncertain outcome without repeating the copy.
      void client.invalidateQueries().catch(()=>{});running.current=false;setBusy(false);return;
    }
    void client.invalidateQueries().catch(()=>{});setOpen(false);running.current=false;setBusy(false);
    navigate(`/app/parsers/${result.parser.id}`);
  }
  if(!canEdit)return null;
  return <>
    <Button id={triggerId} type="button" variant="secondary" className={compact?'copy-parser-trigger compact':'copy-parser-trigger'} aria-label={compact?`Copy parser ${parser.name}`:'Copy parser'} disabled={busy} onClick={()=>{
      if(!uncertain){setName(copyName(parser.name));setError('');}setOpen(true);
    }}><Copy size={17}/>{compact?'Copy':'Copy parser'}</Button>
    <Modal title="Copy parser" description="Create an active parser in this workspace using the source parser’s saved configuration." open={open} onOpenChange={changeOpen} onCloseAutoFocus={event=>{event.preventDefault();document.getElementById(triggerId)?.focus();}}>
      <form className="copy-parser-form" aria-busy={busy} onSubmit={event=>{event.preventDefault();void submit();}}>
        <p className="small">Source: <strong>{parser.name}</strong></p>
        <Field label="New parser name"><input required maxLength={100} value={name} disabled={busy||uncertain||setupPending} onChange={event=>setName(event.target.value)}/></Field>
        <p>Copies saved settings, the current fields, text templates and this parser’s saved export mappings.</p>
        <p>Documents, processing history and intake email addresses are not copied. Set up parser-specific intake and destination connections separately. Workspace-wide integrations remain active.</p>
        <p className="small muted">The copy counts toward your active parser limit. Copying does not process documents or use page credits.</p>
        {setupPending&&<div className="copy-parser-guidance" role="status"><p>Finish initial field setup before copying this parser. Retry sample setup or save the fields yourself.</p><div className="actions"><Link className="link" to={`/app/parsers/${parser.id}?tab=setup`} onClick={()=>setOpen(false)}>Open setup</Link><Link className="link" to={`/app/parsers/${parser.id}?tab=fields`} onClick={()=>setOpen(false)}>Choose fields yourself</Link></div></div>}
        <Notice error={error}/>
        {uncertain&&<div className="copy-parser-guidance" role="alert"><p>We couldn’t confirm whether the copy was created. Check the active parser list for “{name.trim()}” before trying again. If no copy appears, reload this page before retrying.</p><Link className="link" to="/app/parsers?view=active" onClick={()=>setOpen(false)}>Check parser list</Link></div>}
        {busy&&<p className="small" role="status">Copying parser… Keep this dialog open while it finishes.</p>}
        <div className="actions"><Button type="submit" disabled={busy||uncertain||setupPending||!name.trim()}>{busy?'Copying…':'Create copy'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>changeOpen(false)}>Cancel</Button></div>
      </form>
    </Modal>
  </>;
}
