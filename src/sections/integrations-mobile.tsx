import googleDrive from "@/assets/images/google-drive.png";
import creativeCloud from "@/assets/images/creative-cloud.png";
import jira from "@/assets/images/jira.png";
import gmail from "@/assets/images/gmail.png";
import figma from "@/assets/images/figma-lg.png";
import outlook from "@/assets/images/outlook.png";
import slack from "@/assets/images/slack.png";

import mega from "@/assets/images/mega.png";
import airtable from "@/assets/images/airtable.png";
import googleCalendar from "@/assets/images/google-calendar.png";
import intercomm from "@/assets/images/intercomm.png";
import salesForce from "@/assets/images/salesforce.png";
import googleMeet from "@/assets/images/google-meet.png";
import hubspot from "@/assets/images/hubspot.png";

import Marquee from "react-fast-marquee";
import Image from "next/image";

const IntegrationsMobile = () => {
  const row1 = [
    {
      title: "Google Drive",
      icon: googleDrive,
      href: "#",
    },
    {
      title: "Creative Cloud",
      icon: creativeCloud,
      href: "#",
    },
    {
      title: "Jira",
      icon: jira,
      href: "#",
    },
    {
      title: "Gmail",
      icon: gmail,
      href: "#",
    },
    {
      title: "Figma",
      icon: figma,
      href: "#",
    },
    {
      title: "Outlook",
      icon: outlook,
      href: "#",
    },
    {
      title: "Slack",
      icon: slack,
      href: "#",
    },
  ];

  const row2 = [
    {
      title: "Mega",
      icon: mega,
      href: "#",
    },
    {
      title: "Hubspot",
      icon: hubspot,
      href: "#",
    },
    {
      title: "Google Calendar",
      icon: googleCalendar,
      href: "#",
    },
    {
      title: "Intercomm",
      icon: intercomm,
      href: "#",
    },
    {
      title: "Airtable",
      icon: airtable,
      href: "#",
    },
    {
      title: "Salesforce",
      icon: salesForce,
      href: "#",
    },
    {
      title: "Google Meet",
      icon: googleMeet,
      href: "#",
    },
  ];

  return (
    <section id="integrations-mobile" className=" md:hidden py-20">
      <div className=" max-w-7xl w-full flex flex-col items-center mx-auto">
        <div className=" inline-flex bg-white border rounded-full shadow-md items-center justify-center py-2 px-6">
          <p className=" text-lg">Integrations</p>
        </div>

        <h2 className=" text-5xl px-4 md:px-0 md:text-7xl max-w-2xl font-medium text-center mt-6 mx-auto">
          Connect integrations you use every day
        </h2>
      </div>
      <Marquee className=" mt-12">
        {row1.map((item) => (
          <div
            key={item.title}
            className="flex items-center mr-4 justify-center bg-white h-32 aspect-square rounded-xl border border-input"
          >
            <div className=" h-16 aspect-square relative">
              <Image
                fill
                className=" object-contain"
                src={item.icon}
                alt={item.title}
              />
            </div>
          </div>
        ))}
      </Marquee>
      <Marquee direction="right" className=" mt-4">
        {row2.map((item) => (
          <div
            key={item.title}
            className="flex items-center mr-4 justify-center bg-white h-32 aspect-square rounded-xl border border-input"
          >
            <div className=" h-16 aspect-square relative">
              <Image
                fill
                className=" object-contain"
                src={item.icon}
                alt={item.title}
              />
            </div>
          </div>
        ))}
      </Marquee>
    </section>
  );
};

export default IntegrationsMobile;
