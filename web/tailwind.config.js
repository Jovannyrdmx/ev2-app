/** Tailwind for the EV2 screens (D71). Compiled by `npm run build:css`. */
module.exports = {
  content: ['./*.html', './js/**/*.js'],
  theme: {
    extend: {
      colors: {
        ev2: {
          cyan: 'var(--ev2-cyan)', pink: 'var(--ev2-pink)', lime: 'var(--ev2-lime)',
          gold: 'var(--ev2-gold)', red: 'var(--ev2-red)', panel: 'var(--ev2-panel)',
          muted: 'var(--ev2-muted)',
        },
      },
      fontFamily: { display: ['Poppins', 'Inter', 'sans-serif'] },
    },
  },
  plugins: [],
};
