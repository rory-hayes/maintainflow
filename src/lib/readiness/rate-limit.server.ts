import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import type postgres from "postgres";
import type { Sql } from "postgres";

import { getRuntimeDatabase } from "../database/client.server";

const WINDOW_MS = 60 * 60 * 1_000;
const IP_LIMIT = 6;
const HOST_LIMIT = 30;
const MINIMUM_SECRET_LENGTH = 32;

type RateLimitScope = "readiness_ip" | "readiness_host";

type BucketDecision = {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
};

export type ReadinessRateLimitDecision = BucketDecision & {
  limit: number;
};

export class ReadinessRateLimitUnavailableError extends Error {
  constructor(message = "Readiness rate limiting is not configured.") {
    super(message);
    this.name = "ReadinessRateLimitUnavailableError";
  }
}

export function isReadinessRateLimitConfigured() {
  return Boolean(
    process.env.DATABASE_URL &&
      process.env.READINESS_RATE_LIMIT_SECRET &&
      process.env.READINESS_RATE_LIMIT_SECRET.length >= MINIMUM_SECRET_LENGTH,
  );
}

function getDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new ReadinessRateLimitUnavailableError();
  }
  return getRuntimeDatabase(process.env.DATABASE_URL);
}

function subjectHash(scope: RateLimitScope, subject: string) {
  const secret = process.env.READINESS_RATE_LIMIT_SECRET;
  if (!secret || secret.length < MINIMUM_SECRET_LENGTH) {
    throw new ReadinessRateLimitUnavailableError();
  }
  return createHmac("sha256", secret)
    .update(`${scope}\0${subject}`)
    .digest("hex");
}

function fixedWindowStart(now: Date) {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

async function consumeBucket(options: {
  sql: Sql | postgres.TransactionSql;
  scope: RateLimitScope;
  subject: string;
  limit: number;
  now: Date;
}): Promise<BucketDecision> {
  const windowStartedAt = fixedWindowStart(options.now);
  const hash = subjectHash(options.scope, options.subject);
  const [row] = await options.sql<
    { request_count: number; window_started_at: Date }[]
  >`
    insert into maintainflow_rate_limit_buckets (
      scope,
      subject_hash,
      window_started_at,
      request_count,
      updated_at
    ) values (
      ${options.scope},
      ${hash},
      ${windowStartedAt},
      1,
      ${options.now}
    )
    on conflict (scope, subject_hash) do update set
      window_started_at = case
        when maintainflow_rate_limit_buckets.window_started_at < excluded.window_started_at
          then excluded.window_started_at
        else maintainflow_rate_limit_buckets.window_started_at
      end,
      request_count = case
        when maintainflow_rate_limit_buckets.window_started_at < excluded.window_started_at
          then 1
        else least(
          maintainflow_rate_limit_buckets.request_count + 1,
          ${options.limit + 1}
        )
      end,
      updated_at = excluded.updated_at
    returning request_count, window_started_at
  `;
  if (!row) throw new ReadinessRateLimitUnavailableError();
  return {
    allowed: row.request_count <= options.limit,
    remaining: Math.max(0, options.limit - row.request_count),
    resetAt: new Date(row.window_started_at.getTime() + WINDOW_MS),
  };
}

export function getTrustedReadinessClientIp(
  request: Request,
  options: {
    vercel?: boolean;
    trustForwardedFor?: boolean;
    production?: boolean;
  } = {},
) {
  const vercel = options.vercel ?? process.env.VERCEL === "1";
  const trustForwardedFor =
    options.trustForwardedFor ??
    process.env.READINESS_TRUST_X_FORWARDED_FOR === "true";
  const production = options.production ?? process.env.NODE_ENV === "production";
  const raw = vercel
    ? request.headers.get("x-vercel-forwarded-for")
    : trustForwardedFor
      ? request.headers.get("x-forwarded-for")
      : production
        ? null
        : request.headers.get("x-forwarded-for") ?? "127.0.0.1";
  const candidate = raw?.split(",")[0]?.trim() ?? "";
  return isIP(candidate) ? candidate : null;
}

export async function verifyReadinessRateLimitStore() {
  if (!isReadinessRateLimitConfigured()) return false;
  const sql = getDatabase();
  const [row] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_rate_limit_buckets') is not null
      and to_regclass(
        'public.maintainflow_rate_limit_buckets_window_idx'
      ) is not null
    ) as ready
  `;
  return row?.ready === true;
}

export async function consumeReadinessAuditQuota(options: {
  clientIp: string;
  hostname: string;
  now?: Date;
}): Promise<ReadinessRateLimitDecision> {
  if (!isIP(options.clientIp)) {
    throw new ReadinessRateLimitUnavailableError(
      "A trusted public client address is required.",
    );
  }
  const hostname = options.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new ReadinessRateLimitUnavailableError();
  const now = options.now ?? new Date();
  const sql = getDatabase();

  return sql.begin(async (transaction) => {
    const ip = await consumeBucket({
      sql: transaction,
      scope: "readiness_ip",
      subject: options.clientIp,
      limit: IP_LIMIT,
      now,
    });
    if (!ip.allowed) return { ...ip, limit: IP_LIMIT };

    const host = await consumeBucket({
      sql: transaction,
      scope: "readiness_host",
      subject: hostname,
      limit: HOST_LIMIT,
      now,
    });
    if (!host.allowed) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: host.resetAt,
        limit: IP_LIMIT,
      };
    }
    return { ...ip, limit: IP_LIMIT };
  });
}

export async function pruneExpiredReadinessRateLimitBuckets(
  now = new Date(),
  limit = 1_000,
) {
  const sql = getDatabase();
  const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
  const rows = await sql<{ scope: string }[]>`
    delete from maintainflow_rate_limit_buckets
    where (scope, subject_hash) in (
      select scope, subject_hash
      from maintainflow_rate_limit_buckets
      where window_started_at < ${now} - interval '48 hours'
      order by window_started_at
      limit ${safeLimit}
      for update skip locked
    )
    returning scope
  `;
  return rows.length;
}
