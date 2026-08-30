import featureOneImageOne from "@/assets/images/feature-one-1.png";
import featureOneImageTwo from "@/assets/images/feature-one-2.png";
import featureTwoImageOne from "@/assets/images/feature-two-1.png";
import featureTwoImageTwo from "@/assets/images/feature-two-2.png";
import featureTwoImageThree from "@/assets/images/feature-two-3.png";
import featureThreeImageOne from "@/assets/images/feature-three-1.png";
import featureThreeImageTwo from "@/assets/images/feature-three-2.png";
import featureFourImageOne from "@/assets/images/feature-four-1.png";
import featureFourImageTwo from "@/assets/images/feature-four-2.png";
import featureFourImageThree from "@/assets/images/feature-four-3.png";
import featureFourImageFour from "@/assets/images/feature-four-4.png";

import Image from "next/image";

const Features = () => {
  return (
    <section id="features" className=" w-full p-4 md:p-6">
      <div className=" w-full bg-[#F6F6F6] py-12 md:py-20 rounded-3xl border border-input">
        <div className=" max-w-7xl w-full flex flex-col items-center mx-auto">
          <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-6">
            <p className=" text-lg">Features</p>
          </div>

          <h2 className=" text-5xl md:text-7xl font-medium text-center mt-6 mx-auto">
            Keep everything in one place
          </h2>
          <p className=" text-xl opacity-70 px-4 md:px-0 text-black max-w-lg text-center mt-4">
            Forget complex project management tools.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-5 w-full md:gap-x-6 md:gap-y-6 gap-y-4 px-4 md:px-0 mt-12">
            <div className=" col-span-2 bg-white border flex flex-col items-center justify-between w-full border-input h-[38rem] gap-12 rounded-3xl px-8 pb-12">
              <div className=" h-full w-full relative pt-20">
                <div className=" absolute z-20 w-fit bottom-0 right-0">
                  <Image
                    width={300}
                    height={580}
                    className=""
                    src={featureOneImageOne}
                    alt="Seamless collaboration"
                  />
                </div>
                <div className=" absolute w-fit left-6">
                  <Image
                    width={300}
                    height={560}
                    className="-rotate-12"
                    src={featureOneImageTwo}
                    alt="Seamless collaboration"
                  />
                </div>
              </div>
              <div className="flex flex-col items-center text-center w-full">
                <h3 className=" font-medium text-2xl text-black">
                  Seamless Collaboration
                </h3>

                <p className=" text-xl text-black opacity-70">
                  Work together with your team effortlessly, share tasks, and
                  update progress in real-time.
                </p>
              </div>
            </div>
            <div className=" col-span-3 bg-white overflow-clip border flex flex-col items-center justify-between w-full border-input h-[38rem] gap-12 rounded-3xl px-8 pb-12">
              <div className=" h-full w-full relative mt-10">
                <div className=" absolute z-20 w-fit bottom-0 top-0 right-0 left-auto md:-translate-x-1/2">
                  <Image
                    width={360}
                    height={660}
                    className=""
                    src={featureTwoImageOne}
                    alt="Seamless collaboration"
                  />
                </div>
                <div className=" absolute z-20 w-fit bottom-auto top-1/2 -translate-y-1/2 md:-left-40 right-auto">
                  <Image
                    width={280}
                    height={640}
                    className=" hidden md:block"
                    src={featureTwoImageTwo}
                    alt="Seamless collaboration"
                  />
                </div>
                <div className=" absolute z-20 w-fit bottom-auto top-1/2 -translate-y-1/2 -right-40 left-auto">
                  <Image
                    width={300}
                    height={660}
                    className="hidden md:block"
                    src={featureTwoImageThree}
                    alt="Seamless collaboration"
                  />
                </div>
              </div>
              <div className="flex flex-col items-center text-center w-full">
                <h3 className=" font-medium text-2xl text-black">
                  Time Management Tools
                </h3>

                <p className=" text-xl text-black opacity-70 max-w-lg">
                  Optimize your time with integrated tools like timers,
                  reminders, and schedules
                </p>
              </div>
            </div>
            <div className=" col-span-3 bg-white overflow-clip border flex flex-col md:flex-row items-center justify-between w-full border-input h-[38rem] gap-8 rounded-3xl px-8">
              <div className="flex flex-col md:justify-end text-start w-fit md:h-full pt-12 md:pt-0 md:pb-12">
                <h3 className=" font-medium text-2xl text-black max-w-[10rem]">
                  Advanced Task Tracking
                </h3>

                <p className=" text-xl text-black opacity-70 max-w-[20rem]">
                  A birds eye-view of your entire behaviour and productivity
                </p>
              </div>
              <div className=" w-full h-full">
                <div className=" w-full h-full relative flex flex-col">
                  <div className=" absolute z-20 w-fit -right-64 left-auto top-12">
                    <Image
                      width={620}
                      height={660}
                      quality={100}
                      className=""
                      src={featureThreeImageTwo}
                      alt="Seamless collaboration"
                    />
                  </div>
                  <div className=" absolute -bottom-12 z-20 w-fit -right-20 left-auto">
                    <Image
                      width={640}
                      height={480}
                      quality={100}
                      className=""
                      src={featureThreeImageOne}
                      alt="Seamless collaboration"
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className=" overflow-clip col-span-2 flex flex-col items-center justify-between w-full border-[2px] border-[#CFCFCF] border-dashed h-[38rem] gap-12 rounded-3xl px-8">
              <div className=" w-full relative h-full mt-12">
                <div className=" absolute w-fit bottom-auto top-12  left-0 right-auto">
                  <Image
                    width={180}
                    height={180}
                    className=" -rotate-12"
                    src={featureFourImageTwo}
                    alt="Seamless collaboration"
                  />
                </div>
                <div className=" absolute z-20 w-fit bottom-auto -translate-x-[25%] md:-translate-x-1/2  right-0 left-auto">
                  <Image
                    width={200}
                    height={200}
                    className=""
                    src={featureFourImageOne}
                    alt="Seamless collaboration"
                  />
                </div>
                <div className=" absolute w-fit bottom-auto top-12  right-0 left-auto">
                  <Image
                    width={180}
                    height={180}
                    className=" rotate-12"
                    src={featureFourImageThree}
                    alt="Seamless collaboration"
                  />
                </div>
              </div>
              <div className="flex flex-col items-center text-center mt-20 md:mt-0 w-full h-fit">
                <h3 className=" font-medium text-4xl text-black">
                  Customizable <br /> Workspaces
                </h3>
              </div>
              <div className=" relative h-full w-full">
                <div className=" absolute w-fit -bottom-16 top-auto right-0 left-auto">
                  <Image
                    width={440}
                    height={240}
                    className=""
                    src={featureFourImageFour}
                    alt="Seamless collaboration"
                  />
                </div>
              </div>
            </div>
          </div>

          <p className=" text-xl opacity-70 text-black max-w-lg text-center mt-20">
            and a lot more features...
          </p>
        </div>
      </div>
    </section>
  );
};

export default Features;
