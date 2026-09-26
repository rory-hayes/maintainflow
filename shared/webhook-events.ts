/** Public event names. Missing selection on an existing webhook means approval only. */
export const webhookEvents = ['document.approved', 'document.extraction_failed', 'document.export_failed'] as const;
export type WebhookEvent = typeof webhookEvents[number];
