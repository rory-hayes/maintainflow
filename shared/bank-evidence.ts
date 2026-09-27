import type {Evidence} from './types.js';

export const nativeDescriptionEvidenceVersion='folio-bank-native-description-v1' as const;
export type NativeDescriptionDerivation={
 version:typeof nativeDescriptionEvidenceVersion;
 pageTextSha256:string;
 startUtf16:number;
 endUtf16:number;
};

/** This label describes a recorded text match, not table-column or value accuracy. */
export function nativeDescriptionEvidenceLabel(evidence:Evidence):string|null{
 const value=evidence.derivation;
 return evidence.source==='matched-text'&&value?.version===nativeDescriptionEvidenceVersion&&/^[a-f0-9]{64}$/.test(value.pageTextSha256)&&Number.isSafeInteger(value.startUtf16)&&value.startUtf16>=0&&Number.isSafeInteger(value.endUtf16)&&value.endUtf16-value.startUtf16===evidence.text.length
  ?'Matched in original PDF text':null;
}
