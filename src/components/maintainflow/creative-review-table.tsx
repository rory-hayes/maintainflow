"use client";

import { useState } from "react";
import { ExternalLink, SearchCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  getCreativeTriageGuidance,
  needsCreativeReviewAttention,
} from "@/lib/openai-ads/creative-triage";
import type { ScopedAd } from "@/lib/openai-ads/schema";

type CreativeFilter = "watchlist" | "all";

function reviewLabel(status: ScopedAd["review_status"]) {
  if (status === "in_review") return "In review";
  return status === "approved" ? "Approved" : "Rejected";
}

function creativeTypeLabel(type: ScopedAd["creative"]["type"]) {
  return type === "chat_card" ? "Chat card" : "Product template";
}

function destinationLabel(targetUrl?: string | null) {
  return targetUrl
    ? new URL(targetUrl).hostname.replace(/^www\./, "")
    : "From product feed";
}

export function CreativeReviewTable({ ads }: { ads: ScopedAd[] }) {
  const [filter, setFilter] = useState<CreativeFilter>("watchlist");
  const approvedCount = ads.filter(
    (ad) => ad.review_status === "approved",
  ).length;
  const inReviewCount = ads.filter(
    (ad) => ad.review_status === "in_review",
  ).length;
  const rejectedCount = ads.filter(
    (ad) => ad.review_status === "rejected",
  ).length;
  const watchlistCount = ads.filter(needsCreativeReviewAttention).length;
  const visibleAds =
    filter === "watchlist" ? ads.filter(needsCreativeReviewAttention) : ads;

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader className="gap-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Ads and creative review</CardTitle>
            <CardDescription>
              Creative content, delivery state, and OpenAI review status
            </CardDescription>
          </div>
          {ads.length > 0 ? (
            <div
              className="flex flex-wrap gap-2"
              aria-label="Creative review summary"
            >
              <Badge variant="outline">{approvedCount} approved</Badge>
              <Badge variant="secondary">{inReviewCount} in review</Badge>
              <Badge variant={rejectedCount > 0 ? "destructive" : "outline"}>
                {rejectedCount} rejected
              </Badge>
            </div>
          ) : null}
        </div>
        {ads.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
              <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
                OpenAI review remains read-only. Provider reasons, screenshots,
                appeals, and serving issues are shown when returned.
              </p>
              <ToggleGroup
                type="single"
                value={filter}
                variant="outline"
                size="sm"
                aria-label="Filter creative review table"
                onValueChange={(value) => {
                  if (value === "watchlist" || value === "all") setFilter(value);
                }}
              >
                <ToggleGroupItem
                  value="watchlist"
                  className="whitespace-nowrap"
                  aria-label="Show watchlist"
                >
                  Watchlist {watchlistCount}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="all"
                  className="whitespace-nowrap"
                  aria-label="Show all creatives"
                >
                  All {ads.length}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0">
        {ads.length > 0 ? (
          visibleAds.length > 0 ? (
            <Table scrollAreaLabel="Creative review">
              <TableHeader>
                <TableRow>
                  <TableHead>Ad</TableHead>
                  <TableHead>Creative</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>OpenAI review</TableHead>
                  <TableHead>Next step</TableHead>
                  <TableHead>Destination</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAds.map((ad) => {
                  const guidance = getCreativeTriageGuidance(ad);

                  return (
                    <TableRow key={ad.id}>
                      <TableCell>
                        <div className="grid min-w-48 gap-1">
                          <span className="font-medium">{ad.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {ad.id} · {ad.ad_group_id}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="grid min-w-64 max-w-80 gap-1">
                          <span className="font-medium">{ad.creative.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {ad.creative.body}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {creativeTypeLabel(ad.creative.type)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            ad.status === "active" ? "outline" : "secondary"
                          }
                          className="capitalize"
                        >
                          {ad.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="grid min-w-40 gap-1.5">
                          <Badge
                            variant={
                              ad.review_status === "rejected"
                                ? "destructive"
                                : ad.review_status === "in_review"
                                  ? "secondary"
                                  : "outline"
                            }
                            className="w-fit"
                          >
                            {reviewLabel(ad.review_status)}
                          </Badge>
                          {guidance.providerSignal ? (
                            <span className="text-xs text-muted-foreground">
                              {guidance.providerSignal}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="grid min-w-56 max-w-72 gap-1">
                          <span className="font-medium">{guidance.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {guidance.detail}
                          </span>
                          {guidance.evidenceUrl ? (
                            <a
                              href={guidance.evidenceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
                            >
                              Provider screenshot
                              <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {destinationLabel(ad.creative.target_url)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchCheck />
                </EmptyMedia>
                <EmptyTitle>No creatives need review attention</EmptyTitle>
                <EmptyDescription>
                  All returned creatives have an approved provider decision.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          <Empty className="border-0 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchCheck />
              </EmptyMedia>
              <EmptyTitle>No ads returned</EmptyTitle>
              <EmptyDescription>
                The connected ad groups do not currently contain an ad.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}
