import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServerLogger } from "./logger.server";
import type { ServerLogEvent, ServerLogScope } from "./logger.server";

const secret = "PLANTED_SECRET_8f61b49d";

describe("privacy-safe server logging", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const name of [
      "OPENAI_ADS_API_KEY",
      "OPENAI_CONVERSIONS_API_KEY",
      "CLERK_SECRET_KEY",
      "DATABASE_URL",
      "CRON_SECRET",
      "MAINTAINFLOW_READINESS_PROBE_SECRET",
      "READINESS_RATE_LIMIT_SECRET",
      "MAINTAINFLOW_CREDENTIAL_KEYRING",
      "MAINTAINFLOW_COMPILED_BUILD_SHA",
    ]) {
      vi.stubEnv(name, `${name}_${secret}`);
    }
    vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits one allowlisted JSON record without messages, stacks, causes, codes, or secrets", () => {
    const error = Object.assign(
      new Error(`database failed at postgres://${secret}`, {
        cause: new Error(`Bearer ${secret}`),
      }),
      { code: `CODE_${secret}` },
    );
    error.name = `Unsafe${secret}`;

    createServerLogger("api.deployment.ready").error(
      "deployment.readiness.failed",
      {
        error,
        status: 503,
        durationMs: 12.4,
        failedChecks: ["live_sync", secret],
        timedOutChecks: ["database_runtime_role", secret],
        counts: { checksPassed: 3, checksTotal: 5, [secret]: 99 },
      },
    );

    expect(console.error).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error).mock.calls[0]).toHaveLength(1);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain(secret);
    expect(line).not.toContain("postgres://");
    expect(line).not.toContain("Bearer");
    expect(line).not.toContain("database failed");
    expect(line).not.toContain("stack");
    expect(JSON.parse(line)).toMatchObject({
      service: "maintainflow-ads",
      level: "error",
      event: "deployment.readiness.failed",
      scope: "api.deployment.ready",
      stage: "private_read",
      revision: "unknown",
      errorKind: "application_error",
      status: 503,
      durationMs: 12,
      failedChecks: ["live_sync", "unknown_check"],
      timedOutChecks: ["database_runtime_role", "unknown_check"],
      counts: { checksPassed: 3, checksTotal: 5 },
    });
  });

  it("replaces an injectable event name and never emits a second line", () => {
    createServerLogger("api.readiness.audit").warn(
      `customer.${secret.toLowerCase()}` as ServerLogEvent,
    );

    expect(console.warn).toHaveBeenCalledOnce();
    const line = String(vi.mocked(console.warn).mock.calls[0][0]);
    expect(line).not.toContain(secret);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).event).toBe("observability.invalid_event");
  });

  it("accepts the account-free route scopes and lifecycle events", () => {
    const cases: ReadonlyArray<[ServerLogScope, ServerLogEvent]> = [
      ["api.onboarding.workspace", "onboarding.workspace.completed"],
      ["api.agency.account_attach", "agency.account_attach.completed"],
      [
        "api.ads.recommendation_decision",
        "ads.recommendation_decision.completed",
      ],
      [
        "api.measurements.conversions_validate",
        "conversions.validate_only.completed",
      ],
    ];

    for (const [scope, event] of cases) {
      createServerLogger(scope).info(event, { status: 200 });
    }

    expect(console.info).toHaveBeenCalledTimes(cases.length);
    const records = vi.mocked(console.info).mock.calls.map(([line]) =>
      JSON.parse(String(line)),
    );
    expect(records.map(({ scope, event }) => ({ scope, event }))).toEqual(
      cases.map(([scope, event]) => ({ scope, event })),
    );
  });

  it.each([
    ["WorkspaceRequestInvalidError", "validation_error"],
    ["AdvertiserAccountAttachRequestInvalidError", "validation_error"],
    ["AdvertiserAccountAttachConflictError", "conflict_error"],
    ["RecommendationDecisionRequestInvalidError", "validation_error"],
    ["ConversionValidationRequestInvalidError", "validation_error"],
    ["RequestBodyTooLargeError", "request_too_large"],
    ["OperatorAuthUnavailableError", "authentication_unavailable"],
    ["RecommendationDecisionTransitionError", "conflict_error"],
    ["RecommendationDecisionStoreUnavailableError", "storage_error"],
    ["ConversionsApiProviderRejectedError", "provider_rejected"],
    ["ConversionsApiTransportUnconfirmedError", "transport_unconfirmed"],
    ["ConversionsApiValidationUnavailableError", "provider_unavailable"],
  ])("classifies %s without recording its message", (name, errorKind) => {
    const error = new Error(`Unsafe ${secret}`);
    error.name = name;

    createServerLogger("api.measurements.conversions_validate").error(
      "conversions.validate_only.failed",
      { error, status: 500 },
    );

    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({ errorKind, status: 500 });
  });
});
