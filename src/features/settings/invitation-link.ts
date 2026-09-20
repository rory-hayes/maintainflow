import {useSyncExternalStore} from 'react';

type LinkBrowser={location:{pathname:string;hash:string;search?:string};history:{state:unknown;replaceState:(data:unknown,unused:string,url?:string|URL|null)=>void}};
type InvitationLink={token:string;version:number};
let pending:InvitationLink={token:'',version:0};
const listeners=new Set<()=>void>();
function publish(token:string){pending={token,version:pending.version+1};for(const listener of listeners)listener();}

/** Keep the invitation only in this tab's memory, including during sign-in. */
export function captureInvitationLink(browser:LinkBrowser=window){
  const {pathname,hash,search=''}=browser.location;
  if(!['/invite','/invite/','/app/invite','/app/invite/'].includes(pathname))return;
  try{browser.history.replaceState(browser.history.state,'','/invite');}catch{publish('');return;}
  const fragment=new URLSearchParams(hash.replace(/^#/,''));
  const query=new URLSearchParams(search.replace(/^\?/,''));
  // Existing manually shared links used a query. Never carry it through auth.
  const tokens=[...fragment.getAll('token'),...query.getAll('token')];
  publish(tokens.length===1&&/^[A-Za-z0-9_-]{43}$/.test(tokens[0])?tokens[0]:'');
}
export function discardInvitationLink(version:number){if(pending.version===version)publish('');}
export function useInvitationLink(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>pending,()=>pending);}
