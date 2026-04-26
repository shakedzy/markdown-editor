import GithubSlugger from 'github-slugger';

const slugger = new GithubSlugger();

export function resetSlugger(): void {
  slugger.reset();
}

export function slug(text: string): string {
  return slugger.slug(text);
}
