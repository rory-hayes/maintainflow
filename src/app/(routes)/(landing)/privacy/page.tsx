import type { Metadata } from "next";
import { connection } from "next/server";
import { getPublicLegalIdentity } from "@/lib/legal/config.server";

export const metadata: Metadata = {
  title: "Privacy notice | MaintainCode Ads",
  description:
    "How MaintainCode Ads handles account, website attribution and connected CRM data.",
  alternates: { canonical: "/privacy" },
};

export default async function PrivacyPage() {
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
            Privacy at MaintainCode Ads
          </h1>
          <p className="text-lg leading-8">
            MaintainCode Ads is operated by {identity.entityName}. This notice
            covers our service at maintainflow.io and the attribution service
            customers install on their own websites.
          </p>
        </header>
        <PolicySection title="Our role">
          <p>
            We use account and billing information to provide and support your
            subscription, secure the service, and meet applicable recordkeeping
            duties. For visitor and CRM data collected on a customer’s behalf,
            that customer decides the purpose and is responsible for its privacy
            notice and lawful instructions. Contact the website or business
            concerned first about its use of your data.
          </p>
        </PolicySection>
        <PolicySection title="What the service handles">
          <p>
            Account data includes your email address, authentication and
            workspace identifiers, membership, subscription status and support
            correspondence. Stripe handles checkout and payment details; our
            application stores payment customer and subscription identifiers.
          </p>
          <p>
            The attribution tracker records a random visitor and submission
            reference, first and latest marketing touch, landing page, referrer,
            campaign parameters, supported advertising click references,
            timestamps and submission confirmation. Query strings can contain
            personal information, so customers must avoid placing sensitive data
            in URLs or campaign parameters. We do not intentionally collect the
            contents of ordinary form fields, names or email addresses through
            the tracker.
          </p>
          <p>
            A connected HubSpot account provides configured attribution fields
            and their history, CRM contact identifiers and stages, deal
            identifiers, values, currencies, stages and contact associations. An
            optional OpenAI Ads connection provides account, campaign and
            delivery or spend data. You may also upload campaign cost data.
            Provider credentials are encrypted in server storage.
          </p>
          <p>
            Hosting and authentication providers also process technical request
            and security information, which may include IP addresses and browser
            details.
          </p>
        </PolicySection>
        <PolicySection title="Cookies and browser storage">
          <p>
            Sign-in uses cookies needed to maintain your authenticated session.
            The customer website tracker uses browser storage for attribution
            and pending event delivery. Its default installation waits for the
            website’s consent signal before collecting or storing attribution,
            and clears its attribution storage when that consent is withdrawn.
            Customers must connect this signal to their consent controls and
            provide visitors with the required notice and choices. A customer
            can configure consent behaviour and is responsible for that choice.
          </p>
          <p>
            Attribution storage lasts up to the website’s selected window, at
            most 90 days. Pending delivery records expire within 24 hours.
            Browser settings, consent withdrawal, device changes and blockers
            can prevent attribution.
          </p>
        </PolicySection>
        <PolicySection title="Providers and data location">
          <p>
            We use Vercel for application hosting, Supabase for the database and
            authentication, Stripe for billing, and Resend for service email
            delivery. The application database is provisioned in Ireland.
            Provider operations and support may involve other countries.
            Connected HubSpot and OpenAI accounts remain subject to the
            customer’s agreement with those providers. We do not sell customer
            attribution data.
          </p>
          <p>
            We use provider contractual safeguards where required for processing
            and international transfers. Contact us for applicable processing
            terms and provider details before connecting data that requires
            additional contractual arrangements.
          </p>
        </PolicySection>
        <PolicySection title="Retention and deletion">
          <p>
            Website attribution evidence uses a configurable retention period of
            1 to 90 days. Expired evidence is excluded when a workspace is read
            and is removed when the workspace is updated or maintenance runs.
            Associated CRM records are pruned according to their remaining
            attribution links and update age. Account configuration, cost
            records and billing references have separate service and
            recordkeeping purposes and are not deleted by the attribution expiry
            control.
          </p>
          <p>
            Workspace owners can export their data, shorten retention, delete a
            website’s attribution evidence and disconnect providers in settings.
            Disconnecting removes the stored provider credential; revoke the
            credential at the provider too if it should no longer work
            elsewhere. Contact us to request complete account deletion. Provider
            backups, billing records and security logs may follow separate
            retention periods and legal obligations.
          </p>
        </PolicySection>
        <PolicySection title="Your choices and contact">
          <p>
            You may request access, correction, deletion, restriction or
            portability where applicable, and object to processing based on
            legitimate interests. Where consent is used, you can withdraw it.
            You can raise a concern with Ireland’s{" "}
            <a
              className="underline"
              href="https://www.dataprotection.ie/en/individuals/raising-concern-commission"
            >
              Data Protection Commission
            </a>{" "}
            or your local supervisory authority.
          </p>
          <p>
            Contact {identity.entityName} at{" "}
            {identity.privacyEmail ? (
              <a className="underline" href={`mailto:${identity.privacyEmail}`}>
                {identity.privacyEmail}
              </a>
            ) : (
              "the service support contact"
            )}{" "}
            for privacy questions or requests.
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
