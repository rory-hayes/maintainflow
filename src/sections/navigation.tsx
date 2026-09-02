"use client";

import NavLink from "@/components/common/nav-link";
import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Button } from "@/components/ui/button";
import { buildAppHref } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useEffect, useState } from "react";

const Navigation = () => {
  const [scroll, setScroll] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScroll(window.scrollY > 80);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <section
      className={cn(
        "sticky top-0 z-[999999] w-full bg-gradient-to-b from-transparent to-[#FAFAFA] backdrop-blur-lg",
        scroll && "border-b shadow-sm",
      )}
    >
      <nav
        aria-label="Primary"
        className="flex w-full items-center justify-between px-4 py-2.5 md:px-20 md:py-2"
      >
        <div className=" w-full">
          <Link href="/">
            <MaintainFlowBrand />
          </Link>
        </div>

        <div className="hidden md:block">
          <div className="flex w-full flex-col items-center">
            <ul className="inline-flex items-center gap-8">
              <li>
                <NavLink link="/#workflow">How it works</NavLink>
              </li>
              <li>
                <NavLink link={buildAppHref({ tab: "review" })}>Product</NavLink>
              </li>
              <li>
                <NavLink link={buildAppHref({ tab: "readiness" })}>
                  API readiness
                </NavLink>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex w-full items-center justify-end gap-4">
          <Button asChild>
            <Link href={buildAppHref({ tab: "review" })}>Open demo</Link>
          </Button>
        </div>
      </nav>
    </section>
  );
};

export default Navigation;
