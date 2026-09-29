/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        /** Cloudflare Kumo neutral scale. */
        slate: {
          50: 'oklch(98.5% 0 0 / <alpha-value>)',
          100: 'oklch(97% 0 0 / <alpha-value>)',
          200: 'oklch(92.2% 0 0 / <alpha-value>)',
          300: 'oklch(87% 0 0 / <alpha-value>)',
          400: 'oklch(70.8% 0 0 / <alpha-value>)',
          500: 'oklch(55.6% 0 0 / <alpha-value>)',
          600: 'oklch(43.9% 0 0 / <alpha-value>)',
          700: 'oklch(37.1% 0 0 / <alpha-value>)',
          800: 'oklch(26.9% 0 0 / <alpha-value>)',
          900: 'oklch(20.5% 0 0 / <alpha-value>)',
          950: 'oklch(14.5% 0 0 / <alpha-value>)',
        },
        /** Legacy sky utilities are also primary/info interaction aliases. */
        sky: {
          50: 'oklch(97% 0.014 254.604 / <alpha-value>)',
          100: 'oklch(93.2% 0.032 255.585 / <alpha-value>)',
          200: 'oklch(88.2% 0.059 254.128 / <alpha-value>)',
          300: 'oklch(80.9% 0.105 251.813 / <alpha-value>)',
          400: 'oklch(70.7% 0.165 254.624 / <alpha-value>)',
          500: 'oklch(62.3% 0.214 259.815 / <alpha-value>)',
          600: 'oklch(54.6% 0.245 262.881 / <alpha-value>)',
          700: 'oklch(48.8% 0.243 264.376 / <alpha-value>)',
          800: 'oklch(42.4% 0.199 265.638 / <alpha-value>)',
          900: 'oklch(37.9% 0.146 265.522 / <alpha-value>)',
          950: 'oklch(28.2% 0.091 267.935 / <alpha-value>)',
        },
        /**
         * Existing violet utilities are semantic interaction aliases.
         * Map them onto the Kumo/Tailwind blue scale so links, focus,
         * selection and primary actions move together.
         */
        violet: {
          50: 'oklch(97% 0.014 254.604 / <alpha-value>)',
          100: 'oklch(93.2% 0.032 255.585 / <alpha-value>)',
          200: 'oklch(88.2% 0.059 254.128 / <alpha-value>)',
          300: 'oklch(80.9% 0.105 251.813 / <alpha-value>)',
          400: 'oklch(70.7% 0.165 254.624 / <alpha-value>)',
          500: 'oklch(62.3% 0.214 259.815 / <alpha-value>)',
          600: 'oklch(54.6% 0.245 262.881 / <alpha-value>)',
          700: 'oklch(48.8% 0.243 264.376 / <alpha-value>)',
          800: 'oklch(42.4% 0.199 265.638 / <alpha-value>)',
          900: 'oklch(37.9% 0.146 265.522 / <alpha-value>)',
          950: 'oklch(28.2% 0.091 267.935 / <alpha-value>)',
        },
        gdc: {
          /** Kumo dark surface hierarchy. */
          page: 'oklch(10% 0 0 / <alpha-value>)',
          /** Backward-compatible semantic canvas alias used by overlays and form surfaces. */
          bg: 'oklch(10% 0 0 / <alpha-value>)',
          panel: 'oklch(17% 0 0 / <alpha-value>)',
          section: 'oklch(15% 0 0 / <alpha-value>)',
          card: 'oklch(17% 0 0 / <alpha-value>)',
          cardHover: 'oklch(26.9% 0 0 / <alpha-value>)',
          elevated: 'oklch(12% 0 0 / <alpha-value>)',
          tableHeader: 'oklch(15% 0 0 / <alpha-value>)',
          rowHover: 'oklch(26.9% 0 0 / <alpha-value>)',
          /** Stable row surface for non-hover state variants. */
          row: 'oklch(26.9% 0 0 / <alpha-value>)',
          border: 'oklch(32% 0 0 / <alpha-value>)',
          borderStrong: 'oklch(37.1% 0 0 / <alpha-value>)',
          divider: 'oklch(26.9% 0 0 / <alpha-value>)',
          /** Kumo dark typography hierarchy. */
          muted: 'oklch(70.8% 0 0 / <alpha-value>)',
          mutedStrong: 'oklch(98.5% 0 0 / <alpha-value>)',
          foreground: 'oklch(97% 0 0 / <alpha-value>)',
          placeholder: 'oklch(55.6% 0 0 / <alpha-value>)',
          /** Kumo control / interaction surfaces. */
          input: 'oklch(21% 0.006 285.885 / <alpha-value>)',
          inputHover: 'oklch(26.9% 0 0 / <alpha-value>)',
          inputBorder: 'oklch(32% 0 0 / <alpha-value>)',
          primary: 'oklch(52% 0.209 260 / <alpha-value>)',
          /** Destructive action pair shared by light/dark overlays. */
          critical: 'oklch(57.7% 0.245 27.325 / <alpha-value>)',
          criticalFg: 'oklch(97.1% 0.013 17.38 / <alpha-value>)',
        },
      },
      fontSize: {
        /** Exact Kumo base typography scale. */
        xs: ['12px', { lineHeight: 'calc(1 / 0.75)' }],
        sm: ['13px', { lineHeight: 'calc(1 / 0.85)' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg: ['16px', { lineHeight: '1.5' }],
      },
      letterSpacing: {
        tighter: '0em',
        tight: '0em',
        normal: '0em',
        wide: '0em',
        wider: '0em',
        widest: '0em',
      },
      fontWeight: {
        /** Kumo uses semibold rather than visually heavy 700-weight UI copy. */
        bold: '600',
      },
      borderRadius: {
        /** Normalize legacy large cards to Kumo's compact 8px visual radius. */
        xl: '0.5rem',
        '2xl': '0.5rem',
        '3xl': '0.5rem',
      },
      transitionProperty: {
        /** Kumo hover colors change immediately. */
        colors: 'none',
      },
      boxShadow: {
        /** Flat bordered surfaces are shadowless; reserve depth for overlays. */
        DEFAULT: 'none',
        sm: 'none',
        'gdc-card': 'none',
        'gdc-elevated': '0 12px 32px rgba(0, 0, 0, 0.38)',
        'gdc-control': 'none',
      },
      backgroundImage: {
        'gdc-page-glow': 'none',
      },
    },
  },
  darkMode: 'class',
  plugins: [],
}
