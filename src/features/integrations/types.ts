export type ReceivingStatus = {
  configured: boolean;
  verified: boolean;
  mode: 'custom' | 'managed' | 'invalid';
  verification: 'custom-mx' | 'managed-probe' | null;
  deliveryVerified: false;
  reason: string | null;
};

export type ProviderStatus = {
  stripe: { configured: boolean; mode: 'test' | 'mock'; verified: boolean; reason: string; mockPlan?: { id: string; name: string; status: 'active' | 'canceled' } | null };
  resend: ReceivingStatus & { addressAvailable: boolean };
  googleSheets: { configured: boolean; verified: boolean; reason: string };
};

export type Integration = {
  id: string;
  parserId: string | null;
  name: string;
  kind: 'webhook' | 'google_sheets';
  config: { url?: string; spreadsheetId?: string; sheetName?: string; columns?: { source: string; label: string }[] };
  enabled: boolean;
  createdAt: string;
};

export type ParserOption = { id: string; name: string; archived: boolean };
