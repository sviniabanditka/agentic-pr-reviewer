/** The pull request a review runs against. Its body goes in separately, as the author's claim. */
export interface PrContext {
  repo: string; // "owner/name"
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  branch: string;
}
