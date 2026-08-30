import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const Faq = () => {
  return (
    <section className=" py-40 w-full container px-0">
      <div className="w-full md:max-w-2xl mx-auto flex flex-col items-center">
        <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-6 w-fit mb-6">
          <p className=" text-lg">FAQ&apos;s</p>
        </div>
        <h2 className=" text-5xl md:text-7xl max-w-3xl font-medium text-center mt-6 mx-auto">
          Got A Question?
        </h2>
        <Accordion
          type="single"
          defaultValue="item-1"
          collapsible
          className="w-full gap-2 flex flex-col mt-10"
        >
          <AccordionItem value="item-1">
            <AccordionTrigger>
              How long does a website project usually take to complete?
            </AccordionTrigger>
            <AccordionContent>
              Most website projects at Atlas Labs take 4 to 8 weeks, depending
              on the complexity and specific requirements. We provide a detailed
              timeline after our initial consultation to ensure we meet your
              needs efficiently.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>
              What if I just want a single website?
            </AccordionTrigger>
            <AccordionContent>
              No problem! We offer one-time website design and development
              services tailored to your needs. Reach out to us, and we&apos;ll
              create a custom plan for your project.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>Do you outsource any work?</AccordionTrigger>
            <AccordionContent>
              At Atlas Labs, we handle all core design and development work
              in-house to maintain quality and consistency. For specialized
              services outside our expertise, we collaborate with trusted
              partners who share our commitment to excellence.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-4">
            <AccordionTrigger>What are your payment terms?</AccordionTrigger>
            <AccordionContent>
              At Atlas Labs, we offer flexible payment terms. Our services are
              billed biweekly at a rate of $2,499 per month. There are no
              long-term contracts, and you can pause your subscription at any
              time. Payments are processed securely through Stripe, ensuring
              convenience and security for all transactions.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-5">
            <AccordionTrigger>
              We have a limited budget, will you still work with us?
            </AccordionTrigger>
            <AccordionContent>
              Absolutely! At Atlas Labs, we believe great design should be
              accessible to everyone. We&apos;re happy to discuss your budget
              and find a solution that works for you, whether it&apos;s a phased
              approach, a simplified design, or a customized payment plan. Reach
              out to us, and we&apos;ll explore options to fit your needs.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-6">
            <AccordionTrigger>
              Why wouldn&apos;t I just hire a designer or developer?
            </AccordionTrigger>
            <AccordionContent>
              At Atlas Labs, we value collaboration and believe in working
              closely with our clients throughout the project lifecycle. To
              collaborate with us, simply reach out to our team through our
              website&apos;s contact form, email, or phone. We will schedule a
              consultation to discuss your project requirements, goals, and
              expectations. Once we have a clear understanding of your needs, we
              will work together to develop a tailored plan and establish
              effective channels of communication to ensure smooth collaboration
              throughout the project.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  );
};

export default Faq;
