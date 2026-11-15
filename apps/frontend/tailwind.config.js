/** @type {import('tailwindcss').Config} */

/* atl-* colors resolve through CSS custom properties defined in index.css so a
 * single class palette serves light and dark themes. --atl-* hold "R G B"
 * triplets; <alpha-value> keeps opacity modifiers (e.g. bg-atl-n-800/30) working. */
const v = (name) => `rgb(var(--atl-${name}) / <alpha-value>)`;

export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'atl-paper': v('paper'),
        'atl-topbar': v('topbar'),
        atl: {
          n: {
            900: v('n-900'),
            800: v('n-800'),
            700: v('n-700'),
            600: v('n-600'),
            500: v('n-500'),
            400: v('n-400'),
            300: v('n-300'),
            200: v('n-200'),
            100: v('n-100'),
            90: v('n-90'),
            80: v('n-80'),
            70: v('n-70'),
            60: v('n-60'),
            50: v('n-50'),
            40: v('n-40'),
            30: v('n-30'),
            20: v('n-20'),
            10: v('n-10'),
          },
          b: {
            500: v('b-500'),
            400: v('b-400'),
            300: v('b-300'),
            200: v('b-200'),
            100: v('b-100'),
            75: v('b-75'),
            50: v('b-50'),
          },
          inverse: v('inverse'),
          card: v('card'),
          lozenge: {
            new: v('lozenge-new'),
            progress: v('lozenge-progress'),
            done: v('lozenge-done'),
          },
          g: {
            500: v('g-500'),
            400: v('g-400'),
            300: v('g-300'),
            200: v('g-200'),
            75: v('g-75'),
            50: v('g-50'),
          },
          y: {
            500: v('y-500'),
            300: v('y-300'),
            75: v('y-75'),
            50: v('y-50'),
          },
          r: {
            500: v('r-500'),
            400: v('r-400'),
            300: v('r-300'),
            50: v('r-50'),
          },
          p: {
            700: v('p-700'),
            300: v('p-300'),
            200: v('p-200'),
            50: v('p-50'),
          },
          t: {
            300: v('t-300'),
            200: v('t-200'),
            50: v('t-50'),
          },
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Noto Sans"',
          'Ubuntu',
          '"Droid Sans"',
          '"Helvetica Neue"',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
