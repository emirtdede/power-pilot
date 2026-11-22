'use strict';

/**
 * WP-14.T2: Tailwind yalnızca build zamanında çalışır; renderer'a CDN/runtime
 * script'i gönderilmez. Sınıflar HTML + renderer JS içinden taranır.
 */
module.exports = {
    darkMode: 'class',
    content: [
        './src/index.html',
        './src/mini.html',
        './src/renderer/**/*.js'
    ],
    theme: {
        extend: {
            colors: {
                primary: '#0067c2',
                // Koyu temada `text-primary` (#0067c2) koyu zeminlerde
                // 2.40-3.16:1 kalıyordu (WCAG AA: 4.5). Açık mavi ton TÜM
                // koyu zeminlerde ≥5.33:1 sağlar (ölçüldü).
                'primary-light': '#60a5fa',
                'background-light': '#f5f7f8',
                'background-dark': '#0b1120'
            },
            fontFamily: {
                display: ['Public Sans', 'Segoe UI', 'sans-serif']
            },
            borderRadius: {
                DEFAULT: '0.25rem',
                lg: '0.5rem',
                xl: '0.75rem',
                full: '9999px'
            }
        }
    },
    plugins: []
};
