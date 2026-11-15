/**
 * Single source for accent colours used inside SVG props (which cannot use
 * Tailwind classes). Brand/neutral/status colours live in tailwind.config.js
 * as design tokens — do not add new raw hexes here for those.
 */
export const ACCENT = {
  blue: '#0C66E4',
  blueLight: '#1D7AFC',
  green: '#1F845A',
  teal: '#22A06B',
  purple: '#6554C0',
  pink: '#AE4787',
  orange: '#E56910',
  brown: '#D97008',
  red: '#E34935',
  slate: '#44546F',
  white: '#FFFFFF',
} as const;

export const AVATAR_COLORS = [
  ACCENT.blue,
  ACCENT.green,
  ACCENT.pink,
  '#A54900', // orange darkened — white text ≥4.5:1 (WCAG AA, 037)
  ACCENT.purple,
  '#7A4A01', // brown darkened — white text ≥4.5:1
  ACCENT.slate,
];

export const PROJECT_COLORS = [
  ACCENT.blue,
  ACCENT.green,
  ACCENT.pink,
  '#A54900', // orange darkened — white text ≥4.5:1 (WCAG AA, 037)
  ACCENT.purple,
  '#7A4A01', // brown darkened — white text ≥4.5:1
];

/** Project icon background swatches (project settings color picker). */
export const PROJECT_SWATCHES = [
  ACCENT.blue,
  ACCENT.green,
  '#946F00',
  '#AE2E24',
  '#6E5DC6',
  '#227D9B',
  '#943D73',
  '#505258',
];

/** Paints for SVG/canvas attributes — mirrors the atl-* tokens; SVG props
 *  can't use Tailwind classes so the literals live here only. */
export const SVG = {
  text: '#172B4D', // atl-n-800
  subtle: '#5E6C84', // atl-n-300
  label: '#6B778C', // atl-n-200
  n500: '#42526E', // atl-n-500
  n90: '#8993A4', // atl-n-90
  n80: '#97A0AF', // atl-n-80
  n70: '#A5ADBA', // atl-n-70
  n40: '#DFE1E6', // atl-n-40
  n30: '#EBECF0', // atl-n-30
  blue: '#0C66E4', // atl-b-300
  red: '#DE350B', // atl-r-400
  purple: '#403294', // atlassian purple dark
  white: '#FFFFFF',
} as const;

/** Jira report/chart series palette. */
export const CHART = {
  blue: '#0052CC',
  green: '#36B37E',
  yellow: '#FFAB00',
  red: '#FF5630',
  purple: '#6554C0',
  teal: '#00B8D9',
  orange: '#FF8F73',
  lightGreen: '#57D9A3',
  gray: '#8993A4',
} as const;
