/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/*.html", "./public/*.js", "./private_views/*.html"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        "primary": "#135bec",
        "background-light": "#f8fafc",
        "background-dark": "#0b0f1a",
        "surface-light": "#ffffff",
        "surface-dark": "#111722",
        "surface-light-2": "#f1f5f9",
        "surface-dark-2": "#1a2235",
      },
      fontFamily: {
        "display": ["var(--app-font-family, 'JetBrains Mono')", "monospace"]
      },
      borderRadius: {
        "DEFAULT": "0.5rem",
        "lg": "0.5rem",
        "xl": "0.75rem",
        "full": "9999px"
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
}
