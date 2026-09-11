import {useData} from '../lib/api';

export default function PreviewNotice(){
  const runtime=useData<{preview:boolean}>('/api/config');
  if(!runtime.data?.preview)return null;
  return <div role="note" style={{background:'#f4eddb',color:'#534529',padding:'8px 18px',fontSize:13,textAlign:'center'}}>Private test preview · Billing is simulated. No payments are taken.</div>;
}
