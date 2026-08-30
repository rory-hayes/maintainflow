import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export default function Pricing() {
  const [selected, setSelected] = useState<"M" | "A">("M");

  return (
    <section
      id="pricing"
      className="w-full text-black px-4 lg:px-8 py-12 lg:py-24 relative overflow-hidden"
    >
      <Heading selected={selected} setSelected={setSelected} />
      <PriceCards selected={selected} />
    </section>
  );
}

const SELECTED_STYLES = "text-white font-medium rounded-lg py-3 w-28 relative";
const DESELECTED_STYLES =
  "font-medium rounded-lg py-3 w-28 hover:bg-secondary transition-colors relative";

interface HeadingProps {
  selected: "M" | "A";
  setSelected: React.Dispatch<React.SetStateAction<"M" | "A">>;
}

const Heading = ({ selected, setSelected }: HeadingProps) => {
  return (
    <div className="mb-12 lg:mb-24 relative w-full flex flex-col items-center z-10">
      <div className=" inline-flex bg-[#F5F5F5] border rounded-full shadow-md items-center justify-center py-2 px-6 w-fit">
        <p className=" text-lg">FAQ&apos;s</p>
      </div>
      <h2 className=" text-5xl md:text-7xl max-w-3xl font-medium text-center mt-6 mx-auto">
        Simple pricing plans
      </h2>

      <p className=" text-xl opacity-70 text-black md:max-w-lg text-center mt-4">
        Lorem ipsum dolor sit amet consectetur, adipisicing elit. Unde aperiam
        odit quas iste inventore fugit lorem ipsum.
      </p>

      <div className="flex items-center justify-center gap-3 mt-8">
        <button
          onClick={() => setSelected("M")}
          className={selected === "M" ? SELECTED_STYLES : DESELECTED_STYLES}
        >
          Monthly
          {selected === "M" && <BackgroundShift />}
        </button>
        <div className="relative">
          <button
            onClick={() => setSelected("A")}
            className={selected === "A" ? SELECTED_STYLES : DESELECTED_STYLES}
          >
            Yearly
            {selected === "A" && <BackgroundShift />}
          </button>
          <CTAArrow />
        </div>
      </div>
    </div>
  );
};

const BackgroundShift = () => (
  <motion.span
    layoutId="bg-shift"
    className="absolute inset-0 bg-primary rounded-lg -z-10"
  />
);

const CTAArrow = () => (
  <div className="absolute -right-[140px] top-2 hidden md:block">
    <svg
      className="scale-x-[-1] -rotate-12"
      width="80"
      height="80"
      viewBox="0 0 144 141"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M129.189 0.0490494C128.744 0.119441 126.422 0.377545 124.03 0.635648C114.719 1.6446 109.23 2.4893 108.058 3.09936C107.119 3.56864 106.674 4.34295 106.674 5.44576C106.674 6.71281 107.424 7.51058 109.043 7.97986C110.403 8.37875 110.825 8.42567 118.87 9.52847C121.778 9.92736 124.288 10.3028 124.475 10.3732C124.663 10.4436 122.951 11.1006 120.676 11.8749C110.028 15.4414 100.412 20.7677 91.7339 27.9242C88.38 30.7164 81.6957 37.4271 79.2096 40.5009C73.8387 47.2116 69.6874 54.8139 66.5681 63.7302C65.9348 65.4665 65.3484 66.8978 65.2546 66.8978C65.1374 66.8978 63.7771 66.7336 62.2291 66.5693C52.9649 65.5134 43.1847 68.1649 34.1316 74.2186C24.7735 80.46 18.5349 87.7338 10.5371 101.742C2.53943 115.726 -1.0959 127.482 0.287874 135.014C0.89767 138.463 2.0469 140.035 3.97011 140.082C5.28352 140.105 5.37733 139.659 4.20465 139.049C3.05541 138.463 2.6567 137.9 2.32835 136.281C0.616228 128.021 6.24512 113.028 17.4325 96.1104C23.2725 87.241 28.362 81.9147 35.5622 77.1046C43.8649 71.5437 52.7069 69.033 61.1737 69.8308C64.9967 70.1828 64.6917 69.9247 64.1992 72.4822C62.2525 82.5013 63.8005 92.6378 67.9753 97.354C73.1116 103.079 81.9771 102 85.0027 95.2657C86.3395 92.2858 86.3864 87.7103 85.1434 83.9796C83.1498 78.0901 80.007 73.8197 75.4335 70.8163C73.8152 69.7604 70.4848 68.1883 69.875 68.1883C69.359 68.1883 69.4294 67.6487 70.2268 65.3257C72.3377 59.2486 75.457 52.7021 78.4122 48.244C83.2436 40.9232 91.4524 32.5701 99.1687 27.103C105.806 22.4102 113.241 18.5386 120.512 16.0045C123.772 14.8548 129.87 13.1889 130.081 13.3766C130.128 13.447 129.541 14.362 128.791 15.4414C124.78 21.0258 122.716 26.0706 122.388 30.998C122.224 33.7198 122.341 34.588 122.88 34.2595C122.998 34.1891 123.678 32.969 124.405 31.5611C126.281 27.8069 131.722 20.6738 139.579 11.6402C141.127 9.85697 142.652 7.86254 143.027 7.08823C144.552 4.03792 143.52 1.48035 140.377 0.471397C139.439 0.166366 138.102 0.0490408 134.584 0.0255769C132.074 -0.021351 129.635 0.00212153 129.189 0.0490494ZM137.117 4.92955C137.187 5.0234 136.718 5.63346 136.061 6.29045L134.865 7.48712L131.042 6.73627C128.931 6.33739 126.727 5.9385 126.14 5.8681C124.827 5.68039 124.123 5.32843 124.968 5.28151C125.296 5.28151 126.868 5.11725 128.486 4.953C131.3 4.64797 136.812 4.62451 137.117 4.92955ZM71.5168 72.5292C76.2075 74.899 79.4441 78.8175 81.3204 84.355C83.6189 91.1361 81.2266 96.8378 76.0433 96.8847C73.3227 96.9082 70.9773 95.2188 69.5936 92.2389C68.2802 89.4232 67.6938 86.5606 67.5765 82.1259C67.4593 78.3248 67.6 76.4242 68.2333 72.7403L68.4912 71.2856L69.359 71.5906C69.8515 71.7548 70.8132 72.1772 71.5168 72.5292Z"
        fill="currentColor"
      />
    </svg>

    <span className="block text-base w-fit bg-primary text-white shadow px-1.5 py-0.5 rounded -mt-1 ml-8 -rotate-2">
      Save $$$
    </span>
  </div>
);

interface PriceCardProps {
  selected: "M" | "A";
}

const PriceCards = ({ selected }: PriceCardProps) => (
  <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-4 w-full max-w-6xl mx-auto relative z-10">
    <div className="w-full bg-[#F5F5F5] px-6 pt-6 pb-10 h-fit border border-input rounded-xl">
      <p className="text-2xl text-black font-medium">Basic plan</p>
      <p className="text-lg text-black/70">Perfect for individials</p>
      <Separator className=" w-full mt-4" orientation="horizontal" />
      <div className=" py-6 flex flex-col gap-4">
        <AnimatePresence mode="wait">
          {selected === "M" ? (
            <motion.p
              key="monthly1"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-black"
            >
              <span>$5</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          ) : (
            <motion.p
              key="monthly2"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-black"
            >
              <span>$2</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          )}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.015 }}
          whileTap={{ scale: 0.985 }}
          className="w-full h-11 py-2 font-medium bg-primary text-white rounded-lg"
        >
          Get Started
        </motion.button>
      </div>
      <Separator className="mb-4 w-full" orientation="horizontal" />

      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">10,000 requests/month</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">Basic in app support</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">2 users on your account</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>

      <div className=" pl-8 mt-8">
        <span className="text-lg text-black hover:text-primary underline underline-offset-4">
          Learn More
        </span>
      </div>
    </div>
    <div className="w-full bg-primary px-6 pt-6 pb-10 h-fit  rounded-xl">
      <p className="text-2xl text-white font-medium">Pro plan</p>
      <p className="text-lg text-white">Perfect for small teams</p>
      <Separator className=" w-full mt-4 opacity-50" orientation="horizontal" />
      <div className=" py-6 flex flex-col gap-4">
        <AnimatePresence mode="wait">
          {selected === "M" ? (
            <motion.p
              key="monthly1"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-white"
            >
              <span>$9</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          ) : (
            <motion.p
              key="monthly2"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-white"
            >
              <span>$6</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          )}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.015 }}
          whileTap={{ scale: 0.985 }}
          className="w-full h-11 py-2 font-medium bg-white text-black rounded-lg"
        >
          Get Started
        </motion.button>
      </div>
      <Separator className="mb-4 w-full opacity-50" orientation="horizontal" />

      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">10,000 requests/month</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">Basic in app support</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">2 users on your account</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">2 users on your account</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">2 users on your account</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-white" />
        <span className="text-lg text-white">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-white" />
        <span className="text-lg text-white">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <X className=" text-white" />
        <span className="text-lg text-white">1 workspace</span>
      </div>

      <div className=" pl-8 mt-8">
        <span className="text-lg text-white hover:text-primary underline underline-offset-4">
          Learn More
        </span>
      </div>
    </div>
    <div className="w-full bg-[#F5F5F5] px-6 pt-6 pb-10 h-fit border border-input rounded-xl">
      <p className="text-2xl text-black font-medium">Advanced plan</p>
      <p className="text-lg text-black/70">Perfect for enterprise</p>
      <Separator className=" w-full mt-4" orientation="horizontal" />
      <div className=" py-6 flex flex-col gap-4">
        <AnimatePresence mode="wait">
          {selected === "M" ? (
            <motion.p
              key="yearly1"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-black"
            >
              <span>$15</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          ) : (
            <motion.p
              key="yearly2"
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ ease: "linear", duration: 0.25 }}
              className="text-5xl font-medium text-black"
            >
              <span>$12</span>
              <span className="font-normal text-2xl opacity-70">/mo</span>
            </motion.p>
          )}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.015 }}
          whileTap={{ scale: 0.985 }}
          className="w-full h-11 py-2 font-medium bg-primary text-white rounded-lg"
        >
          Get Started
        </motion.button>
      </div>
      <Separator className="mb-4 w-full" orientation="horizontal" />

      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">10,000 requests/month</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">Basic in app support</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">2 users on your account</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Check className=" text-black opacity-70" />
        <span className="text-lg text-black/70">1 workspace</span>
      </div>

      <div className=" pl-8 mt-8">
        <span className="text-lg text-black hover:text-primary underline underline-offset-4">
          Learn More
        </span>
      </div>
    </div>{" "}
  </div>
);
