import Link from "next/link";
import { ReactNode } from "react";

interface NavLinkProps {
  children: ReactNode;
  link: string;
}

const NavLink = ({ children, link }: NavLinkProps) => {
  return (
    <Link
      href={link}
      className="block shrink-0 whitespace-nowrap text-base leading-5 transition-colors hover:text-primary"
    >
      {children}
    </Link>
  );
};
export default NavLink;
