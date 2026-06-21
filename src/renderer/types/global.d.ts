import type { Api } from '../../preload/preload';

declare global {
  interface Window {
    api: Api;
  }

  // Injected at build time by Vite (see vite.config.ts) from package.json.
  const __APP_VERSION__: string;
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}

export {};
