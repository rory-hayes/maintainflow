import { twMerge } from "tailwind-merge";

export default function Pointer(props: {
  name: string;
  color?: "orange" | "blue" | "green" | "violet";
}) {
  const { name, color } = props;

  const iconColor =
    color === "orange"
      ? "#F97316"
      : color === "green"
      ? "#22C55E"
      : color === "violet"
      ? "#8B5CF6"
      : "#3B82F6";
  return (
    <div className=" relative">
      <svg
        width="32"
        height="32"
        viewBox="0 0 42 45"
        fill="none"
        stroke="black"
        strokeWidth="1"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g filter="url(#filter0_d_1_3)">
          <path d="M12 36L5 4L34.5 20.5L20.5 23.5L12 36Z" fill={iconColor} />
          <path
            d="M12 36L5 4L34.5 20.5L20.5 23.5L12 36Z"
            stroke="white"
            strokeWidth="3"
          />
        </g>
        <defs>
          <filter
            id="filter0_d_1_3"
            x="0.322098"
            y="0.563164"
            width="40.8825"
            height="43.6636"
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha"
            />
            <feOffset dy="2" />
            <feGaussianBlur stdDeviation="1.25" />
            <feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.19 0"
            />
            <feBlend
              mode="normal"
              in2="BackgroundImageFix"
              result="effect1_dropShadow_1_3"
            />
            <feBlend
              mode="normal"
              in="SourceGraphic"
              in2="effect1_dropShadow_1_3"
              result="shape"
            />
          </filter>
        </defs>
      </svg>

      <div className=" absolute top-full left-full text-white">
        <div
          className={twMerge(
            " inline-flex rounded-full font-medium py-0.5 text-base bg-blue-500 px-3 rounded-tl-none",
            color === "orange" && "bg-orange-500",
            color === "green" && "bg-green-500",
            color === "violet" && "bg-violet-500"
          )}
        >
          {name}
        </div>
      </div>
    </div>
  );
}
