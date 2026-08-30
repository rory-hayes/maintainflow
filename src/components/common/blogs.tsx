import BlogCard from "./blog-card";
import BlogImage1 from "@/assets/images/blog-1.png";
import BlogImage2 from "@/assets/images/blog-2.png";

const Blogs = () => {
  return (
    <section className=" pb-40 max-w-7xl w-full mx-auto py-32 px-4 md:px-0">
      <h1 className=" text-4xl md:text-5xl text-black font-medium">Latest Blogs</h1>
      <div className=" flex flex-col gap-6 mt-10">
        <BlogCard img={BlogImage1} />
        <BlogCard img={BlogImage2} />
      </div>
    </section>
  );
};

export default Blogs;
