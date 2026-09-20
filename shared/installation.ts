/** Public, operator-supplied disclosures only. Never include credentials here. */
export type PublicInstallation = {
  operatorName:string|null;
  supportEmail:string|null;
  privacyEmail:string|null;
  privacyUrl:string|null;
  termsUrl:string|null;
  subprocessorsUrl:string|null;
  retentionNotice:string|null;
  dataLocationNotice:string|null;
  configuration:'missing'|'partial'|'complete';
};
