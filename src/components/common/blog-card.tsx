import Image, { StaticImageData } from "next/image";

import { Button } from "../ui/button";
import Link from "next/link";

interface BlogCardProps {
  img: StaticImageData;
}

const BlogCard = ({ img }: BlogCardProps) => {
  return (
    <Link href="/blog/slug">
      <div className=" w-full border border-input rounded-[2rem] p-2 md:p-4 gap-6 md:gap-12 flex flex-col md:flex-row items-center justify-between">
        <div className=" w-full h-[24rem] relative">
          <Image
            fill
            src={img}
            alt="Blog image"
            className="rounded-3xl object-cover"
          />
        </div>
        <div className=" w-full flex flex-col items-start md:pr-8 pb-4 md:pb-0 px-4 md:px-0">
          <p className=" text-lg">December 27, 2023</p>
          <h3 className=" text-4xl font-medium mt-2">
            Webflow vs. Wix: Unraveling the Best Website Builder for Your
            Project
          </h3>
          <h4 className=" text-lg opacity-70 mt-2 line-clamp-3 md:line-clamp-none">
            Lorem ipsum dolor sit amet consectetur adipisicing elit. Corporis,
            alias repudiandae voluptatem maiores earum, fuga cum consequuntur
            nulla officia repellat illum ipsam non veniam quisquam eaque
            incidunt. Reiciendis, commodi a.
          </h4>
          <Button className=" mt-4 hidden md:block" variant="outline">
            Read More
          </Button>
        </div>
      </div>
    </Link>
  );
};

export default BlogCard;
