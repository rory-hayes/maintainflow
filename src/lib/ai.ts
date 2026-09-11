import {useData} from './api';

type PresetStatus={providers:{ai:{configured:boolean;message?:string}}};

/** Configuration is an availability signal, not a document-accuracy result. */
export function useAiAvailability(){
  const query=useData<PresetStatus>('/api/presets');
  const configured=query.error?undefined:query.data?.providers?.ai?.configured;
  const message=query.isPending?'Checking AI configuration…':configured===true
    ?'AI is configured. Choose AI extraction for readable documents, scans and images, then review the results.'
    :configured===false
      ?'AI is not configured. Text-anchor rules work with readable text; they cannot read scans or images.'
      :'AI configuration could not be checked. Try again shortly.';
  const optionLabel=configured===true?'AI extraction':configured===false?'AI extraction (not configured)':query.isPending?'AI extraction (checking…)':'AI extraction (status unavailable)';
  return {configured,message,optionLabel};
}
