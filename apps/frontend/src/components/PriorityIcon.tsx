import { ACCENT } from '../lib/palette.js';

const RED = ACCENT.red;
const ORANGE = ACCENT.orange;
const BLUE = ACCENT.blue;

function ChevronUp({ color, y }: { color: string; y: number }) {
  return (
    <path
      d={`M3 ${y + 4} L8 ${y} L13 ${y + 4}`}
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

function ChevronDown({ color, y }: { color: string; y: number }) {
  return (
    <path
      d={`M3 ${y} L8 ${y + 4} L13 ${y}`}
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

export default function PriorityIcon({ name, size = 16 }: { name: string; size?: number }) {
  const n = name.toLowerCase();
  let body;
  if (n === 'highest') {
    body = (
      <>
        <ChevronUp color={RED} y={2} />
        <ChevronUp color={RED} y={8} />
      </>
    );
  } else if (n === 'high') {
    body = <ChevronUp color={RED} y={5} />;
  } else if (n === 'low') {
    body = <ChevronDown color={BLUE} y={7} />;
  } else if (n === 'lowest') {
    body = (
      <>
        <ChevronDown color={BLUE} y={4} />
        <ChevronDown color={BLUE} y={10} />
      </>
    );
  } else {
    body = <ChevronUp color={ORANGE} y={5} />;
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-label={name}
      role="img"
      className="inline-block shrink-0"
    >
      {body}
    </svg>
  );
}
