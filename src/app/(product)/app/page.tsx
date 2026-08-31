import { connection } from "next/server";

import { MaintainFlowWorkbench } from "@/components/maintainflow/review-workbench";
import type { WorkspaceSetupState } from "@/components/maintainflow/workspace-onboarding";
import {
  listActiveApprovalRecords,
  listApprovalRecords,
  verifyApprovalStore,
} from "@/lib/audit/approval-store.server";
import {
  toApprovalRecordDto,
  type ApprovalRecordDto,
} from "@/lib/audit/approval-schema";
import {
  applyRecommendationDismissals,
  recommendationApprovalFingerprint,
  recommendationFingerprint,
  toRecommendationDecisionHistoryDto,
  type RecommendationDecisionHistoryDto,
} from "@/lib/audit/recommendation-decision";
import {
  listActiveRecommendationDismissals,
  listRecommendationDecisionHistory,
  verifyRecommendationDecisionStore,
} from "@/lib/audit/recommendation-decision-store.server";
import {
  isBootstrapOperator,
  isWorkspaceAdmissionAllowed,
} from "@/lib/auth/config";
import { parseAppTab, type AppTab } from "@/lib/app-navigation";
import { getOptionalOperator } from "@/lib/auth/operator.server";
import { isCredentialVaultConfigured } from "@/lib/credentials/crypto.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  getAdsRuntimeMode,
  type AdsApiCredential,
} from "@/lib/openai-ads/client.server";
import {
  getConversionsApiConnectionStatus,
} from "@/lib/openai-ads/conversions.server";
import {
  previewConversionsConnectionStatus,
  type ConversionsConnectionStatus,
} from "@/lib/openai-ads/conversions-connection";
import {
  fetchLiveAdAccount,
} from "@/lib/openai-ads/data.server";
import { getLiveWorkbench } from "@/lib/openai-ads/live-sync.server";
import {
  listCreativeReviewEvents,
  recordCreativeReviewSnapshot,
  verifyCreativeHistoryStore,
} from "@/lib/openai-ads/creative-history.server";
import type { CreativeReviewEvent } from "@/lib/openai-ads/creative-history";
import {
  demoAccount,
} from "@/lib/openai-ads/demo-data";
import { resolveSimulatedWorkspace } from "@/lib/openai-ads/simulated-workspaces";
import {
  buildMonitoringWindows,
  suppressRecommendationsUnderActiveApproval,
} from "@/lib/openai-ads/recommendation-lifecycle";
import type { MonitoringWindowDto } from "@/lib/openai-ads/monitoring";
import { evaluateDueMonitoringWindows } from "@/lib/openai-ads/monitoring-runner.server";
import {
  unavailableConversionMeasurement,
  type ConversionMeasurementReadiness,
} from "@/lib/openai-ads/measurement-readiness";
import type { ReadinessAuditHistoryEntry } from "@/lib/readiness/history";
import {
  listReadinessAuditRuns,
  verifyReadinessHistoryStore,
} from "@/lib/readiness/history.server";
import {
  getAdsCredentialMaterialForAccount,
  listAccountAccesses,
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";
import {
  canWriteAccount,
  type AccountAccess,
} from "@/lib/tenancy/schema";

type AppPageProps = {
  searchParams: Promise<{
    account?: string | string[];
    tab?: string | string[];
  }>;
};

export default async function MaintainFlowAppPage({
  searchParams,
}: AppPageProps) {
  await connection();
  const query = await searchParams;
  const requestedAccountId =
    typeof query.account === "string" ? query.account : undefined;
  const requestedTab = parseAppTab(query.tab);
  const log = createServerLogger("app.workspace");
  const authenticatedOperator = await getOptionalOperator();
  const simulatedWorkspace = resolveSimulatedWorkspace(requestedAccountId);
  const operator = authenticatedOperator ?? simulatedWorkspace.operator;

  let runtime = getAdsRuntimeMode();
  let account = simulatedWorkspace.account;
  let ads = simulatedWorkspace.ads;
  let campaigns = simulatedWorkspace.campaigns;
  let performance = simulatedWorkspace.performance;
  let recommendations = simulatedWorkspace.recommendations;
  let creativeReviewHistory: CreativeReviewEvent[] =
    simulatedWorkspace.creativeReviewHistory;
  let dataSource: "demo" | "live" = "demo";
  let writeMode: "demo" | "live" = "demo";
  let syncedAt: string | undefined;
  let syncError: string | undefined;
  let syncWarning: string | undefined;
  let approvalHistory: ApprovalRecordDto[] = [];
  let monitoringWindows: MonitoringWindowDto[] = [];
  let conversionMeasurement: ConversionMeasurementReadiness =
    unavailableConversionMeasurement({
      source: "demo",
      message:
        "Connect a live OpenAI Ads account to verify conversion event settings.",
    });
  let monitoringEvaluationError: string | undefined;
  let approvalHistoryError: string | undefined;
  let approvalStoreReady = false;
  let recommendationDecisionStoreReady = false;
  let recommendationDecisionError: string | undefined;
  let recommendationDecisionHistory: RecommendationDecisionHistoryDto[] = [];
  let creativeHistoryStoreReady = false;
  let creativeHistoryError: string | undefined;
  let workspaceAccess: AccountAccess | undefined;
  let availableAccounts: AccountAccess[] = [];
  let workspaceSetupState: WorkspaceSetupState = "demo";
  let workspaceAccountName: string | undefined;
  let workspaceMessage: string | undefined;
  let conversionsConnection: ConversionsConnectionStatus =
    previewConversionsConnectionStatus;
  let readinessHistoryStoreReady = false;
  let readinessHistoryError: string | undefined;
  let readinessHistory: ReadinessAuditHistoryEntry[] = [];

  if (!authenticatedOperator) {
    if (runtime.dataSource === "live") {
      syncError = runtime.authConfigured
        ? "Live account data is protected. Sign in before connecting an Ads account."
        : "Live account data is protected. Configure operator authentication before connecting an Ads account.";
    }
  } else if (authenticatedOperator) {
    if (!runtime.approvalStoreConfigured) {
      workspaceSetupState = "unavailable";
      workspaceMessage =
        "Configure the customer database before connecting an advertiser or agency.";
    } else {
      try {
        const [
          tenancyReady,
          credentialStoreReady,
          approvalsReady,
          creativeHistoryReady,
          recommendationDecisionsReady,
          readinessHistoryReady,
        ] =
          await Promise.all([
            verifyTenancyStore().catch(() => false),
            verifyCredentialStore().catch(() => false),
            verifyApprovalStore().catch(() => false),
            verifyCreativeHistoryStore().catch(() => false),
            verifyRecommendationDecisionStore().catch(() => false),
            verifyReadinessHistoryStore().catch(() => false),
          ]);
        approvalStoreReady = approvalsReady;
        creativeHistoryStoreReady = creativeHistoryReady;
        recommendationDecisionStoreReady = recommendationDecisionsReady;
        readinessHistoryStoreReady = readinessHistoryReady;

        if (!tenancyReady) {
          workspaceSetupState = "unavailable";
          workspaceMessage =
            "Apply the customer tenancy migration before connecting advertisers or agencies.";
        } else {
          availableAccounts = await listAccountAccesses(
            authenticatedOperator.id,
          );
          workspaceAccess =
            availableAccounts.find(
              (item) => item.accountId === requestedAccountId,
            ) ?? availableAccounts[0];

          if (!workspaceAccess) {
            const admitted = isWorkspaceAdmissionAllowed(
              authenticatedOperator.id,
            );
            const vaultReady =
              admitted && credentialStoreReady && isCredentialVaultConfigured();
            const pilotReady =
              admitted &&
              runtime.hasKey &&
              isBootstrapOperator(authenticatedOperator.id);
            if (!admitted) {
              workspaceSetupState = "unavailable";
              workspaceMessage =
                "This signed-in account has not been admitted to the MaintainFlow private beta.";
            } else if (vaultReady || pilotReady) {
              workspaceSetupState = "needs_setup";
              if (pilotReady) {
                try {
                  workspaceAccountName = (await fetchLiveAdAccount()).name;
                } catch {
                  workspaceMessage =
                    "The configured pilot account could not be verified. You can still connect a client account key.";
                }
              }
            } else {
              workspaceSetupState = "unavailable";
              workspaceMessage = credentialStoreReady
                ? "Configure the credential encryption keyring before connecting client accounts."
                : "Apply the advertiser credential migration before connecting client accounts.";
            }
          } else {
            workspaceSetupState = "ready";
            workspaceAccountName = workspaceAccess.accountName;
            const connectedRuntime = getAdsRuntimeMode({ hasAccountKey: true });
            if (connectedRuntime.dataSource === "live") {
              // A connected live workspace must become fail-closed before any
              // vault, database, or provider read. If one of those reads fails,
              // the outer error path cannot leave interactive demo fixtures on
              // screen under a real advertiser identity.
              runtime = connectedRuntime;
              dataSource = "live";
              writeMode = "demo";
              account = {
                ...demoAccount,
                id: workspaceAccess.accountId,
                name: workspaceAccess.accountName,
              };
              ads = [];
              campaigns = [];
              performance = [];
              recommendations = [];
              creativeReviewHistory = [];
              conversionMeasurement = unavailableConversionMeasurement({
                source: "live",
                message:
                  "A confirmed OpenAI Ads snapshot is required before conversion measurement can be assessed.",
              });
            }
            if (readinessHistoryStoreReady) {
              try {
                readinessHistory = await listReadinessAuditRuns(
                  {
                    accountId: workspaceAccess.accountId,
                    operatorId: authenticatedOperator.id,
                    access: workspaceAccess,
                  },
                );
              } catch (error) {
                log.error("workspace.readiness_history_load_failed", { error });
                readinessHistoryError =
                  "Saved readiness scans could not be loaded for this account.";
              }
            } else {
              readinessHistoryError =
                "Apply the readiness history migration to retain and compare account scans.";
            }
            const [resolvedConversionsConnection, adsCredential] = await Promise.all([
              getConversionsApiConnectionStatus(workspaceAccess.accountId).catch(
                (error) => {
                  log.error("workspace.conversion_credential_status_failed", {
                    error,
                  });
                  return {
                    ...previewConversionsConnectionStatus,
                    state: "unavailable" as const,
                    validationEnabled:
                      process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED ===
                      "true",
                  };
                },
              ),
              getAdsCredentialMaterialForAccount(workspaceAccess.accountId),
            ]);
            conversionsConnection = resolvedConversionsConnection;
            const credential: AdsApiCredential = {
              kind: "account_api_key",
              secret: adsCredential.apiKey,
              expectedAccountId: workspaceAccess.accountId,
            };
            runtime = getAdsRuntimeMode({ hasAccountKey: true });

            if (runtime.dataSource === "live") {
              // Once a connected workspace enters live mode, never leave demo
              // fixtures on screen if the provider is unavailable. Start from
              // an empty, write-locked live snapshot and replace it only with
              // schema-validated provider data.
              dataSource = "live";
              account = {
                ...demoAccount,
                id: workspaceAccess.accountId,
                name: workspaceAccess.accountName,
              };
              ads = [];
              campaigns = [];
              performance = [];
              recommendations = [];
              creativeReviewHistory = [];
              const liveResult = await getLiveWorkbench({
                accountId: workspaceAccess.accountId,
                credentialGeneration: adsCredential.credentialGeneration,
                credential,
                policy: "dashboard",
              });
              const live = liveResult.data;
              account = live.account;
              ads = live.ads;
              campaigns = live.campaigns;
              performance = live.performance;
              recommendations = live.recommendations;
              conversionMeasurement = live.conversionMeasurement;
              dataSource = "live";
              syncedAt = live.syncedAt;
              creativeReviewHistory = [];
              if (liveResult.freshness === "stale") {
                syncWarning =
                  "MaintainFlow could not refresh OpenAI Ads, so this is the last confirmed snapshot. External changes are locked until a fresh sync succeeds.";
              }

              if (creativeHistoryStoreReady) {
                try {
                  await recordCreativeReviewSnapshot({
                    accountId: live.account.id,
                    ads: live.ads,
                    observedAt: new Date(live.syncedAt),
                  });
                  creativeReviewHistory = await listCreativeReviewEvents(
                    live.account.id,
                  );
                } catch (error) {
                  log.error("workspace.creative_history_sync_failed", { error });
                  creativeHistoryError =
                    "The current creative data is available, but its durable change history could not be updated.";
                }
              } else {
                creativeHistoryError =
                  "Apply the creative review history migration to record changes between live account syncs.";
              }

              if (approvalStoreReady) {
                try {
                  if (liveResult.freshness !== "stale") {
                    const evaluation = await evaluateDueMonitoringWindows({
                      accountId: live.account.id,
                      credential,
                      now: new Date(live.syncedAt),
                    });
                    if (evaluation.failed > 0) {
                      monitoringEvaluationError =
                        "One or more completed windows could not be evaluated from live Insights. No missing data was treated as zero, and no rollback was sent.";
                    }
                  }
                } catch (error) {
                  log.error("workspace.monitoring_evaluation_failed", { error });
                  monitoringEvaluationError =
                    "Completed monitoring windows could not be checked during this sync. No rollback was sent.";
                }
                try {
                  const [historyRecords, activeRecords] = await Promise.all([
                    listApprovalRecords(live.account.id),
                    listActiveApprovalRecords(live.account.id),
                  ]);
                  approvalHistory = historyRecords.map(toApprovalRecordDto);
                  const activeApprovals = activeRecords.map(toApprovalRecordDto);
                  recommendations = suppressRecommendationsUnderActiveApproval(
                    recommendations,
                    activeApprovals,
                  );
                  monitoringWindows = buildMonitoringWindows(
                    activeApprovals,
                    new Date(live.syncedAt),
                  );
                } catch (error) {
                  log.error("workspace.approval_history_sync_failed", { error });
                  approvalHistoryError =
                    "The durable approval history could not be loaded. Live writes are locked until it is available.";
                }
              }

              if (recommendationDecisionStoreReady) {
                try {
                  const [dismissals, decisionHistory] = await Promise.all([
                    listActiveRecommendationDismissals(live.account.id),
                    listRecommendationDecisionHistory(live.account.id),
                  ]);
                  recommendations = applyRecommendationDismissals(
                    recommendations,
                    dismissals,
                  );
                  recommendationDecisionHistory = decisionHistory.map(
                    toRecommendationDecisionHistoryDto,
                  );
                } catch (error) {
                  log.error("workspace.recommendation_decision_sync_failed", {
                    error,
                  });
                  recommendationDecisionError =
                    "Saved recommendation dismissals could not be loaded, so dismissal actions are locked.";
                }
              } else {
                recommendationDecisionError =
                  "Apply the recommendation dismissal migration to retain review decisions after refresh.";
              }

              writeMode =
                runtime.writeInfrastructureConfigured &&
                approvalStoreReady &&
                !approvalHistoryError &&
                liveResult.freshness !== "stale" &&
                canWriteAccount(workspaceAccess)
                  ? "live"
                  : "demo";
            }
          }
        }
      } catch (error) {
        log.error("workspace.live_sync_failed", { error });
        if (runtime.liveDataRequested && runtime.liveReadStage) {
          workspaceSetupState = workspaceAccess
            ? "connection_error"
            : "unavailable";
          workspaceMessage = workspaceAccess
            ? "MaintainFlow could not load live Ads data. The connected account is retained, and an authorized workspace owner or admin with account-management access can replace its client key."
            : "The live advertiser workspace could not be loaded. No account data or external actions are available.";
          dataSource = "live";
          writeMode = "demo";
          account = {
            ...demoAccount,
            id:
              workspaceAccess?.accountId ??
              requestedAccountId ??
              "live-account-unavailable",
            name: workspaceAccess?.accountName ?? "Live account unavailable",
          };
          ads = [];
          campaigns = [];
          performance = [];
          recommendations = [];
          creativeReviewHistory = [];
          approvalHistory = [];
          monitoringWindows = [];
          recommendationDecisionHistory = [];
          conversionMeasurement = unavailableConversionMeasurement({
            source: "live",
            message:
              "A confirmed OpenAI Ads snapshot is required before conversion measurement can be assessed.",
          });
        }
        syncError =
          "Live sync failed. MaintainFlow is showing no account metrics or recommendations and has disabled all external writes; demo fixtures are not substituted for this connected account.";
      }
    }
  }

  const writeBlockers = [
    ...runtime.writeBlockers,
    ...(runtime.authConfigured && !authenticatedOperator
      ? ["signed-in operator session"]
      : []),
    ...(runtime.approvalStoreConfigured && !approvalStoreReady
      ? ["approval database migration"]
      : []),
    ...(workspaceAccess && !canWriteAccount(workspaceAccess)
      ? ["workspace write permission"]
      : []),
    ...(approvalHistoryError ? ["readable approval history"] : []),
    ...(syncError ? ["confirmed live Ads snapshot"] : []),
    ...(syncWarning ? ["fresh live Ads snapshot"] : []),
  ];
  const initialTab: AppTab =
    requestedTab ??
    (workspaceSetupState === "needs_setup" ||
    workspaceSetupState === "unavailable" ||
    workspaceSetupState === "connection_error"
      ? "workspace"
      : "review");
  const agencyClientAttachEnabled = Boolean(
    authenticatedOperator &&
      dataSource === "live" &&
      workspaceSetupState === "ready" &&
      workspaceAccess?.organizationType === "agency" &&
      (workspaceAccess.membershipRole === "owner" ||
        workspaceAccess.membershipRole === "admin"),
  );

  return (
    <MaintainFlowWorkbench
      key={`${account.id}:${initialTab}`}
      initialTab={initialTab}
      account={account}
      ads={ads}
      creativeReviewHistory={creativeReviewHistory}
      creativeHistoryReady={
        dataSource === "demo" ||
        (creativeHistoryStoreReady && !creativeHistoryError)
      }
      creativeHistoryError={creativeHistoryError}
      campaigns={campaigns}
      performance={performance}
      initialRecommendations={recommendations}
      recommendationApprovalFingerprints={Object.fromEntries(
        recommendations.map((recommendation) => [
          recommendation.id,
          recommendationApprovalFingerprint(recommendation),
        ]),
      )}
      recommendationFingerprints={Object.fromEntries(
        recommendations.map((recommendation) => [
          recommendation.id,
          recommendationFingerprint(recommendation),
        ]),
      )}
      dataSource={dataSource}
      writeMode={writeMode}
      syncedAt={syncedAt}
      snapshotAvailable={dataSource === "demo" || Boolean(syncedAt)}
      syncError={syncError}
      syncWarning={syncWarning}
      operator={operator}
      operatorAuthenticated={Boolean(authenticatedOperator)}
      authConfigured={runtime.authConfigured}
      writeBlockers={writeBlockers}
      approvalHistory={approvalHistory}
      monitoringWindows={monitoringWindows}
      monitoringEvaluationError={monitoringEvaluationError}
      conversionMeasurement={conversionMeasurement}
      approvalHistoryError={approvalHistoryError}
      approvalHistoryReady={
        dataSource === "live" && approvalStoreReady && !approvalHistoryError
      }
      workspaceSetupState={workspaceSetupState}
      workspaceAccess={workspaceAccess}
      workspaceAccountName={workspaceAccountName}
      workspaceMessage={workspaceMessage}
      conversionsConnection={conversionsConnection}
      availableAccounts={availableAccounts}
      agencyClientAttachEnabled={agencyClientAttachEnabled}
      recommendationDecisionReady={
        dataSource === "demo" ||
        (recommendationDecisionStoreReady && !recommendationDecisionError)
      }
      recommendationDecisionError={recommendationDecisionError}
      canManageRecommendationDecisions={
        dataSource === "demo" ||
        Boolean(workspaceAccess && canWriteAccount(workspaceAccess))
      }
      recommendationDecisionHistory={recommendationDecisionHistory}
      readinessHistoryReady={
        Boolean(workspaceAccess) &&
        readinessHistoryStoreReady &&
        !readinessHistoryError
      }
      readinessHistoryError={readinessHistoryError}
      initialReadinessHistory={readinessHistory}
      readinessHistoryCanSave={Boolean(
        workspaceAccess && canWriteAccount(workspaceAccess),
      )}
      simulatedAccounts={
        dataSource === "demo" ? simulatedWorkspace.accountOptions : []
      }
      simulatorLabel={
        dataSource === "demo" ? simulatedWorkspace.simulatorLabel : ""
      }
    />
  );
}
