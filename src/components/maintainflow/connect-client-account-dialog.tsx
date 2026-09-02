"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  CirclePlus,
  Info,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { buildAppHref } from "@/lib/app-navigation";
import { accountAccessSchema } from "@/lib/tenancy/schema";

type FetchClient = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const attachResponseSchema = z
  .object({
    created: z.boolean(),
    credentialUpdated: z.boolean(),
    access: accountAccessSchema,
    message: z.string().optional(),
  })
  .passthrough();

const verifyResponseSchema = z
  .object({
    verified: z.literal(true),
    account: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    organization: z.object({ id: z.string().uuid(), name: z.string().min(1) }),
  })
  .passthrough();

const genericConnectionError =
  "The client account could not be connected. Check the advertiser key and try again.";

export class ClientAccountConnectionError extends Error {
  constructor(message = genericConnectionError) {
    super(message);
    this.name = "ClientAccountConnectionError";
  }
}

function safeResponseMessage(value: unknown, submittedKey: string) {
  if (typeof value !== "string") return null;
  const normalized = value.split(/\s+/u).join(" ").trim().slice(0, 320);
  if (!normalized || normalized.includes(submittedKey)) return null;
  return normalized;
}

function readObjectProperty(value: unknown, property: string) {
  if (!value || typeof value !== "object" || !(property in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[property];
}

export async function connectClientAdvertiserAccount(options: {
  organizationId: string;
  adsApiKey: string;
  expectedAccountId: string;
  fetchClient?: FetchClient;
}) {
  const submittedKey = options.adsApiKey.trim();
  const fetchClient = options.fetchClient ?? fetch;
  let response: Response;

  try {
    response = await fetchClient(
      `/api/organizations/${encodeURIComponent(options.organizationId)}/advertiser-accounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          adsApiKey: submittedKey,
          expectedAccountId: options.expectedAccountId,
        }),
      },
    );
  } catch {
    throw new ClientAccountConnectionError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ClientAccountConnectionError(
      safeResponseMessage(
        readObjectProperty(payload, "error"),
        submittedKey,
      ) ?? genericConnectionError,
    );
  }

  const parsed = attachResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.access.organizationId !== options.organizationId ||
    parsed.data.access.organizationType !== "agency" ||
    !["owner", "admin"].includes(parsed.data.access.membershipRole) ||
    parsed.data.access.accountRole !== "manager"
  ) {
    throw new ClientAccountConnectionError(
      "OpenAI verified the key, but MaintainFlow could not confirm the attached agency account. Refresh before trying again.",
    );
  }

  return {
    created: parsed.data.created,
    credentialUpdated: parsed.data.credentialUpdated,
    access: parsed.data.access,
    message: safeResponseMessage(parsed.data.message, submittedKey),
  };
}

export async function verifyClientAdvertiserAccount(options: {
  organizationId: string;
  adsApiKey: string;
  fetchClient?: FetchClient;
}) {
  const submittedKey = options.adsApiKey.trim();
  const fetchClient = options.fetchClient ?? fetch;
  let response: Response;

  try {
    response = await fetchClient(
      `/api/organizations/${encodeURIComponent(options.organizationId)}/advertiser-accounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", adsApiKey: submittedKey }),
      },
    );
  } catch {
    throw new ClientAccountConnectionError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new ClientAccountConnectionError(
      safeResponseMessage(readObjectProperty(payload, "error"), submittedKey) ??
        genericConnectionError,
    );
  }

  const parsed = verifyResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.organization.id !== options.organizationId
  ) {
    throw new ClientAccountConnectionError(
      "OpenAI verified the key, but MaintainFlow could not confirm the target agency. Refresh before trying again.",
    );
  }
  return parsed.data;
}

type ConnectClientAccountFieldsProps = {
  adsApiKey: string;
  attempted: boolean;
  error: string | null;
  organizationName: string;
  submitting: boolean;
  onAdsApiKeyChange: (value: string) => void;
  onCancel: () => void;
};

export function ConnectClientAccountFields({
  adsApiKey,
  attempted,
  error,
  organizationName,
  submitting,
  onAdsApiKeyChange,
  onCancel,
}: ConnectClientAccountFieldsProps) {
  const keyInvalid = attempted && adsApiKey.trim().length < 10;

  return (
    <>
      <FieldGroup>
        <Alert>
          <Info />
          <AlertTitle>Identity comes from OpenAI</AlertTitle>
          <AlertDescription>
            MaintainFlow uses the key to discover and verify the advertiser
            account ID and name with OpenAI. You never enter either value here.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive">
            <ShieldCheck />
            <AlertTitle>Client account was not connected</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Field data-invalid={keyInvalid || undefined}>
          <FieldLabel htmlFor="agency-client-ads-api-key">
            OpenAI Ads advertiser key
          </FieldLabel>
          <Input
            id="agency-client-ads-api-key"
            name="adsApiKey"
            type="password"
            value={adsApiKey}
            onChange={(event) => onAdsApiKeyChange(event.target.value)}
            placeholder="Paste the account-scoped advertiser key"
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={keyInvalid || undefined}
            disabled={submitting}
          />
          <FieldDescription>
            Use the account-scoped advertiser key issued in OpenAI Ads Manager,
            not an OpenAI Platform API key. MaintainFlow verifies the resolved
            advertiser first; nothing is attached until you confirm it for{" "}
            {organizationName}.
          </FieldDescription>
          {keyInvalid ? (
            <FieldError>Check the advertiser key and try again.</FieldError>
          ) : null}
        </Field>
      </FieldGroup>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={adsApiKey.trim().length < 10 || submitting}
        >
          {submitting ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <KeyRound data-icon="inline-start" />
          )}
          {submitting ? "Verifying with OpenAI…" : "Verify advertiser account"}
        </Button>
      </DialogFooter>
    </>
  );
}

type ConnectClientAccountDialogProps = {
  organizationId: string;
  organizationName: string;
};

export function ConnectClientAccountDialog({
  organizationId,
  organizationName,
}: ConnectClientAccountDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [adsApiKey, setAdsApiKey] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verifiedAccount, setVerifiedAccount] = useState<{
    id: string;
    name: string;
  } | null>(null);

  function resetSensitiveState() {
    setAdsApiKey("");
    setAttempted(false);
    setError(null);
    setVerifiedAccount(null);
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && submitting) return;
    if (!nextOpen) resetSensitiveState();
    setOpen(nextOpen);
  }

  function updateKey(value: string) {
    setAdsApiKey(value);
    setAttempted(false);
    setError(null);
    setVerifiedAccount(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    setError(null);
    if (adsApiKey.trim().length < 10 || submitting) return;

    setSubmitting(true);
    try {
      if (!verifiedAccount) {
        const verified = await verifyClientAdvertiserAccount({
          organizationId,
          adsApiKey,
        });
        setVerifiedAccount(verified.account);
        setAttempted(false);
        toast.success("Advertiser account verified", {
          description: `Confirm ${verified.account.name} before MaintainFlow stores the encrypted key.`,
        });
        return;
      }
      const result = await connectClientAdvertiserAccount({
        organizationId,
        adsApiKey,
        expectedAccountId: verifiedAccount.id,
      });
      resetSensitiveState();
      setOpen(false);
      toast.success("Client account connected", {
        description:
          result.message ??
          `${result.access.accountName} is now available in this agency workspace.`,
      });
      router.push(
        buildAppHref({ tab: "workspace", accountId: result.access.accountId }),
      );
    } catch (caught) {
      const detail =
        caught instanceof ClientAccountConnectionError
          ? caught.message
          : genericConnectionError;
      setAdsApiKey("");
      setAttempted(false);
      setVerifiedAccount(null);
      setError(detail);
      toast.error("Unable to connect client account", {
        description: detail,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <CirclePlus data-icon="inline-start" />
          Connect client account
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect another client account</DialogTitle>
          <DialogDescription>
            Add an OpenAI Ads advertiser account to {organizationName}. Only its
            account-scoped advertiser key is needed.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          {verifiedAccount ? (
            <>
              <Alert>
                <ShieldCheck />
                <AlertTitle>Confirm the resolved advertiser</AlertTitle>
                <AlertDescription>
                  OpenAI says this key belongs to the account below. Confirm
                  both the advertiser and target agency before the key is
                  encrypted and attached.
                </AlertDescription>
              </Alert>
              <dl className="grid gap-3 rounded-lg border bg-muted/30 p-4 text-sm">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Advertiser
                  </dt>
                  <dd className="mt-1 font-medium">{verifiedAccount.name}</dd>
                  <dd className="font-mono text-xs text-muted-foreground">
                    {verifiedAccount.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Agency workspace
                  </dt>
                  <dd className="mt-1 font-medium">{organizationName}</dd>
                </div>
              </dl>
              {error ? (
                <Alert variant="destructive">
                  <ShieldCheck />
                  <AlertTitle>Client account was not connected</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => changeOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVerifiedAccount(null)}
                  disabled={submitting}
                >
                  Back
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <ShieldCheck data-icon="inline-start" />
                  )}
                  {submitting ? "Connecting account…" : "Confirm connection"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <ConnectClientAccountFields
              adsApiKey={adsApiKey}
              attempted={attempted}
              error={error}
              organizationName={organizationName}
              submitting={submitting}
              onAdsApiKeyChange={updateKey}
              onCancel={() => changeOpen(false)}
            />
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
