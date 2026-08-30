import type { Metadata } from "next";
import { connection } from "next/server";

import { getPublicLegalIdentity } from "@/lib/legal/config.server";

export const metadata: Metadata = {
  title: "Private beta terms | MaintainFlow",
  description: "Terms for the MaintainFlow demo and admitted private beta.",
};

export default async function TermsPage() {
  await connection();
  const identity = getPublicLegalIdentity();

  return (
    <main className="px-4 pb-24 pt-36 md:px-6">
      <article className="mx-auto grid max-w-3xl gap-10 rounded-3xl border bg-white p-6 shadow-sm md:p-10">
        <header className="grid gap-3">
          <p className="text-sm font-medium text-muted-foreground">
            Private beta terms · Last updated 30 August 2026
          </p>
          <h1 className="text-4xl font-medium tracking-[-0.04em] md:text-5xl">
            MaintainFlow service terms
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            These terms govern the public demo and admitted private beta
            provided by {identity.entityName}, unless a signed pilot agreement
            says otherwise.
          </p>
        </header>

        <TermsSection title="Private beta scope">
          <p>
            MaintainFlow is a controlled decision-support product. Demo data is
            illustrative. Live account access is invitation-only and remains
            read-only unless every release gate and an explicit human approval
            authorize a supported change.
          </p>
        </TermsSection>

        <TermsSection title="Your responsibilities">
          <p>
            You must be authorized to connect each advertiser account, protect
            your credentials, keep account and event data lawful and accurate,
            and comply with OpenAI policies and applicable advertising,
            privacy, and consumer-protection law. Do not submit special-category
            or unnecessary personal data.
          </p>
        </TermsSection>

        <TermsSection title="Approvals and provider behavior">
          <p>
            Recommendations are not guarantees. You remain responsible for each
            advertising decision and approval. Provider availability, review,
            attribution, billing, and API behavior are controlled by OpenAI;
            ambiguous write outcomes require manual reconciliation and are not
            automatically retried.
          </p>
        </TermsSection>

        <TermsSection title="Availability and changes">
          <p>
            Beta features may change, pause, or be withdrawn. We may suspend
            access to protect customers or the service. Before any paid or
            broader production use, the commercial terms, support level,
            retention schedule, processor details, liability allocation, and
            governing law must be set out in a signed customer agreement.
          </p>
        </TermsSection>

        <TermsSection title="Ending a pilot">
          <p>
            Either side may end an unsigned beta pilot. We will revoke workspace
            access and follow the agreed export, retention, credential-revocation,
            and deletion process. The customer should also revoke provider keys
            in Ads Manager.
          </p>
        </TermsSection>

        <TermsSection title="Support and notices">
          {identity.supportEmail ? (
            <p>
              Contact {" "}
              <a
                className="font-medium underline underline-offset-4"
                href={`mailto:${identity.supportEmail}`}
              >
                {identity.supportEmail}
              </a>
              {" "}for support or service notices.
            </p>
          ) : (
            <p>
              Live account connections remain blocked until a monitored support
              contact is configured for this deployment.
            </p>
          )}
        </TermsSection>
      </article>
    </main>
  );
}

function TermsSection({
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
