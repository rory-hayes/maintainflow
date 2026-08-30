import { ClerkProvider } from "@clerk/nextjs";

import { isClerkConfigured } from "@/lib/auth/config";

export function ConditionalClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return isClerkConfigured() ? (
    <ClerkProvider>{children}</ClerkProvider>
  ) : (
    children
  );
}
