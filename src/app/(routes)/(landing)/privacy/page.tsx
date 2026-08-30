import type { Metadata } from "next";
import { connection } from "next/server";

import { getPublicLegalIdentity } from "@/lib/legal/config.server";

export const metadata: Metadata = {
  title: "Privacy notice | MaintainFlow",
  description: "How MaintainFlow handles data in its demo and private beta.",
};

export default async function PrivacyPage() {
  await connection();
  const identity = getPublicLegalIdentity();

  return (
    <main className="px-4 pb-24 pt-36 md:px-6">
      <article className="mx-auto grid max-w-3xl gap-10 rounded-3xl border bg-white p-6 shadow-sm md:p-10">
        <header className="grid gap-3">
          <p className="text-sm font-medium text-muted-foreground">
            Private beta notice · Last updated 30 August 2026
          </p>
          <h1 className="text-4xl font-medium tracking-[-0.04em] md:text-5xl">
            Privacy at MaintainFlow
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            This notice explains the data handled by {identity.entityName} when
            you use the public demo or an admitted private-beta workspace.
          </p>
        </header>

        <PolicySection title="What we handle">
          <p>
            Depending on the features you use, MaintainFlow handles sign-in and
            organization identifiers, advertiser-account roles, encrypted Ads
            and Conversions credentials, campaign and performance data,
            approval and rollback evidence, monitoring outcomes, readiness
            scan history, and the public URLs you ask the readiness scanner to
            inspect.
          </p>
          <p>
            Product-feed files and the static Conversions preflight remain in
            your browser. A payload is sent to OpenAI only when an authorized
            operator deliberately uses the protected validate-only connection.
          </p>
          <p>
            Before a public readiness scan, MaintainFlow derives separate
            HMAC-SHA-256 quota identifiers from the source IP address and target
            hostname. Quota rows contain only those derived identifiers, counts,
            and hourly window timestamps—not the raw IP address or hostname.
          </p>
        </PolicySection>

        <PolicySection title="Why we use it">
          <p>
            We use this data to provide the workspace, verify account access,
            prepare evidence-backed recommendations, record approvals, monitor
            confirmed changes, prevent abuse, support customers, and protect
            the service. MaintainFlow does not sell customer advertising data.
          </p>
        </PolicySection>

        <PolicySection title="Who receives it">
          <p>
            Data is shared only with providers needed to operate the selected
            feature, including identity, hosting, database, and OpenAI Ads or
            Conversions services, plus professional advisers or authorities
            where legally required. Each admitted live pilot must receive the
            applicable processor and international-transfer details before
            connecting an account.
          </p>
        </PolicySection>

        <PolicySection title="Security, retention, and your choices">
          <p>
            Provider credentials are encrypted server-side and are never sent
            to the browser. Access is account-scoped, and external Ads changes
            require a separate human approval and durable audit record.
          </p>
          <p>
            Beta data is retained only for the documented pilot and operational
            recordkeeping needs. Retention, export, access revocation, and
            deletion are confirmed with each live pilot; automated deletion is
            not yet offered. You may request access, correction, export, or
            deletion through the privacy contact below.
          </p>
          <p>
            Live dashboard snapshots expire from active use after 15 minutes.
            Confirmed snapshots become eligible for removal 24 hours after their
            last provider sync. Readiness quota buckets older than 48 hours are
            targeted by the bounded daily cleanup; a cleanup backlog or failure
            is surfaced for operator retry. Approval and monitoring evidence
            follows the separate retention schedule agreed for the pilot.
          </p>
        </PolicySection>

        <PolicySection title="Contact">
          {identity.privacyEmail ? (
            <p>
              Privacy requests: {" "}
              <a
                className="font-medium underline underline-offset-4"
                href={`mailto:${identity.privacyEmail}`}
              >
                {identity.privacyEmail}
              </a>
            </p>
          ) : (
            <p>
              Live account connections remain blocked until a monitored privacy
              contact is configured for this deployment.
            </p>
          )}
        </PolicySection>
      </article>
    </main>
  );
}

function PolicySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t pt-8">
      <h2 className="text-2xl font-medium tracking-[-0.02em]">{title}</h2>
      <div className="grid gap-3 leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}
