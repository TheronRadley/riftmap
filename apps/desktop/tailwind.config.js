/** @type {import('tailwindcss').Config} */
const here = new URL('./', import.meta.url).pathname;

export default {
  // Absolute content globs: Tailwind resolves relative globs against the
  // process working directory, which is not always this package.
  content: [`${here}index.html`, `${here}src/**/*.{ts,tsx}`],
  theme: {
    extend: {
      colors: {
        graphite: {
          950: '#0d0f13',
          900: '#12151a',
          850: '#171b21',
          800: '#1c2128',
          750: '#22282f',
          700: '#2a313a',
          600: '#3a4350',
          500: '#55606f',
          400: '#7c879a',
          300: '#a6b0c0',
          200: '#cdd4de',
          100: '#e7ebf1',
        },
        accent: {
          DEFAULT: '#22d3ee',
          strong: '#67e8f9',
          dim: '#0e7490',
        },
        attention: {
          high: '#f59e0b',
          moderate: '#22d3ee',
          lower: '#55606f',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
};
