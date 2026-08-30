"use client";

import cursorYouImage from "@/assets/icons/cursor-you.svg";
import Image from "next/image";
import Link from "next/link";
import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import NavLink from "@/components/common/nav-link";
import { Separator } from "@/components/ui/separator";
import { buildAppHref } from "@/lib/app-navigation";
import { ArrowRight } from "lucide-react";

import one from "@/assets/images/1.png";
import two from "@/assets/images/2.png";
import three from "@/assets/images/3.png";
import four from "@/assets/images/4.png";
import five from "@/assets/images/5.png";

import six from "@/assets/images/6.png";
import seven from "@/assets/images/7.png";
import eight from "@/assets/images/8.png";
import nine from "@/assets/images/9.png";
import ten from "@/assets/images/10.png";

const Footer = () => {
  return (
    <section className=" w-full px-4 md:px-6 h-fit md:h-[92vh]">
      <footer
        className=" px-4 md:px-14 pt-12 overflow-clip flex flex-col justify-between bg-[#FAFAFA] bg-[radial-gradient(#CECECE_1px,transparent_1px)] [background-size:16px_16px] border border-input rounded-b-none rounded-3xl w-full h-full"
        style={{
          cursor: `url(${cursorYouImage.src}) auto`,
        }}
      >
        <div className=" w-full flex flex-col md:flex-row items-start justify-between">
          <div className="flex flex-col w-full items-start">
            <div className=" w-full">
              <Link href="/">
                <MaintainFlowBrand />
              </Link>
            </div>
            <h3 className=" text-5xl max-w-lg font-medium text-black mt-4">
              Turn ad-account data into controlled decisions
            </h3>
          </div>

          <div className="flex items-start gap-20">
            <div className=" w-full grid grid-cols-1 gap-y-4 gap-x-2 mt-16">
              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />

                <NavLink link={buildAppHref({ tab: "review" })}>
                  Interactive demo
                </NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "review" })}>
                  Recommendations
                </NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "campaigns" })}>
                  Campaigns
                </NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "experiments" })}>
                  Experiments
                </NavLink>
              </div>
            </div>

            <div className=" w-full grid grid-cols-1 gap-y-4 gap-x-2 mt-16">
              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link="/#workflow">How it works</NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "review" })}>Product</NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "readiness" })}>
                  API readiness
                </NavLink>
              </div>

              <div className=" inline-flex items-center gap-2 w-[200px] group">
                <ArrowRight className=" group-hover:text-primary" />
                <NavLink link={buildAppHref({ tab: "review" })}>Demo mode</NavLink>
              </div>
            </div>
          </div>
        </div>

        <div className=" hidden md:block -mb-20">
          <div className="h-[16rem] w-full relative">
            <Image
              src={four}
              className=" absolute md:scale-75 right-auto left-0 bottom-0"
              alt=""
            />
            <Image
              src={five}
              className=" absolute md:scale-75 left-auto right-0"
              alt=""
            />
            <Image
              src={two}
              className=" absolute md:scale-75 right-auto left-96 -top-16 bottom-auto"
              alt=""
            />
            <Image
              src={one}
              className=" absolute md:scale-75 left-auto right-96 bottom-auto -top-12"
              alt=""
            />
            <Image
              src={three}
              className=" absolute md:scale-75 left-auto right-1/2 translate-x-1/2"
              alt=""
            />
          </div>
          <div className=" w-full flex justify-end">
            <div className="h-[16rem] w-[85%] relative">
              <Image
                src={six}
                className=" absolute md:scale-75 right-auto left-0 bottom-20"
                alt=""
              />
              <Image
                src={seven}
                className=" absolute md:scale-75 left-auto right-28"
                alt=""
              />
              <Image
                src={eight}
                className=" absolute md:scale-75 right-auto left-80 -top-20 bottom-auto"
                alt=""
              />
              <Image
                src={nine}
                className=" absolute md:scale-75 left-auto right-96 bottom-auto -top-20"
                alt=""
              />
              <Image
                src={ten}
                className=" absolute md:scale-75 left-auto right-1/2 translate-x-1/2"
                alt=""
              />
            </div>
          </div>
        </div>

        <div className="pb-24">
          <Separator
            orientation="horizontal"
            className=" w-full mb-12 md:mb-6 mt-12 md:mt-0"
          />

          <div className=" flex flex-col md:flex-row items-center justify-between text-base">
            <p>© 2026 MaintainFlow. All rights reserved.</p>

            <div className="flex flex-col md:flex-row items-center mt-4 md:mt-0 gap-4">
              <Link className="hover:underline" href="/privacy">
                Privacy notice
              </Link>
              <Link className="hover:underline" href="/terms">
                Private beta terms
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
};

export default Footer;
