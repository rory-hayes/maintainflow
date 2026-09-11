import {useId,useRef,type ReactNode,type ButtonHTMLAttributes} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {X,AlertCircle,CheckCircle2,Loader2,FileText} from 'lucide-react';
import {clsx} from 'clsx';

export function Button({variant='primary',className,children,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'danger'}){return <button className={clsx('button',variant,className)} {...props}>{children}</button>;}
export function Notice({error,message}:{error?:string;message?:string}){return error?<div className="notice error" role="alert"><AlertCircle size={18}/><span>{error}</span></div>:message?<div className="notice success" role="status"><CheckCircle2 size={18}/><span>{message}</span></div>:null;}
export function Loading(){return <div className="loading" role="status"><Loader2 className="spin" size={24}/>Loading your workspace…</div>;}
export function ErrorState({error,retry}:{error:unknown;retry?:()=>void}){return <div className="empty"><AlertCircle size={32}/><h2>We couldn’t load this page.</h2><p>{error instanceof Error?error.message:'Please try again.'}</p>{retry&&<Button variant="secondary" onClick={retry}>Try again</Button>}</div>;}
export function Empty({title,description,children}:{title:string;description:string;children?:ReactNode}){return <div className="empty"><FileText size={36} strokeWidth={1.5}/><h2>{title}</h2><p>{description}</p>{children}</div>;}
export function Status({value}:{value:string}){return <span className={clsx('status',value)}><span/>{value.replaceAll('_',' ').replace(/^./,s=>s.toUpperCase())}</span>;}
export function PageHeader({title,description,children}:{title:string;description?:string;children?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1>{description&&<p>{description}</p>}</div><div className="actions">{children}</div></div>;}
export function Tabs({items,value,onChange,label='Sections'}:{items:string[];value:string;onChange:(v:string)=>void;label?:string}){
  const buttons=useRef<Array<HTMLButtonElement|null>>([]);
  const activeIndex=Math.max(0,items.indexOf(value));
  return <div className="tabs" role="tablist" aria-label={label}>{items.map((item,index)=><button ref={element=>{buttons.current[index]=element;}} type="button" role="tab" aria-selected={index===activeIndex} tabIndex={index===activeIndex?0:-1} className={index===activeIndex?'active':''} onClick={()=>onChange(item)} onKeyDown={event=>{
    let next:number;
    if(event.key==='ArrowRight')next=(index+1)%items.length;
    else if(event.key==='ArrowLeft')next=(index-1+items.length)%items.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=items.length-1;
    else return;
    event.preventDefault();onChange(items[next]);buttons.current[next]?.focus();
  }} key={item}>{item}</button>)}</div>;
}
export function Modal({title,description,open,onOpenChange,children}:{title:string;description?:string;open:boolean;onOpenChange:(open:boolean)=>void;children:ReactNode}){const descriptionId=useId();return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="modal" aria-describedby={description?descriptionId:undefined}><Dialog.Title>{title}</Dialog.Title>{description&&<Dialog.Description id={descriptionId}>{description}</Dialog.Description>}<Dialog.Close type="button" className="icon-button modal-close" aria-label="Close dialog"><X size={20}/></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export const dateTime=(date:string)=>new Intl.DateTimeFormat('en-IE',{dateStyle:'medium',timeStyle:'short'}).format(new Date(date));
