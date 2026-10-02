const path = require('path');
module.exports = {
  content: [path.join(__dirname, '../web/**/*.html'), path.join(__dirname, '../web/js/**/*.js')],
  safelist: [
    { pattern: /^(bg|text|border)-(red|emerald|cyan|pink|amber|slate|blue|green)-(100|200|300|400|500|600|700|800|900)$/ },
    { pattern: /^grid-cols-(1|2|3|4|5|6|7)$/ },
  ],
  theme: { extend: {} },
  plugins: [],
};
