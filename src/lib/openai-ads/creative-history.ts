import { z } from "zod";

import {
  adsObjectStatusSchema,
  reviewStatusSchema,
  type ScopedAd,
} from "./schema";

export const creativeReviewEventTypeSchema = z.enum([
  "review_status_changed",
  "delivery_status_changed",
  "review_and_delivery_changed",
]);

export const creativeReviewStateSchema = z.object({
  adId: z.string(),
  adGroupId: z.string(),
  adName: z.string(),
  reviewStatus: reviewStatusSchema,
  deliveryStatus: adsObjectStatusSchema,
  providerUpdatedAt: z.number().int().nonnegative(),
});

export const creativeReviewEventSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  adId: z.string(),
  adGroupId: z.string(),
  adName: z.string(),
  eventType: creativeReviewEventTypeSchema,
  previousReviewStatus: reviewStatusSchema,
  reviewStatus: reviewStatusSchema,
  previousDeliveryStatus: adsObjectStatusSchema,
  deliveryStatus: adsObjectStatusSchema,
  providerUpdatedAt: z.number().int().nonnegative(),
  detectedAt: z.string().datetime(),
});

export type CreativeReviewState = z.infer<typeof creativeReviewStateSchema>;
export type CreativeReviewEvent = z.infer<typeof creativeReviewEventSchema>;
export type CreativeReviewTransitionDraft = Omit<
  CreativeReviewEvent,
  "id"
>;

export function buildCreativeReviewTransitions(options: {
  accountId: string;
  previousStates: CreativeReviewState[];
  ads: ScopedAd[];
  detectedAt: string;
}): CreativeReviewTransitionDraft[] {
  const previousByAdId = new Map(
    options.previousStates.map((state) => [state.adId, state]),
  );

  return options.ads.flatMap((ad) => {
    const previous = previousByAdId.get(ad.id);
    if (!previous || ad.updated_at < previous.providerUpdatedAt) return [];

    const reviewChanged = previous.reviewStatus !== ad.review_status;
    const deliveryChanged = previous.deliveryStatus !== ad.status;
    if (!reviewChanged && !deliveryChanged) return [];

    return [
      creativeReviewEventSchema.omit({ id: true }).parse({
        accountId: options.accountId,
        adId: ad.id,
        adGroupId: ad.ad_group_id,
        adName: ad.name,
        eventType:
          reviewChanged && deliveryChanged
            ? "review_and_delivery_changed"
            : reviewChanged
              ? "review_status_changed"
              : "delivery_status_changed",
        previousReviewStatus: previous.reviewStatus,
        reviewStatus: ad.review_status,
        previousDeliveryStatus: previous.deliveryStatus,
        deliveryStatus: ad.status,
        providerUpdatedAt: ad.updated_at,
        detectedAt: options.detectedAt,
      }),
    ];
  });
}

export function toCreativeReviewState(ad: ScopedAd): CreativeReviewState {
  return creativeReviewStateSchema.parse({
    adId: ad.id,
    adGroupId: ad.ad_group_id,
    adName: ad.name,
    reviewStatus: ad.review_status,
    deliveryStatus: ad.status,
    providerUpdatedAt: ad.updated_at,
  });
}
