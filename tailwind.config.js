/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#172638',
        brand: '#2296B5',
        canvas: '#F3F6F9',
      },
      boxShadow: { card: '0 1px 2px rgba(15, 23, 42, .04), 0 8px 24px rgba(15, 23, 42, .04)' },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'Consolas', 'monospace'] },
    },
  },
  plugins: [],
}
