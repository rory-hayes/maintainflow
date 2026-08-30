import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import { isClerkConfigured } from "./config";

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
  constructor() {
    super("Sign in as an authorized operator before applying a live change.");
    this.name = "OperatorUnauthorizedError";
  }
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "OP";
}

export async function getOptionalOperator(): Promise<Operator | null> {
  if (!isClerkConfigured()) return null;

  const session = await auth();
  if (!session.isAuthenticated || !session.userId) return null;
  const user = await currentUser();
  const fallbackName = user?.primaryEmailAddress?.emailAddress ?? "Operator";
  const name = user?.fullName || user?.firstName || fallbackName;
  return { id: session.userId, name, initials: initialsFor(name) };
}

export async function requireOperatorId(): Promise<string> {
  if (!isClerkConfigured()) throw new OperatorAuthUnavailableError();

  const session = await auth();
  if (!session.isAuthenticated || !session.userId) {
    throw new OperatorUnauthorizedError();
  }
  return session.userId;
}
