import { FloatingDockDemo } from "@/components/common/platforms";

const Integrations = () => {
  return (
    <section id="integrations" className=" py-24 hidden md:block">
      <div className=" max-w-7xl w-full flex flex-col items-center mx-auto">
        <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-6">
          <p className=" text-lg">Integrations</p>
        </div>

        <h2 className=" text-5xl px-4 md:px-0 md:text-7xl max-w-2xl font-medium text-center mt-6 mx-auto">
          Connect integrations you use every day
        </h2>
      </div>
      <div>
        <FloatingDockDemo />
      </div>
    </section>
  );
};

export default Integrations;
