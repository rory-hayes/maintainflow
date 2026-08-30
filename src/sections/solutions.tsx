import {
  ListChecks,
  MessageCircleHeartIcon,
  UserCircleIcon,
} from "lucide-react";

import productImage from "@/assets/images/product-img-1.png";
import Image from "next/image";
import { Separator } from "@/components/ui/separator";

const Solutions = () => {
  return (
    <section id="solutions" className=" py-24">
      <div className=" w-full flex flex-col items-center">
        <div className="container w-full flex flex-col items-center">
          <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-6">
            <p className=" text-lg">Solutions</p>
          </div>

          <h2 className=" text-5xl md:text-7xl max-w-2xl font-medium text-center mt-6 mx-auto">
            Solve your team&apos;s biggest challenges
          </h2>
        </div>

        <div className="relative w-full h-fit overflow-y-clip">
          <Separator
            className=" w-full absolute top-12"
            orientation="horizontal"
          />
          <aside className=" hidden lg:block">
            <div className=" w-full flex items-center px-72 justify-between absolute h-full top-12">
              <div className=" h-full flex flex-col items-center -ml-12">
                <div className=" h-4 w-4 -mt-2 aspect-square bg-white border border-input rounded-full" />
                <Separator className=" h-full top-12" orientation="vertical" />
              </div>
              <div className=" h-full flex flex-col items-center">
                <div className=" h-4 w-4 -mt-2 aspect-square bg-white border border-input rounded-full" />
                <Separator className=" h-full top-12" orientation="vertical" />
              </div>
              <div className=" h-full flex flex-col items-center">
                <div className=" h-4 w-4 -mt-2 aspect-square bg-white border border-input rounded-full" />
                <Separator className=" h-full top-12" orientation="vertical" />
              </div>
              <div className=" h-full flex flex-col items-center -mr-12">
                <div className=" h-4 w-4 -mt-2 aspect-square bg-white border border-input rounded-full" />
                <Separator className=" h-full top-12" orientation="vertical" />
              </div>
            </div>
          </aside>
          <div className=" max-w-7xl mx-auto w-full px-4 md:px-0">
            <div className=" w-full grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-20 py-8 mt-14 md:mt-20">
              <div className="flex flex-col items-start w-full">
                <MessageCircleHeartIcon className=" text-gold" size={32} />
                <h4 className=" text-xl mt-4">
                  Ensure your team is always on the same page with task-sharing
                  and transparent updates.
                </h4>
              </div>

              <div className="flex flex-col items-start w-full">
                <ListChecks className=" text-gold" size={32} />
                <h4 className=" text-xl mt-4">
                  Ensure your team is always on the same page with task-sharing
                  and transparent updates.
                </h4>
              </div>

              <div className="flex flex-col items-start w-full">
                <UserCircleIcon className=" text-gold" size={32} />
                <h4 className=" text-xl mt-4">
                  Ensure your team is always on the same page with task-sharing
                  and transparent updates.
                </h4>
              </div>
            </div>

            <div className=" w-full h-auto aspect-video md:aspect-auto md:h-[40rem] relative mt-10">
              <div className=" absolute bottom-0 h-40 w-full bg-gradient-to-b from-transparent to-white z-50" />
              <Image
                fill
                quality={100}
                src={productImage}
                alt="Product image"
                className=" object-cover object-top"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Solutions;
