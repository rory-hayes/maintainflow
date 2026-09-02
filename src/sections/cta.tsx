import Image from "next/image";
import { connection } from "next/server";

import ctaImage from "@/assets/images/maintainflow-budget-guard.png";
import { Button } from "@/components/ui/button";
import { buildAppHref } from "@/lib/app-navigation";
import { agencySimulatorEntryAccountId } from "@/lib/openai-ads/simulator-links";
import { getPublicLegalIdentity } from "@/lib/legal/config.server";
import Link from "next/link";

const Cta = async () => {
  await connection();
  const { supportEmail } = getPublicLegalIdentity();
  const pilotHref = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent("MaintainFlow agency pilot")}&body=${encodeURIComponent("Agency / brand:\nAdvertiser accounts:\nExpected monthly ChatGPT Ads spend:\nApproval workflow today:\n")}`
    : null;

  return (
    <section className=" pb-40 max-w-7xl w-full mx-auto px-4 md:px-0">
      <div className="mx-auto flex w-full flex-col justify-between gap-12 overflow-clip rounded-[2rem] bg-[#00ADE7] px-4 shadow-sm md:h-[36rem] md:flex-row md:items-center md:gap-10 md:px-12 md:py-12">
        <div className="mt-14 flex w-full flex-col items-start md:mt-0 md:w-[42%]">
          <h2 className="text-start text-4xl font-medium text-[#052B3A] md:text-5xl">
            See the recommendation before it touches your spend
          </h2>
          <p className="mt-6 text-start text-lg text-[#052B3A]/80">
            Explore the full approval workflow with realistic demo data. No Ads
            API key is required and no external change is made.
          </p>

          <div className=" w-full flex flex-col gap-4 mt-12">
            <Button asChild className=" w-full" variant="secondary">
              <Link href={buildAppHref({ tab: "review" })}>
                Open the interactive demo
              </Link>
            </Button>
            <Button
              asChild
              className="w-full text-[#052B3A] hover:bg-black/5 hover:text-[#052B3A]"
              variant="transparent"
            >
              <Link
                href={buildAppHref({
                  tab: "campaigns",
                  accountId: agencySimulatorEntryAccountId,
                })}
              >
                Explore the five-client agency portfolio
              </Link>
            </Button>
            {pilotHref ? (
              <Button
                asChild
                className="w-full border-[#052B3A]/25 bg-transparent text-[#052B3A] hover:bg-black/5 hover:text-[#052B3A]"
                variant="outline"
              >
                <a href={pilotHref}>Apply for an agency pilot</a>
              </Button>
            ) : (
              <p className="text-sm leading-5 text-[#052B3A]/75">
                Private-beta applications open when the monitored support
                contact is configured for this deployment.
              </p>
            )}
          </div>
        </div>
        <div className="w-full pb-10 md:w-[58%] md:pb-0">
          <div className="relative aspect-video w-full overflow-hidden rounded-2xl border-4 border-white/20 bg-white shadow-2xl md:translate-x-10 md:scale-110">
            <Image
              fill
              sizes="(max-width: 768px) 100vw, 60vw"
              className="object-cover object-top"
              src={ctaImage}
              alt="MaintainFlow Budget Guard showing projected ad spend and campaign actions"
              quality={100}
            />
          </div>
        </div>
      </div>
    </section>
  );
};

export default Cta;
