import type { Metadata } from "next";
import { connection } from "next/server";
import { getPublicLegalIdentity } from "@/lib/legal/config.server";

export const metadata: Metadata = {
  title: "Service terms | MaintainCode Ads",
  description: "Terms for the MaintainCode Ads attribution service.",
  alternates: { canonical: "/terms" },
};
export default async function TermsPage() {
  await connection();
  const identity = getPublicLegalIdentity();
  return (
    <main className="px-4 py-16 md:px-6">
      <article className="mx-auto grid max-w-3xl gap-10 rounded-3xl border bg-white p-6 md:p-10">
        <header className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Last updated 6 September 2026
          </p>
          <h1 className="text-4xl font-medium tracking-tight">
            MaintainCode Ads service terms
          </h1>
          <p className="text-lg leading-8">
            These terms govern the attribution service provided by{" "}
            {identity.entityName} at maintainflow.io. By creating a workspace,
            you agree to these terms on behalf of yourself or the business you
            are authorised to represent.
          </p>
        </header>
        <PolicySection title="The service">
          <p>
            MaintainCode Ads connects website marketing evidence with confirmed
            form submissions and supported CRM records. Reports distinguish
            observed evidence, identity matching, field verification and missing
            data. Sample workspaces contain illustrative data. Results depend on
            your installation, consent controls, field mapping, provider access
            and available records.
          </p>
          <p>
            Attribution reports are estimates based on the displayed model and
            reporting period. They do not prove that a marketing interaction
            caused a sale, and we do not guarantee complete attribution,
            revenue, savings or advertising performance. You remain responsible
            for business and advertising decisions.
          </p>
        </PolicySection>
        <PolicySection title="Your account and data">
          <p>
            You must protect account access and only connect websites, CRM
            accounts and advertising accounts you are authorised to use. You are
            responsible for your collection notices, consent choices, data
            accuracy and lawful processing instructions. Do not intentionally
            submit sensitive personal information or unnecessary form contents.
            Do not misuse the service, evade usage limits or interfere with
            another customer’s account.
          </p>
          <p>
            You retain rights in your data. You permit us and our service
            providers to process it as necessary to deliver, secure and support
            the service. Our{" "}
            <a className="underline" href="/privacy">
              privacy notice
            </a>{" "}
            explains the data and providers involved. Ask us for applicable
            processing terms if required for your use.
          </p>
        </PolicySection>
        <PolicySection title="Trial, plans and payment">
          <p>
            New workspaces receive a 14-day trial. A trial does not itself
            charge your card. Continued attribution capture after the trial
            requires an eligible subscription. Plan prices, billing intervals,
            website and submission limits are shown in the workspace and
            confirmed at Stripe checkout. Any applicable tax is shown at
            checkout.
          </p>
          <p>
            A paid subscription renews for the selected interval until cancelled
            through the billing portal. Cancellation normally takes effect at
            the end of the paid period. Download the data you need before ending
            service. Contact support about billing errors or refund requests;
            applicable statutory rights are unaffected.
          </p>
        </PolicySection>
        <PolicySection title="Connections and availability">
          <p>
            External providers control their own APIs, data, outages and account
            eligibility. Connections may need to be renewed. Manual sync and
            scheduled maintenance can fail or be delayed; review the timestamps
            and errors shown in your workspace. We may change features or
            suspend access when reasonably necessary to protect the service,
            comply with law or address a material breach. We will provide
            reasonable notice of material commercial changes where practicable.
          </p>
        </PolicySection>
        <PolicySection title="Ending service">
          <p>
            You can disconnect providers and request account closure through
            support. Disconnecting an integration removes its stored credential
            but does not cancel its provider account. Cancelling a subscription
            does not itself erase all records. Export and deletion are handled
            as described in the privacy notice, subject to required billing and
            security records.
          </p>
        </PolicySection>
        <PolicySection title="Support and legal rights">
          <p>
            For support, billing questions or notices, contact{" "}
            {identity.entityName} at{" "}
            {identity.supportEmail ? (
              <a className="underline" href={`mailto:${identity.supportEmail}`}>
                {identity.supportEmail}
              </a>
            ) : (
              "the service support contact"
            )}
            . We provide support by email; no particular response time or uptime
            commitment applies unless agreed in writing.
          </p>
          <p>
            Nothing in these terms excludes liability or rights that cannot
            lawfully be excluded. A separate written agreement takes precedence
            where it expressly changes these terms.
          </p>
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
      <div className="grid gap-3 leading-7 text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
