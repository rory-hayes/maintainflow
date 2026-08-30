import Image from "next/image";
import BlogImage1 from "@/assets/images/blog-1.png";
import BlogCard from "./blog-card";
import BlogImage2 from "@/assets/images/blog-2.png";

const BlogHero = () => {
  return (
    <section className=" w-full px-4 md:px-0">
      <div className=" container w-full flex flex-col items-center pt-12">
        <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-4">
          <p className=" text-lg">Blog Post</p>
        </div>
        <h2 className=" text-5xl md:text-7xl font-medium text-center mt-6 mx-auto">
          Webflow vs. Wix: Unraveling the Best Website Builder
        </h2>
        <p className=" text-lg opacity-70 mt-4 md:mt-6">
          29 November 2024 • 08:45 AM
        </p>
      </div>
      <div className="md:max-w-7xl w-full relative h-auto aspect-video md:aspect-auto md:h-[44rem] mx-auto mt-12">
        <Image
          quality={100}
          fill
          src={BlogImage1}
          className=" object-cover rounded-xl md:rounded-[2rem]"
          alt="Blog hero image"
        />
      </div>
      <div className=" container w-full md:px-40 py-12 px-0">
        <p className=" text-xl text-black opacity-70 mb-10">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>
        <h3 className=" text-4xl font-medium text-black">Webflow</h3>
        <p className=" text-xl text-black opacity-70 mt-4">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>
        <p className=" text-xl text-black opacity-70 mt-4">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>

        <h3 className=" text-4xl font-medium text-black mt-10">Framer</h3>
        <p className=" text-xl text-black opacity-70 mt-4">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>
        <p className=" text-xl text-black opacity-70 mt-4">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>
        <p className=" text-xl text-black opacity-70 mt-4">
          Lorem ipsum dolor, sit amet consectetur adipisicing elit. At illo
          perspiciatis itaque, unde iste nesciunt voluptatem nemo, quasi cumque
          libero pariatur optio, soluta sunt nulla veniam minima! Sapiente,
          quibusdam delectus.
        </p>
      </div>

      <div className=" max-w-7xl mx-auto py-20">
        <h1 className=" text-4xl md:text-5xl text-black font-medium mb-6">
          Next Read
        </h1>
        <BlogCard img={BlogImage2} />
      </div>
    </section>
  );
};

export default BlogHero;
