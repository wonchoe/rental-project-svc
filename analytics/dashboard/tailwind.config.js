module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.{html,js}',
  ],
  theme: {
    extend: {
      fontFamily: { 
        sans: ['Inter', 'sans-serif'] 
      },
      colors: {
        dark: { 
          800: '#1e1e2e', 
          900: '#11111b', 
          700: '#313244' 
        },
        accent: { 
          500: '#f97316', 
          600: '#ea580c' 
        }
      }
    }
  },
  plugins: [],
}
