import {createHash} from 'node:crypto';
import {z} from 'zod';

const boundedText=(max:number)=>z.string().min(1).max(max).refine(value=>!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value));
const shortText=(max:number)=>boundedText(max).refine(value=>!/[\r\n\t]/.test(value));
const httpsUrl=z.string().max(2048).url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;});
const policyInput=z.object({version:shortText(80),language:z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35),title:shortText(160),text:boundedText(16000),url:httpsUrl,agreementText:shortText(1000)}).strict();
export type CheckoutPolicyInput=z.input<typeof policyInput>;
export type CheckoutPolicy=CheckoutPolicyInput&{sha256:string};
export const checkoutPolicySchema=policyInput.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const unavailable=():never=>{throw Object.assign(new Error('Checkout terms configuration is unavailable.'),{statusCode:503});};
const markdownText=(text:string)=>text.replace(/[\\`*_{}\[\]()#+.!|>-]/g,'\\$&');
export function checkoutAgreementMessage(policy:CheckoutPolicyInput){
 const url=new URL(policy.url).href.replace(/[()]/g,char=>char==='('?'%28':'%29');
 const message=`${markdownText(policy.agreementText)} [${markdownText(policy.title)}](${url})`;
 if(message.length>1200||url.length>2048)unavailable();
 return message;
}
/** Existing contract records keep their text-only digest and validation semantics. */
export function validateCheckoutPolicy(input:unknown):CheckoutPolicy{
 const parsed=policyInput.safeParse(input);
 if(!parsed.success||Buffer.byteLength(parsed.data.text,'utf8')>60000)return unavailable();
 checkoutAgreementMessage(parsed.data);
 return {...parsed.data,sha256:hash(parsed.data.text)};
}

type Environment=Record<string,string|undefined>;
const keys=['FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON','FOLIO_CHECKOUT_POLICY_VERSION','FOLIO_CHECKOUT_POLICY_SHA256'] as const;
const validConfiguredText=(policy:CheckoutPolicyInput)=>Object.values(policy).every(value=>value.trim().length>0&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value));
const catalogueSchema=z.object({policies:z.array(policyInput.refine(validConfiguredText)).min(1).max(10)}).strict();
export const checkoutPolicyCatalogueMaxBytes=65536;
/** A separate configuration pin binds all six fields, never replacing record.sha256. */
export function checkoutPolicyConfigurationDigest(policy:CheckoutPolicyInput){
 return hash(JSON.stringify({version:policy.version,language:policy.language,title:policy.title,text:policy.text,url:policy.url,agreementText:policy.agreementText}));
}

/** No policy content is bundled or adopted. Read lazily only for new attempts/status. */
export function configuredCheckoutPolicy(environment:Environment=process.env):CheckoutPolicyInput|null{
 const enabled=environment.FOLIO_CHECKOUT_POLICY_ENABLED;
 if(enabled==='false')return null; // Explicit staging/withdrawal remains possible.
 if(enabled===undefined){if(keys.some(key=>Boolean(environment[key])))return unavailable();return null;}
 if(enabled!=='true')return unavailable();
 try{
  const json=environment.FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON,version=environment.FOLIO_CHECKOUT_POLICY_VERSION,digest=environment.FOLIO_CHECKOUT_POLICY_SHA256;
  if(!json||Buffer.byteLength(json,'utf8')>checkoutPolicyCatalogueMaxBytes||!version||!digest||!/^[a-f0-9]{64}$/.test(digest))return unavailable();
  const parsed=catalogueSchema.safeParse(JSON.parse(json));if(!parsed.success)return unavailable();
  const policies=parsed.data.policies;
  if(new Set(policies.map(policy=>policy.version)).size!==policies.length)return unavailable();
  // Validate every catalogue entry, including Stripe's final custom-message limit.
  for(const policy of policies)validateCheckoutPolicy(policy);
  const policy=policies.find(policy=>policy.version===version);
  if(!policy||checkoutPolicyConfigurationDigest(policy)!==digest)return unavailable();
  return policy;
 }catch{return unavailable();}
}
