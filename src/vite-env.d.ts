/// <reference types="vite/client" />

// CSS modules: typed as an opaque map of class names → generated strings.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// Plain CSS imports (used for global stylesheets and Leaflet's bundled CSS).
declare module '*.css';
