import type { Api } from '../../preload/preload';

declare global {
  interface Window {
    api: Api;
  }
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}

export {};
