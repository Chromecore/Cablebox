export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'app-bg':     '#0f1724',
        'app-nav':    '#0c1520',
        'app-card':   '#1e2a3a',
        'app-blue':   '#2d34a4',
        'app-cyan':   '#0891b2',
        'app-pink':   '#ff0095',
        // app-purple uses a CSS variable so the accent color can be changed at runtime
        'app-purple': ({ opacityValue }) =>
          opacityValue !== undefined
            ? `rgba(var(--accent-rgb), ${opacityValue})`
            : 'var(--accent)',
        'app-orange': '#ff6b00',
        'app-green':  '#00ff88',
        'app-yellow': '#ffe600',
      },
      fontFamily: {
        sans:    ['Outfit', 'sans-serif'],
        display: ['Montserrat', 'sans-serif'],
        mono:    ['Space Mono', 'monospace'],
      },
      boxShadow: {
        hard:    '4px 4px 0px 0px rgba(0,0,0,0.8)',
        'hard-sm': '2px 2px 0px 0px rgba(0,0,0,0.8)',
      },
    },
  },
  plugins: [],
}
