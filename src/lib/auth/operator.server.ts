import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import { isClerkConfigured, isWorkspaceAdmissionAllowed } from "./config";
import { isSupabaseConfigured } from "./supabase-config";
import { verifiedSupabaseUser } from "./supabase.server";

export type Operator = {
  id: string;
  name: string;
  initials: string;
};

export class OperatorAuthUnavailableError extends Error {
  constructor() {
    super("Operator authentication is not configured.");
    this.name = "OperatorAuthUnavailableError";
  }
}

export class OperatorUnauthorizedError extends Error {
  readonly status: 401 | 403 = 401;

  constructor(
    message = "Sign in as an authorized operator before applying a live change.",
  ) {
    super(message);
    this.name = "OperatorUnauthorizedError";
  }
}

export class OperatorAdmissionForbiddenError extends OperatorUnauthorizedError {
  override readonly status = 403 as const;

  constructor() {
    super("This signed-in account is not admitted to MaintainFlow.");
    this.name = "OperatorAdmissionForbiddenError";
  }
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "OP"
  );
}

async function getOptionalAuthenticatedOperatorId(): Promise<string | null> {
  if (isSupabaseConfigured()) return (await verifiedSupabaseUser())?.id ?? null;
  if (!isClerkConfigured()) return null;

  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return null;
  return session.userId;
}

async function getOperator(operatorId: string): Promise<Operator> {
  if (isSupabaseConfigured()) {
    const user = await verifiedSupabaseUser();
    if (!user || user.id !== operatorId) throw new OperatorUnauthorizedError();
    const name = user.email ?? "Workspace member";
    return { id: operatorId, name, initials: initialsFor(name) };
  }
  const user = await currentUser();
  const fallbackName = user?.primaryEmailAddress?.emailAddress ?? "Operator";
  const name = user?.fullName || user?.firstName || fallbackName;
  return { id: operatorId, name, initials: initialsFor(name) };
}

export async function getOptionalOperator(): Promise<Operator | null> {
  const operatorId = await getOptionalAuthenticatedOperatorId();
  if (!operatorId) return null;
  return getOperator(operatorId);
}

export async function getOptionalAdmittedOperator(): Promise<Operator | null> {
  const operatorId = await getOptionalAuthenticatedOperatorId();
  if (!operatorId || !isWorkspaceAdmissionAllowed(operatorId)) return null;
  return getOperator(operatorId);
}

export async function requireOperatorId(): Promise<string> {
  if (isSupabaseConfigured()) {
    const user = await verifiedSupabaseUser();
    if (!user)
      throw new OperatorUnauthorizedError("Sign in to open your workspace.");
    if (!isWorkspaceAdmissionAllowed(user.id))
      throw new OperatorAdmissionForbiddenError();
    return user.id;
  }
  if (!isClerkConfigured()) throw new OperatorAuthUnavailableError();

  const session = await auth();
  if (!session.isAuthenticated || !session.userId) {
    throw new OperatorUnauthorizedError();
  }
  if (!isWorkspaceAdmissionAllowed(session.userId)) {
    throw new OperatorAdmissionForbiddenError();
  }
  return session.userId;
}

export async function requireOperator(): Promise<Operator> {
  const operatorId = await requireOperatorId();
  return getOperator(operatorId);
}
