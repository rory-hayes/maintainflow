import type {PublicInstallation} from '../../shared/installation.js';

type Environment=Record<string,string|undefined>;
const fields={
  operatorName:'FOLIO_OPERATOR_NAME',supportEmail:'FOLIO_SUPPORT_EMAIL',privacyEmail:'FOLIO_PRIVACY_EMAIL',
  privacyUrl:'FOLIO_PRIVACY_URL',termsUrl:'FOLIO_TERMS_URL',subprocessorsUrl:'FOLIO_SUBPROCESSORS_URL',
  retentionNotice:'FOLIO_RETENTION_NOTICE',dataLocationNotice:'FOLIO_DATA_LOCATION_NOTICE',
} as const;
const aliases:Partial<Record<keyof typeof fields,string>>={operatorName:'MAINTAINFLOW_LEGAL_ENTITY_NAME',supportEmail:'MAINTAINFLOW_SUPPORT_CONTACT_EMAIL',privacyEmail:'MAINTAINFLOW_PRIVACY_CONTACT_EMAIL'};
function plain(value:string|undefined,max:number){const text=value?.trim();return text&&text.length<=max&&!/[\u0000-\u001f\u007f]/.test(text)?text:null;}
function email(value:string|undefined){const text=plain(value,254);return text&&/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(text)?text:null;}
function httpsUrl(value:string|undefined){const text=plain(value,2048);if(!text)return null;try{const url=new URL(text);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}

/** Missing or invalid fields stay absent; no identity, policy or retention promise is invented. */
export function installationConfiguration(env:Environment=process.env){
  const values=Object.fromEntries(Object.entries(fields).map(([field,key])=>[field,env[key]?.trim()?env[key]:env[aliases[field as keyof typeof fields]??'']])) as Record<keyof typeof fields,string|undefined>;
  const disclosure:Omit<PublicInstallation,'configuration'>={
    operatorName:plain(values.operatorName,200),supportEmail:email(values.supportEmail),privacyEmail:email(values.privacyEmail),
    privacyUrl:httpsUrl(values.privacyUrl),termsUrl:httpsUrl(values.termsUrl),subprocessorsUrl:httpsUrl(values.subprocessorsUrl),
    retentionNotice:plain(values.retentionNotice,1500),dataLocationNotice:plain(values.dataLocationNotice,1500),
  };
  const missing=Object.entries(disclosure).filter(([,value])=>value===null).map(([field])=>fields[field as keyof typeof fields]);
  const publicDetails:PublicInstallation={...disclosure,configuration:missing.length===Object.keys(fields).length?'missing':missing.length?'partial':'complete'};
  return {publicDetails,readiness:{configured:missing.length===0,missing,legalReviewVerified:false as const,productionActivationVerified:false as const}};
}
