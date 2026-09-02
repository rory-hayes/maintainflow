"use client";

import bottomLeftImage from "@/assets/images/bottom-left.png";
import bottomRightImage from "@/assets/images/bottom-right.png";
import topleftImage from "@/assets/images/sticky-note.png";
import topRightImage from "@/assets/images/top-right.png";
import Image from "next/image";

import { motion, useAnimate, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

import cursorYouImage from "@/assets/icons/cursor-you.svg";
import Pointer from "@/components/common/pointer";

interface HeroProps {
  children: React.ReactNode;
}

export default function Hero({ children }: HeroProps) {
  const shouldReduceMotion = useReducedMotion();
  const [topLeftDesignScope, topLeftDesignAnimate] = useAnimate();
  const [topLeftPointerScope, topLeftPointerAnimate] = useAnimate();

  const [bottomLeftDesignScope, bottomLeftDesignAnimate] = useAnimate();
  const [bottomLeftPointerScope, bottomLeftPointerAnimate] = useAnimate();

  const [toprightDesignScope, topRightDesignAnimate] = useAnimate();
  const [toprightPointerScope, topRightPointerAnimate] = useAnimate();

  const [bottomrightDesignScope, bottomRightDesignAnimate] = useAnimate();
  const [bottomrightPointerScope, bottomRightPointerAnimate] = useAnimate();

  useEffect(() => {
    if (shouldReduceMotion) {
      topLeftDesignAnimate([
        [topLeftDesignScope.current, { opacity: 1, y: 0, x: 0 }, { duration: 0 }],
      ]);
      topLeftPointerAnimate([
        [topLeftPointerScope.current, { opacity: 1, y: 0, x: 120 }, { duration: 0 }],
      ]);
      bottomLeftDesignAnimate([
        [bottomLeftDesignScope.current, { opacity: 1, y: 0, x: 0 }, { duration: 0 }],
      ]);
      bottomLeftPointerAnimate([
        [bottomLeftPointerScope.current, { opacity: 1, y: 0, x: 240 }, { duration: 0 }],
      ]);
      topRightDesignAnimate([
        [toprightDesignScope.current, { opacity: 1, y: 100, x: 100 }, { duration: 0 }],
      ]);
      topRightPointerAnimate([
        [toprightPointerScope.current, { opacity: 1, y: 0, x: 0 }, { duration: 0 }],
      ]);
      bottomRightDesignAnimate([
        [bottomrightDesignScope.current, { opacity: 1, y: -80, x: 10 }, { duration: 0 }],
      ]);
      bottomRightPointerAnimate([
        [bottomrightPointerScope.current, { opacity: 1, y: 100, x: 40 }, { duration: 0 }],
      ]);
      return;
    }

    topLeftDesignAnimate([
      [topLeftDesignScope.current, { opacity: 1 }, { duration: 0.5 }],
      [
        topLeftDesignScope.current,
        { y: 0, x: 0 },
        { duration: 0.5, delay: 0.05 },
      ],
    ]);
    topLeftPointerAnimate([
      [topLeftPointerScope.current, { opacity: 1 }, { duration: 0.5 }],
      [topLeftPointerScope.current, { y: 0, x: 0 }, { duration: 0.5 }],
      [
        topLeftPointerScope.current,
        { x: 120, y: [0, 40, 0] },
        { duration: 1, ease: "easeInOut" },
      ],
    ]);

    bottomLeftDesignAnimate([
      [
        bottomLeftDesignScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 2.5 },
      ],
      [bottomLeftDesignScope.current, { y: 0, x: 0 }, { duration: 0.5 }],
    ]);
    bottomLeftPointerAnimate([
      [
        bottomLeftPointerScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 2.5 },
      ],
      [bottomLeftPointerScope.current, { y: 0, x: -100 }, { duration: 0.5 }],
      [
        bottomLeftPointerScope.current,
        { x: 240, y: [0, 20, 0] },
        { duration: 1, ease: "easeInOut" },
      ],
    ]);

    topRightDesignAnimate([
      [
        toprightDesignScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 1.5 },
      ],
      [toprightDesignScope.current, { y: 100, x: 100 }, { duration: 0.5 }],
    ]);
    topRightPointerAnimate([
      [
        toprightPointerScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 1.5 },
      ],
      [toprightPointerScope.current, { y: 0, x: 0 }, { duration: 0.5 }],
      [
        toprightPointerScope.current,
        { x: 0, y: 0 },
        { duration: 1, ease: "easeInOut" },
      ],
    ]);

    bottomRightDesignAnimate([
      [
        bottomrightDesignScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 3.5 },
      ],
      [bottomrightDesignScope.current, { y: -80, x: 10 }, { duration: 0.5 }],
    ]);
    bottomRightPointerAnimate([
      [
        bottomrightPointerScope.current,
        { opacity: 1 },
        { duration: 0.5, delay: 3.5 },
      ],
      [bottomrightPointerScope.current, { y: 100, x: 40 }, { duration: 0.5 }],
      [
        bottomrightPointerScope.current,
        { x: 40, y: 100 },
        { duration: 1, ease: "easeInOut" },
      ],
    ]);
  }, [
    shouldReduceMotion,
    topLeftDesignAnimate,
    topLeftDesignScope,
    topLeftPointerAnimate,
    topLeftPointerScope,
    bottomLeftDesignAnimate,
    bottomLeftDesignScope,
    bottomLeftPointerAnimate,
    bottomLeftPointerScope,
    topRightDesignAnimate,
    toprightDesignScope,
    topRightPointerAnimate,
    toprightPointerScope,
    bottomRightDesignAnimate,
    bottomrightDesignScope,
    bottomRightPointerAnimate,
    bottomrightPointerScope,
  ]);

  return (
    <section className="flex min-h-[92svh] w-full flex-col items-center justify-center px-4 py-4 md:h-[92vh] md:min-h-0 md:px-6 md:py-0">
      <div
        className="flex min-h-[calc(92svh-2rem)] w-full flex-col justify-center overflow-clip rounded-3xl border border-input bg-[#FAFAFA] bg-[radial-gradient(#CECECE_1px,transparent_1px)] py-12 [background-size:16px_16px] md:h-full md:min-h-0 md:py-24"
        style={{
          cursor: `url(${cursorYouImage.src}) auto`,
        }}
      >
        <div className="container relative flex min-h-0 flex-1 flex-col">
          <motion.div
            aria-hidden="true"
            ref={topLeftDesignScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 100, x: 100 }}
            drag={!shouldReduceMotion}
            className=" absolute hidden lg:block -left-[22rem] -top-28"
          >
            <Image
              src={topleftImage}
              className=" object-contain"
              alt=""
              draggable="false"
            />
          </motion.div>
          <motion.div
            aria-hidden="true"
            ref={topLeftPointerScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 100, x: 200 }}
            className="absolute hidden lg:block -left-24 top-48"
          >
            <Pointer color="blue" name="Agency reviewer" />
          </motion.div>

          <motion.div
            aria-hidden="true"
            ref={bottomrightDesignScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 100, x: 100 }}
            drag={!shouldReduceMotion}
            className=" absolute hidden lg:block -right-96 -bottom-60"
          >
            <Image
              src={bottomRightImage}
              className=" object-contain scale-90"
              quality={100}
              alt=""
              draggable="false"
            />
          </motion.div>
          <motion.div
            aria-hidden="true"
            ref={bottomrightPointerScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 320, x: 240 }}
            className="absolute hidden lg:block right-24 bottom-[18rem]"
          >
            <Pointer color="orange" name="Client approver" />
          </motion.div>

          <motion.div
            aria-hidden="true"
            ref={toprightDesignScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 0, x: 200 }}
            drag={!shouldReduceMotion}
            className=" absolute hidden lg:block -right-80 -top-52"
          >
            <Image
              src={topRightImage}
              className=" object-contain scale-90 rotate-6"
              quality={100}
              alt=""
              draggable="false"
            />
          </motion.div>
          <motion.div
            aria-hidden="true"
            ref={toprightPointerScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: -120, x: 250 }}
            className="absolute hidden lg:block right-10 top-52"
          >
            <Pointer color="green" name="Analyst" />
          </motion.div>

          <motion.div
            aria-hidden="true"
            ref={bottomLeftDesignScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: -100, x: 100 }}
            drag={!shouldReduceMotion}
            className=" absolute hidden lg:block -left-[23rem] -bottom-40"
          >
            <Image
              src={bottomLeftImage}
              className=" object-contain scale-90"
              quality={100}
              alt=""
              draggable="false"
            />
          </motion.div>
          <motion.div
            aria-hidden="true"
            ref={bottomLeftPointerScope}
            initial={shouldReduceMotion ? false : { opacity: 0, y: -260, x: 100 }}
            className="absolute hidden lg:block -left-24 bottom-10"
          >
            <Pointer color="violet" name="Account owner" />
          </motion.div>

          {children}
        </div>
      </div>
    </section>
  );
}
