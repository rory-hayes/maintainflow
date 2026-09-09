import "server-only";
import { randomUUID } from "node:crypto";
import { applicationOrigin } from "@/lib/application-origin.server";
import { getRuntimeDatabase } from "@/lib/database/client.server";
import { requireOperatorId } from "@/lib/auth/operator.server";
import { listOrganizationMemberships } from "@/lib/attribution/membership.server";
import {
  decryptAdsApiKey,
  encryptAdsApiKey,
  type EncryptedCredential,
} from "@/lib/credentials/crypto.server";
import { emptyWorkspace, pruneExpired, type Workspace } from "./model";

export class AttributionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function database() {
  if (!process.env.DATABASE_URL)
    throw new AttributionError(
      503,
      "Database is not configured. Configure the new MaintainCode database and apply migrations.",
    );
  return getRuntimeDatabase(process.env.DATABASE_URL);
}
export function localMode() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.MAINTAINCODE_LOCAL_TEST === "1"
  );
}
export async function identity(request: Request) {
  if (
    localMode() &&
    ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname)
  )
    return "maintaincode-local-operator";
  return requireOperatorId();
}
export async function authorize(request: Request, id: string, write = false) {
  const operator = await identity(request);
  const memberships = await listOrganizationMemberships(operator);
  const membership = memberships.find((m) => m.organizationId === id);
  if (
    !membership ||
    (write && !["owner", "admin"].includes(membership.membershipRole))
  )
    throw new AttributionError(
      403,
      "You do not have permission for this workspace.",
    );
  return membership;
}
export function sameOrigin(request: Request) {
  let trustedOrigin: string;
  try {
    trustedOrigin = applicationOrigin(request);
  } catch {
    throw new AttributionError(503, "Configure a valid application origin.");
  }
  // Next/proxy routing may normalize Request.url to an internal hostname.
  // The configured public origin stays authoritative; forwarded hosts do not.
  if (request.headers.get("origin") !== trustedOrigin)
    throw new AttributionError(
      403,
      "This action must come from your workspace.",
    );
}
export async function readWorkspace(id: string): Promise<Workspace> {
  const sql = database();
  return sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    const [row] =
      await tx`select state from maintaincode_workspaces where organization_id=${id}`;
    if (!row) throw new AttributionError(404, "Workspace not found.");
    const state = row.state as Workspace;
    pruneExpired(state);
    return state;
  }) as Promise<Workspace>;
}
export async function mutateWorkspace<T>(
  id: string,
  operation: (state: Workspace) => T,
  providerChange?: {
    provider: "hubspot" | "openai";
    secret?: string;
    operationId?: string;
    revoke?: boolean;
  },
): Promise<T> {
  const sql = database();
  return sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    const [row] =
      await tx`select state from maintaincode_workspaces where organization_id=${id} for update`;
    if (!row) throw new AttributionError(404, "Workspace not found.");
    const state = row.state as Workspace;
    pruneExpired(state);
    if (
      providerChange?.operationId &&
      state.connectors.find((c) => c.provider === providerChange.provider)
        ?.operationId !== providerChange.operationId
    )
      throw new AttributionError(
        409,
        "A newer connector action replaced this sync. Refresh the workspace.",
      );
    const result = operation(state);
    if (providerChange?.secret) {
      const sealed = sealCredential(
        id,
        providerChange.provider,
        providerChange.secret,
      );
      await tx`insert into maintaincode_credentials(organization_id,provider,sealed) values(${id},${providerChange.provider},${tx.json(sealed)}) on conflict(organization_id,provider) do update set sealed=excluded.sealed`;
    }
    if (providerChange?.revoke)
      await tx`delete from maintaincode_credentials where organization_id=${id} and provider=${providerChange.provider}`;
    const serializedState = JSON.stringify(state);
    if (Buffer.byteLength(serializedState, "utf8") > 12_000_000)
      throw new AttributionError(
        413,
        "Workspace storage limit reached. Export and apply retention before retrying.",
      );
    await tx`update maintaincode_workspaces set state=${tx.json(JSON.parse(serializedState))},updated_at=now() where organization_id=${id}`;
    await tx`delete from maintaincode_sites where organization_id=${id}`;
    for (const site of state.sites)
      await tx`insert into maintaincode_sites(id,organization_id,origin) values(${site.id},${id},${site.origin})`;
    return result;
  }) as Promise<T>;
}
export async function createWorkspace(
  request: Request,
  name: string,
  agency: boolean,
) {
  const operator = await identity(request);
  const sql = database();
  const id = randomUUID();
  const state = emptyWorkspace(id, name, localMode() ? "local" : "live");
  state.billing.plan = agency ? "agency" : "starter";
  await sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.actor_id',${operator},true)`;
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    await tx`insert into maintainflow_organizations(id,name,customer_type) values(${id},${name},${agency ? "agency" : "advertiser"})`;
    await tx`insert into maintainflow_organization_memberships(organization_id,clerk_user_id,role) values(${id},${operator},'owner')`;
    await tx`insert into maintaincode_workspaces(organization_id,state) values(${id},${tx.json(JSON.parse(JSON.stringify(state)))})`;
  });
  return state;
}
export async function siteOwner(siteId: string) {
  const sql = database();
  const [row] =
    await sql`select organization_id,origin from maintaincode_sites where id=${siteId}`;
  if (!row) throw new AttributionError(404, "Website not found.");
  return {
    organizationId: String(row.organization_id),
    origin: String(row.origin),
  };
}
type Sealed = Omit<
  EncryptedCredential,
  "ciphertext" | "initializationVector" | "authenticationTag"
> & {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
};
function sealCredential(
  id: string,
  provider: "hubspot" | "openai",
  secret: string,
) {
  const material = encryptAdsApiKey({
    apiKey: secret,
    externalAccountId: `maintaincode:${id}:${provider}`,
  });
  return {
    ...material,
    ciphertext: material.ciphertext.toString("base64"),
    initializationVector: material.initializationVector.toString("base64"),
    authenticationTag: material.authenticationTag.toString("base64"),
  };
}
export async function saveCredential(
  id: string,
  provider: "hubspot" | "openai",
  secret: string,
) {
  const sealed = sealCredential(id, provider, secret);
  const sql = database();
  await sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    await tx`insert into maintaincode_credentials(organization_id,provider,sealed) values(${id},${provider},${tx.json(sealed)}) on conflict(organization_id,provider) do update set sealed=excluded.sealed`;
  });
}
export async function credential(id: string, provider: "hubspot" | "openai") {
  const sql = database();
  return sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    const [row] =
      await tx`select sealed from maintaincode_credentials where organization_id=${id} and provider=${provider}`;
    if (!row)
      throw new AttributionError(409, "Connect this provider before syncing.");
    const s = row.sealed as Sealed;
    return decryptAdsApiKey(
      {
        ...s,
        ciphertext: Buffer.from(s.ciphertext, "base64"),
        initializationVector: Buffer.from(s.initializationVector, "base64"),
        authenticationTag: Buffer.from(s.authenticationTag, "base64"),
      },
      `maintaincode:${id}:${provider}`,
    );
  }) as Promise<string>;
}
export async function revokeCredential(id: string, provider: string) {
  const sql = database();
  await sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    await tx`delete from maintaincode_credentials where organization_id=${id} and provider=${provider}`;
  });
}
export function publicWorkspace(w: Workspace) {
  return {
    ...w,
    notifications: undefined,
    billing: {
      ...w.billing,
      customerId: undefined,
      subscriptionId: undefined,
      refreshGeneration: undefined,
      checkout: undefined,
    },
    submissions: w.submissions.map((s) => ({
      ...s,
      evidence: {
        ...s.evidence,
        first: {
          ...s.evidence.first,
          oppref: s.evidence.first.oppref ? "[protected]" : "",
        },
        latest: {
          ...s.evidence.latest,
          oppref: s.evidence.latest.oppref ? "[protected]" : "",
        },
      },
    })),
  };
}
