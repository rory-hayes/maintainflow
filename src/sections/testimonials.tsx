import user1 from "@/assets/images/user-1.jpg";
import videoThumbnail from "@/assets/images/video-thumbnail.png";
import Image from "next/image";

const Testimonials = () => {
  return (
    <section className=" w-full flex flex-col items-center">
      <div className=" inline-flex bg-white border rounded-full shadow-sm-md items-center justify-center py-2 px-6">
        <p className=" text-lg">Testimonials</p>
      </div>

      <h2 className="px-4 md:px-0 text-5xl md:text-7xl max-w-3xl font-medium text-center mt-6 mx-auto">
        People just like you are already using Prodexa
      </h2>
      <div className="grid gap-4 p-4 md:grid-cols-3 md:grid-rows-3 max-w-7xl mt-12">
        <div className=" bg-[#F5F5F5] hover:bg-white col-span-1 row-span-2 p-6 flex flex-col justify-between border rounded-2xl shadow-sm">
          <h4 className="mb-4 text-xl">
            <span className=" font-semibold text-2xl">&ldquo;</span> Prodexa has
            completely changed how my team collaborates and manages projects.
            The intuitive task management features make assigning and tracking
            tasks seamless, while real-time updates ensure everyone stays
            aligned no matter where they&apos;re working from. <br />
            <br /> We&apos;ve seen a noticeable improvement in meeting deadlines
            and overall productivity. It&apos;s the tool we didn&apos;t know we
            needed but now can&apos;t live without!{" "}
            <span className=" font-semibold text-2xl">&ldquo;</span>
          </h4>
          <div className="flex items-center gap-6">
            <Image
              src={user1}
              alt="John D."
              className=" aspect-square h-14 rounded-lg"
              width={56}
              height={56}
            />
            <div className="flex flex-col  gap-1">
              <p className="font-medium text-xl">John D.</p>
              <p className="text-lg text-black/70">Marketing Lead</p>
            </div>
          </div>
        </div>

        <div className=" bg-[#F5F5F5] hover:bg-white col-span-1 row-span-1 p-6 flex flex-col justify-between border rounded-2xl shadow-sm">
          <h4 className="mb-4 text-xl">
            <span className=" font-semibold text-2xl">&ldquo;</span> Prodexa
            isn&apos;t just for businesses—I use it to manage my study schedule,
            group projects, and personal goals. It&apos;s simple, efficient, and
            keeps me organized.{" "}
            <span className=" font-semibold text-2xl">&ldquo;</span>
          </h4>
          <div className="flex items-center gap-6">
            <Image
              src={user1}
              alt="John D."
              className=" aspect-square h-14 rounded-lg"
              width={56}
              height={56}
            />
            <div className="flex flex-col  gap-1">
              <p className="font-medium text-xl">John D.</p>
              <p className="text-lg text-black/70">Marketing Lead</p>
            </div>
          </div>
        </div>

        <div className=" bg-[#F5F5F5] hover:bg-white col-span-1 row-span-1 p-6 flex flex-col justify-between border rounded-2xl shadow-sm">
          <h4 className="mb-4 text-xl">
            <span className=" font-semibold text-2xl">&ldquo;</span> I love how
            Prodexa&apos;s templates make onboarding new employees a breeze.
            Plus, the integrations with HR software have simplified our
            workflows tremendously.{" "}
            <span className=" font-semibold text-2xl">&ldquo;</span>
          </h4>
          <div className="flex items-center gap-6">
            <Image
              src={user1}
              alt="John D."
              className=" aspect-square h-14 rounded-lg"
              width={56}
              height={56}
            />
            <div className="flex flex-col  gap-1">
              <p className="font-medium text-xl">John D.</p>
              <p className="text-lg text-black/70">Marketing Lead</p>
            </div>
          </div>
        </div>

        <div className=" bg-[#F5F5F5] hover:bg-white col-span-1 row-span-2 p-6 flex flex-col justify-between border rounded-2xl shadow-sm">
          <h4 className="mb-4 text-xl">
            <span className=" font-semibold text-2xl">&ldquo;</span> I love how
            Prodexa&apos;s templates make onboarding new employees a breeze.
            Plus, the integrations with HR software have simplified our
            workflows tremendously.{" "}
            <span className=" font-semibold text-2xl">&ldquo;</span>
          </h4>
          <div className="flex items-center gap-6">
            <Image
              src={user1}
              alt="John D."
              className=" aspect-square h-14 rounded-lg"
              width={56}
              height={56}
            />
            <div className="flex flex-col  gap-1">
              <p className="font-medium text-xl">John D.</p>
              <p className="text-lg text-black/70">Marketing Lead</p>
            </div>
          </div>
        </div>

        <div className="col-span-1 md:col-span-2 lg:col-span-1 row-span-2 h-full">
          <div className="relative overflow-hidden rounded-2xl shadow-sm h-[32rem] md:h-full">
            <Image
              src={videoThumbnail}
              alt="Video Review"
              quality={100}
              className="w-full  h-full object-cover"
              fill
            />
            <button className="absolute bottom-4 left-4 px-4 py-2.5 text-base font-medium text-white bg-black bg-opacity-30 backdrop-blur-md rounded-lg">
              Watch Video Review
            </button>
          </div>
        </div>

        <div className=" bg-[#F5F5F5] hover:bg-white col-span-1 row-span-1 p-6 flex flex-col justify-between border rounded-2xl shadow-sm">
          <h4 className="mb-4 text-xl">
            <span className=" font-semibold text-2xl">&ldquo;</span> Prodexa
            isn&apos;t just for businesses—I use it to manage my study schedule,
            group projects, and personal goals. It&apos;s simple, efficient, and
            keeps me organized.{" "}
            <span className=" font-semibold text-2xl">&ldquo;</span>
          </h4>
          <div className="flex items-center gap-6">
            <Image
              src={user1}
              alt="John D."
              className=" aspect-square h-14 rounded-lg"
              width={56}
              height={56}
            />
            <div className="flex flex-col  gap-1">
              <p className="font-medium text-xl">John D.</p>
              <p className="text-lg text-black/70">Marketing Lead</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
