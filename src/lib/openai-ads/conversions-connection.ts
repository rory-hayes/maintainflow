export type ConversionsConnectionStatus = {
  state: "preview" | "not_connected" | "configured" | "connected" | "unavailable";
  source: "vault" | "environment" | null;
  validationEnabled: boolean;
  credentialVersion: number | null;
  validatedAt: string | null;
  providerStatus: number | null;
  eventCount: number | null;
};

export const previewConversionsConnectionStatus: ConversionsConnectionStatus = {
  state: "preview",
  source: null,
  validationEnabled: false,
  credentialVersion: null,
  validatedAt: null,
  providerStatus: null,
  eventCount: null,
};
