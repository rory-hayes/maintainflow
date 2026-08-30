import Image from "next/image";
import React from "react";
import { Timeline } from "../common/timeline";

import blogImage from "@/assets/images/blog-1.png";

export function Changelog() {
  const data = [
    {
      title: "2024",
      content: (
        <div>
          <p className="text-black/70 text-xl font-normal mb-8">
            Built and launched Astrae Design from scratch
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Image
              src={blogImage}
              alt="startup template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="startup template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="startup template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="startup template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
          </div>
        </div>
      ),
    },
    {
      title: "Early 2023",
      content: (
        <div>
          <p className="text-black/70 text-xl font-normal mb-8">
            I usually run out of copy, but when I see content this big, I try to
            integrate lorem ipsum.
          </p>
          <p className="text-black/70 text-xl font-normal mb-8">
            Lorem ipsum is for people who are too lazy to write copy. But we are
            not. Here are some more example of beautiful designs I built.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Image
              src={blogImage}
              alt="hero template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="feature template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="bento template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="cards template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
          </div>
        </div>
      ),
    },
    {
      title: "Changelog",
      content: (
        <div>
          <p className="text-black/70 text-xl font-normal mb-4">
            Deployed 5 new components on Astrae today
          </p>
          <div className="mb-8">
            <div className="flex gap-2 items-center text-black/70 text-xl">
              Card grid component
            </div>
            <div className="flex gap-2 items-center text-black/70 text-xl">
              Startup template Astrae
            </div>
            <div className="flex gap-2 items-center text-black/70 text-xl">
              Random file upload lol
            </div>
            <div className="flex gap-2 items-center text-black/70 text-xl">
              Himesh Reshammiya Music CD
            </div>
            <div className="flex gap-2 items-center text-black/70 text-xl">
              Salman Bhai Fan Club registrations open
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Image
              src={blogImage}
              alt="hero template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="feature template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="bento template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
            <Image
              src={blogImage}
              alt="cards template"
              width={500}
              height={500}
              className="rounded-lg object-cover h-20 md:h-44 lg:h-60 w-full"
            />
          </div>
        </div>
      ),
    },
  ];
  return (
    <div className="w-full">
      <Timeline data={data} />
    </div>
  );
}
