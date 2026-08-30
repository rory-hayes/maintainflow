"use client";

import { Button } from "@/components/ui/button";
import Hero from "@/sections/hero";
import Lenis from "@studio-freight/lenis";
import { useEffect } from "react";
import Link from "next/link";
import { BarChart3, Check, ShieldCheck, Sparkles } from "lucide-react";
import { MaintainFlowBrand } from "@/components/maintainflow/brand";

const HomePage = () => {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const lenis = new Lenis();
    let animationFrame = 0;

    function raf(time: number) {
      lenis.raf(time);
      animationFrame = requestAnimationFrame(raf);
    }

    animationFrame = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(animationFrame);
      lenis.destroy();
    };
  }, []);
  return (
    <div>
      <Hero>
        <div className="flex h-full flex-col items-center justify-center">
          <div className="inline-flex rounded-xl border bg-white p-3 shadow-md">
            <MaintainFlowBrand compact />
          </div>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-sm shadow-sm">
            <span className="size-1.5 rounded-full bg-warning" />
            Built against the OpenAI Ads API schema
          </div>
          <h1 className="mt-6 text-center text-5xl font-medium tracking-[-0.04em] md:text-6xl">
            Make every ad change <br className="hidden md:block" />
            <span className="text-[#848484]">with evidence, not instinct</span>
          </h1>
          <p className="mt-8 max-w-2xl text-center text-lg leading-8 text-black/50 md:text-xl">
            MaintainFlow finds waste and missed opportunities in OpenAI Ads,
            shows the proof, and waits for your approval before changing anything.
          </p>
          <div className="mt-8 flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild>
              <Link href="/app">
                <Sparkles data-icon="inline-start" />
                Open interactive demo
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="#workflow">See how it works</Link>
            </Button>
          </div>
        </div>
      </Hero>
      <section id="workflow" className="px-4 py-24 md:px-6">
        <div className="mx-auto grid max-w-7xl gap-10">
          <div className="mx-auto grid max-w-3xl gap-4 text-center">
            <div className="mx-auto rounded-full border bg-white px-5 py-2 text-sm shadow-sm">
              One controlled loop
            </div>
            <h2 className="text-4xl font-medium tracking-[-0.04em] md:text-6xl">
              Diagnose. Approve. Monitor.
            </h2>
            <p className="text-lg text-muted-foreground">
              The first version is intentionally human-controlled. MaintainFlow
              prepares the action; the advertiser decides.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: BarChart3,
                title: "Find the real problem",
                body: "Combine delivery insights and click-attributed conversions to identify costly drift.",
              },
              {
                icon: Check,
                title: "Review the exact change",
                body: "See the evidence, request payload, safeguard, and rollback before approving.",
              },
              {
                icon: ShieldCheck,
                title: "Measure and reverse",
                body: "Monitor a fixed window and restore the prior setting when the guardrail is crossed.",
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="grid gap-5 rounded-3xl border bg-white p-6 shadow-sm md:p-8">
                <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon />
                </div>
                <div className="grid gap-2">
                  <h3 className="text-xl font-medium">{title}</h3>
                  <p className="leading-7 text-muted-foreground">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default HomePage;
