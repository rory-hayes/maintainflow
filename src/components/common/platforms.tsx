import { FloatingDock } from "./floating-cards";

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

export function FloatingDockDemo() {
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
    <div className=" flex flex-col -space-y-20">
      <div className="flex items-center justify-center w-full h-[20rem]">
        <FloatingDock items={row1} />
      </div>
      <div className="flex items-center justify-center w-full h-[20rem]">
        <FloatingDock items={row2} />
      </div>
    </div>
  );
}
