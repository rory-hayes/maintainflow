import {useData} from '../lib/api';

export default function PreviewNotice(){
  const runtime=useData<{preview:boolean;previewBillingMode?:'mock'|'stripe_test'|null}>('/api/config');
  if(!runtime.data?.preview)return null;
  const billing=runtime.data.previewBillingMode==='stripe_test'?'Stripe test mode. No real payments are taken.':runtime.data.previewBillingMode==='mock'?'Billing is simulated. No payments are taken.':'';
  return <div role="note" style={{background:'#f4eddb',color:'#534529',padding:'8px 18px',fontSize:13,textAlign:'center'}}>Private test preview{billing?` · ${billing}`:''}</div>;
}
