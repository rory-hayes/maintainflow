"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Check,
  DatabaseZap,
  KeyRound,
  Loader2,
  Send,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConversionsConnectionStatus } from "@/lib/openai-ads/conversions-connection";
import {
  auditConversionsApiPayload,
  createConversionsApiSample,
} from "@/lib/readiness/conversions-api";
import type {
  AccountAccess,
  OrganizationType,
} from "@/lib/tenancy/schema";
import { canWriteAccount } from "@/lib/tenancy/schema";

export type WorkspaceSetupState =
  | "demo"
  | "needs_setup"
  | "ready"
  | "connection_error"
  | "unavailable";

type WorkspaceOnboardingProps = {
  state: WorkspaceSetupState;
  access?: AccountAccess;
  connectedAccountName?: string;
  message?: string;
  conversionsConnection: ConversionsConnectionStatus;
};

const setupSteps = [
  {
    title: "Identity and workspace",
    description: "Clerk identity is mapped to an advertiser or agency organization.",
    icon: Users,
  },
  {
    title: "Account-scoped connection",
    description:
      "The server verifies the OpenAI Ads account before encrypting its client key.",
    icon: KeyRound,
  },
  {
    title: "Permissioned operations",
    description: "Review, apply, rollback, and reconciliation use account roles on every request.",
    icon: ShieldCheck,
  },
] as const;

const stateContent: Record<
  WorkspaceSetupState,
  { title: string; description: string; badge: string; progress: number }
> = {
  demo: {
    title: "Workspace setup preview",
    description:
      "Preview how an advertiser or agency will be linked when live access is configured.",
    badge: "Preview",
    progress: 0,
  },
  needs_setup: {
    title: "Create your workspace",
    description:
      "Choose the customer relationship and connect its account-scoped Ads key.",
    badge: "Setup",
    progress: 66,
  },
  ready: {
    title: "Connected workspace",
    description:
      "Your identity and connected account permissions are verified.",
    badge: "Ready",
    progress: 100,
  },
  connection_error: {
    title: "Connected workspace needs attention",
    description:
      "Your account access is retained while live Ads data remains unavailable.",
    badge: "Needs attention",
    progress: 66,
  },
  unavailable: {
    title: "Workspace setup unavailable",
    description: "Resolve the access issue above before connecting an account.",
    badge: "Locked",
    progress: 0,
  },
};

const measurementStateContent: Record<
  ConversionsConnectionStatus["state"],
  { title: string; description: string; badge: string }
> = {
  preview: {
    title: "Measurement connection preview",
    description:
      "A live workspace can connect its separate Pixel and Conversions API credential here.",
    badge: "Preview",
  },
  not_connected: {
    title: "Measurement is not connected",
    description:
      "Add the account's Pixel and Conversions API key before validating server events.",
    badge: "Not connected",
  },
  configured: {
    title: "Pilot measurement credential configured",
    description:
      "A server-managed Pixel and CAPI key are configured, but no retained provider validation evidence exists.",
    badge: "Configured",
  },
  connected: {
    title: "Measurement credential validated",
    description:
      "The active Pixel and CAPI key passed a dry-run request before encrypted storage.",
    badge: "Connected",
  },
  unavailable: {
    title: "Measurement setup unavailable",
    description:
      "The encrypted conversion credential store is not ready for this workspace.",
    badge: "Locked",
  },
};

const validationTimeFormatter = new Intl.DateTimeFormat("en-IE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatValidationTime(value: string | null) {
  if (!value) return "No retained validation";
  return validationTimeFormatter.format(new Date(value));
}

export function WorkspaceOnboarding({
  state,
  access,
  connectedAccountName,
  message,
  conversionsConnection,
}: WorkspaceOnboardingProps) {
  const router = useRouter();
  const [organizationName, setOrganizationName] = useState("");
  const [organizationType, setOrganizationType] =
    useState<OrganizationType>("advertiser");
  const [adsApiKey, setAdsApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rotationOpen, setRotationOpen] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [rotating, setRotating] = useState(false);
  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [pixelId, setPixelId] = useState("");
  const [conversionsApiKey, setConversionsApiKey] = useState("");
  const [validationPayload, setValidationPayload] = useState("");
  const [measurementAttempted, setMeasurementAttempted] = useState(false);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [measurementConnecting, setMeasurementConnecting] = useState(false);
  const nameInvalid =
    organizationName.length > 0 && organizationName.trim().length < 2;
  const keyInvalid = adsApiKey.length > 0 && adsApiKey.trim().length < 10;
  const connectionReady =
    adsApiKey.trim().length >= 10 || Boolean(connectedAccountName);
  const replacementKeyInvalid =
    replacementKey.length > 0 && replacementKey.trim().length < 10;
  const canManageConnection = access ? canWriteAccount(access) : false;
  const hasConnectedWorkspace =
    Boolean(access) && (state === "ready" || state === "connection_error");
  const content = stateContent[state];
  const measurementContent = measurementStateContent[conversionsConnection.state];
  const pixelInvalid = measurementAttempted && pixelId.trim().length === 0;
  const conversionsKeyInvalid =
    measurementAttempted && conversionsApiKey.trim().length < 10;
  const validationPayloadInvalid =
    measurementAttempted && validationPayload.trim().length === 0;
  const canOpenMeasurementConnection =
    state === "ready" &&
    Boolean(access) &&
    canManageConnection &&
    conversionsConnection.state !== "unavailable" &&
    conversionsConnection.validationEnabled;

  function resetMeasurementConnection() {
    setPixelId("");
    setConversionsApiKey("");
    setValidationPayload("");
    setMeasurementAttempted(false);
    setMeasurementError(null);
  }

  function openMeasurementConnection() {
    resetMeasurementConnection();
    setValidationPayload(createConversionsApiSample());
    setMeasurementOpen(true);
  }

  async function createWorkspace() {
    if (
      state !== "needs_setup" ||
      organizationName.trim().length < 2 ||
      !connectionReady
    ) {
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/onboarding/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationName,
          organizationType,
          adsApiKey: adsApiKey.trim() || undefined,
        }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Workspace setup failed.");
      setAdsApiKey("");
      toast.success("Workspace created", { description: result.message });
      router.refresh();
    } catch (error) {
      toast.error("Unable to create workspace", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function rotateCredential() {
    if (
      !access ||
      !canManageConnection ||
      replacementKey.trim().length < 10
    ) {
      return;
    }
    setRotating(true);
    try {
      const response = await fetch(
        `/api/connections/openai-ads/${encodeURIComponent(access.accountId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adsApiKey: replacementKey.trim() }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? "The client key could not be replaced.");
      }
      setReplacementKey("");
      setRotationOpen(false);
      toast.success("Client key replaced", { description: result.message });
      router.refresh();
    } catch (error) {
      toast.error("Unable to replace client key", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setRotating(false);
    }
  }

  async function connectMeasurement() {
    setMeasurementAttempted(true);
    setMeasurementError(null);
    if (
      !access ||
      !canOpenMeasurementConnection ||
      pixelId.trim().length === 0 ||
      conversionsApiKey.trim().length < 10 ||
      validationPayload.trim().length === 0
    ) {
      return;
    }

    const audit = auditConversionsApiPayload(validationPayload);
    if (audit.blockerCount > 0 || audit.validateOnly !== true) {
      const detail = `Resolve ${audit.blockerCount} blocker${audit.blockerCount === 1 ? "" : "s"} and keep validate_only set to true.`;
      setMeasurementError(detail);
      toast.error("Dry-run payload needs attention", { description: detail });
      return;
    }

    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = JSON.parse(validationPayload) as Record<string, unknown>;
    } catch {
      setMeasurementError("Enter a valid JSON object for the dry-run payload.");
      return;
    }

    setMeasurementConnecting(true);
    try {
      const response = await fetch(
        `/api/connections/openai-conversions/${encodeURIComponent(access.accountId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pixelId: pixelId.trim(),
            conversionsApiKey: conversionsApiKey.trim(),
            validationPayload: parsedPayload,
          }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.error ?? "The measurement credentials could not be connected.",
        );
      }

      setMeasurementConnecting(false);
      setMeasurementOpen(false);
      resetMeasurementConnection();
      toast.success("Measurement credentials connected", {
        description: result.message,
      });
      router.refresh();
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Please try again.";
      setMeasurementError(detail);
      toast.error("Unable to connect measurement", { description: detail });
    } finally {
      setMeasurementConnecting(false);
    }
  }

  return (
    <section className="mx-auto grid min-w-0 max-w-6xl gap-6 p-4 md:p-6 lg:p-8">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">
          Workspace and account access
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          MaintainFlow supports direct advertisers and agencies with separate
          organization roles layered over the same advertiser account.
        </p>
      </div>

      {state === "unavailable" ? (
        <Alert variant="destructive">
          <ShieldCheck />
          <AlertTitle>Workspace access unavailable</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {state === "connection_error" ? (
        <Alert variant="destructive">
          <KeyRound />
          <AlertTitle>Live account connection needs attention</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <CardTitle className="text-base">
                  {content.title}
                </CardTitle>
                <CardDescription>{content.description}</CardDescription>
              </div>
              <Badge variant={state === "ready" ? "default" : "outline"}>
                {content.badge}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {hasConnectedWorkspace && access ? (
              <div className="grid gap-5">
                <div className="grid gap-1">
                  <p className="text-sm text-muted-foreground">Organization</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{access.organizationName}</p>
                    <Badge variant="secondary" className="capitalize">
                      {access.organizationType}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-1">
                  <p className="text-sm text-muted-foreground">Advertiser account</p>
                  <p className="font-semibold">{access.accountName}</p>
                  <p className="font-mono text-xs text-muted-foreground">{access.accountId}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="capitalize">
                    Workspace {access.membershipRole}
                  </Badge>
                  <Badge variant="outline" className="capitalize">
                    Account {access.accountRole}
                  </Badge>
                  <Badge variant="outline">
                    {access.connectionMode === "vault"
                      ? "Encrypted client key"
                      : "Configured pilot key"}
                  </Badge>
                </div>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRotationOpen(true)}
                    disabled={!canManageConnection}
                  >
                    <KeyRound data-icon="inline-start" />
                    {access.connectionMode === "vault"
                      ? "Replace client key"
                      : "Move to encrypted client key"}
                  </Button>
                  {!canManageConnection ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Workspace owners and admins with account-management access
                      can replace this connection.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <FieldGroup>
                <FieldSet>
                  <FieldLegend variant="label">Customer relationship</FieldLegend>
                  <FieldDescription>
                    Advertisers own the account. Agencies manage it for a client.
                  </FieldDescription>
                  <ToggleGroup
                    type="single"
                    value={organizationType}
                    onValueChange={(value) => {
                      if (value) setOrganizationType(value as OrganizationType);
                    }}
                    variant="outline"
                    className="grid grid-cols-2"
                  >
                    <ToggleGroupItem value="advertiser" aria-label="Direct advertiser">
                      <Building2 data-icon="inline-start" />
                      Advertiser
                    </ToggleGroupItem>
                    <ToggleGroupItem value="agency" aria-label="Agency managing a client">
                      <Users data-icon="inline-start" />
                      Agency
                    </ToggleGroupItem>
                  </ToggleGroup>
                </FieldSet>
                <Field data-invalid={nameInvalid || undefined}>
                  <FieldLabel htmlFor="organization-name">Workspace name</FieldLabel>
                  <Input
                    id="organization-name"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    placeholder={organizationType === "agency" ? "Northstar Agency" : "Harbour Home"}
                    aria-invalid={nameInvalid || undefined}
                    disabled={state === "unavailable"}
                  />
                  <FieldDescription>
                    This identifies the customer organization in every approval record.
                  </FieldDescription>
                  {nameInvalid ? (
                    <FieldError>Enter at least two characters.</FieldError>
                  ) : null}
                </Field>
                <Field data-invalid={keyInvalid || undefined}>
                  <FieldLabel htmlFor="ads-api-key">
                    Client Ads API key
                  </FieldLabel>
                  <Input
                    id="ads-api-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={adsApiKey}
                    onChange={(event) => setAdsApiKey(event.target.value)}
                    placeholder="Paste the account-scoped key"
                    aria-invalid={keyInvalid || undefined}
                    disabled={state !== "needs_setup"}
                  />
                  <FieldDescription>
                    Issued in OpenAI Ads Manager for one client account.
                    MaintainFlow verifies it, encrypts it on the server, and
                    never displays it again.
                  </FieldDescription>
                  {keyInvalid ? (
                    <FieldError>Check the account key and try again.</FieldError>
                  ) : null}
                </Field>
                {connectedAccountName ? (
                  <Alert>
                    <KeyRound />
                    <AlertTitle>Configured pilot account available</AlertTitle>
                    <AlertDescription>
                      {connectedAccountName}. Leave the client key empty to use
                      this server-managed pilot connection.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            )}
          </CardContent>
          {!hasConnectedWorkspace ? (
            <CardFooter className="justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {state === "demo"
                  ? "No credential is collected in preview mode."
                  : "The key is encrypted before storage and never returned to this browser."}
              </p>
              <Button
                onClick={createWorkspace}
                disabled={
                  state !== "needs_setup" ||
                  organizationName.trim().length < 2 ||
                  !connectionReady ||
                  submitting
                }
              >
                {submitting ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                {state === "needs_setup"
                  ? "Create workspace"
                  : state === "demo"
                    ? "Preview only"
                    : "Setup unavailable"}
              </Button>
            </CardFooter>
          ) : null}
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Access model</CardTitle>
            <CardDescription>
              Every protected action must pass all three checks.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Progress value={content.progress} />
            <div className="grid gap-5">
              {setupSteps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <div key={step.title} className="flex items-start gap-3">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Icon />
                    </div>
                    <div className="min-w-0 grid gap-1">
                      <p className="text-sm font-medium">
                        {index + 1}. {step.title}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {step.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0 shadow-sm">
        <CardHeader>
          <div className="flex flex-col justify-between gap-4 min-[640px]:flex-row min-[640px]:items-start">
            <div className="grid gap-1">
              <CardTitle className="text-base">
                {measurementContent.title}
              </CardTitle>
              <CardDescription>
                {measurementContent.description}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={
                  conversionsConnection.state === "connected"
                    ? "default"
                    : "outline"
                }
              >
                {measurementContent.badge}
              </Badge>
              <Badge variant="outline">
                {conversionsConnection.validationEnabled
                  ? "Dry runs enabled"
                  : "Dry runs paused"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1 rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Credential source</p>
              <p className="text-sm font-medium">
                {conversionsConnection.source === "vault"
                  ? `Encrypted vault · v${conversionsConnection.credentialVersion}`
                  : conversionsConnection.source === "environment"
                    ? "Configured pilot"
                    : "None"}
              </p>
            </div>
            <div className="grid gap-1 rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Last validation</p>
              <p className="text-sm font-medium">
                {formatValidationTime(conversionsConnection.validatedAt)}
              </p>
            </div>
            <div className="grid gap-1 rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Retained evidence</p>
              <p className="text-sm font-medium">
                {conversionsConnection.providerStatus
                  ? `HTTP ${conversionsConnection.providerStatus} · ${conversionsConnection.eventCount} event${conversionsConnection.eventCount === 1 ? "" : "s"}`
                  : "No provider receipt"}
              </p>
            </div>
          </div>

          <Alert>
            <DatabaseZap />
            <AlertTitle>Separate measurement credential</AlertTitle>
            <AlertDescription>
              This is not the Ads API or OpenAI Platform key. MaintainFlow never
              displays the Pixel or CAPI key after setup, and this flow can send
              only <code>validate_only: true</code> requests that do not save events.
            </AlertDescription>
          </Alert>

          {!conversionsConnection.validationEnabled && state === "ready" ? (
            <Alert>
              <ShieldCheck />
              <AlertTitle>Provider validation is paused</AlertTitle>
              <AlertDescription>
                Enable the server-side Conversions API dry-run gate before
                connecting or replacing measurement credentials.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-col items-start justify-between gap-3 min-[640px]:flex-row min-[640px]:items-center">
          <p className="text-xs leading-5 text-muted-foreground">
            A provider 2xx proves only that the dry-run request was accepted. Pixel
            ownership, Ads Manager visibility, matching, and attribution still
            require live account evidence.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={openMeasurementConnection}
            disabled={!canOpenMeasurementConnection}
          >
            <Send data-icon="inline-start" />
            {conversionsConnection.state === "connected"
              ? "Replace measurement credentials"
              : conversionsConnection.state === "configured"
                ? "Move measurement to vault"
                : "Connect measurement"}
          </Button>
        </CardFooter>
      </Card>

      <Dialog
        open={rotationOpen}
        onOpenChange={(open) => {
          setRotationOpen(open);
          if (!open) setReplacementKey("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the client Ads API key</DialogTitle>
            <DialogDescription>
              MaintainFlow will verify that the new key resolves to {access?.accountName}
              before replacing the current encrypted credential.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={replacementKeyInvalid || undefined}>
              <FieldLabel htmlFor="replacement-ads-api-key">
                New account-scoped key
              </FieldLabel>
              <Input
                id="replacement-ads-api-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={replacementKey}
                onChange={(event) => setReplacementKey(event.target.value)}
                placeholder="Paste the replacement key"
                aria-invalid={replacementKeyInvalid || undefined}
              />
              <FieldDescription>
                The existing credential remains active unless the replacement
                validates and is stored successfully.
              </FieldDescription>
              {replacementKeyInvalid ? (
                <FieldError>Check the account key and try again.</FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRotationOpen(false)}
              disabled={rotating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={rotateCredential}
              disabled={replacementKey.trim().length < 10 || rotating}
            >
              {rotating ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              Verify and replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={measurementOpen}
        onOpenChange={(open) => {
          if (measurementConnecting && !open) return;
          setMeasurementOpen(open);
          if (!open) resetMeasurementConnection();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect conversion measurement</DialogTitle>
            <DialogDescription>
              Validate a Pixel and separate Conversions API key with one dry-run
              batch before encrypting them for {access?.accountName ?? "this account"}.
            </DialogDescription>
          </DialogHeader>

          <Alert>
            <ShieldCheck />
            <AlertTitle>Dry-run and privacy boundary</AlertTitle>
            <AlertDescription>
              The supplied JSON must keep <code>validate_only</code> set to true.
              Use the safe sample or remove user identifiers; never paste raw
              personal data or any credential into the JSON body.
            </AlertDescription>
          </Alert>

          {measurementError ? (
            <Alert variant="destructive">
              <ShieldCheck />
              <AlertTitle>Connection was not changed</AlertTitle>
              <AlertDescription>{measurementError}</AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            <Field data-invalid={pixelInvalid || undefined}>
              <FieldLabel htmlFor="conversion-pixel-id">Pixel ID</FieldLabel>
              <Input
                id="conversion-pixel-id"
                value={pixelId}
                onChange={(event) => {
                  setPixelId(event.target.value);
                  setMeasurementError(null);
                }}
                placeholder="Paste the Pixel ID from Ads Manager"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={pixelInvalid || undefined}
                disabled={measurementConnecting}
              />
              <FieldDescription>
                Sent only as the documented <code>pid</code> query parameter and
                encrypted with the CAPI key after validation.
              </FieldDescription>
              {pixelInvalid ? <FieldError>Enter the Pixel ID.</FieldError> : null}
            </Field>

            <Field data-invalid={conversionsKeyInvalid || undefined}>
              <FieldLabel htmlFor="conversion-api-key">
                Conversions API key
              </FieldLabel>
              <Input
                id="conversion-api-key"
                type="password"
                value={conversionsApiKey}
                onChange={(event) => {
                  setConversionsApiKey(event.target.value);
                  setMeasurementError(null);
                }}
                placeholder="Paste the separate server-to-server key"
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={conversionsKeyInvalid || undefined}
                disabled={measurementConnecting}
              />
              <FieldDescription>
                This is issued for Conversions API setup and is not the Ads API
                or OpenAI Platform key.
              </FieldDescription>
              {conversionsKeyInvalid ? (
                <FieldError>Check the CAPI key and try again.</FieldError>
              ) : null}
            </Field>

            <Field data-invalid={validationPayloadInvalid || undefined}>
              <FieldLabel htmlFor="conversion-validation-payload">
                Dry-run event JSON
              </FieldLabel>
              <Textarea
                id="conversion-validation-payload"
                value={validationPayload}
                onChange={(event) => {
                  setValidationPayload(event.target.value);
                  setMeasurementError(null);
                }}
                rows={11}
                className="min-h-56"
                spellCheck={false}
                aria-invalid={validationPayloadInvalid || undefined}
                disabled={measurementConnecting}
              />
              <FieldDescription>
                The safe sample uses current timestamps and no user-matching
                fields. MaintainFlow revalidates it on the server and overwrites
                the integration source.
              </FieldDescription>
              {validationPayloadInvalid ? (
                <FieldError>Enter the dry-run JSON body.</FieldError>
              ) : null}
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMeasurementOpen(false)}
              disabled={measurementConnecting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={connectMeasurement}
              disabled={
                pixelId.trim().length === 0 ||
                conversionsApiKey.trim().length < 10 ||
                validationPayload.trim().length === 0 ||
                measurementConnecting
              }
            >
              {measurementConnecting ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Send data-icon="inline-start" />
              )}
              Validate and encrypt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
