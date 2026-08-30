"use client";

import NavLink from "@/components/common/nav-link";
import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useEffect, useState } from "react";

const Navigation = () => {
  const [scroll, setScroll] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScroll(window.scrollY > 80);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <section
      className={`w-full bg-gradient-to-b from-transparent to-[#FAFAFA] backdrop-blur-lg sticky top-0 z-[999999] ${
        scroll ? "border-b shadow-sm" : ""
      }`}
    >
      <nav className="w-full flex items-center justify-between px-4 md:px-20 py-2.5 md:py-2">
        <div className=" w-full">
          <Link href="/">
            <MaintainFlowBrand />
          </Link>
        </div>

        <aside className=" hidden md:block">
          <div className=" w-full flex flex-col items-center">
            <ul className=" inline-flex items-center gap-8">
              <NavLink link="/#workflow">How it works</NavLink>
              <NavLink link="/app">Product</NavLink>
              <NavLink link="/app">API readiness</NavLink>
            </ul>
          </div>
        </aside>

        <div className=" w-full flex items-center justify-end gap-4">
          <Link href="/app">
            <Button>Open demo</Button>
          </Link>
        </div>
      </nav>
    </section>
  );
};

export default Navigation;
