/** A skill Claude has proposed, awaiting the user's decision. */
export interface SkillProposal {
  /** kebab-case; becomes the directory name and therefore the /command. */
  id: string;
  title: string;
  /** The skill's own frontmatter description - what Claude reads to decide to use it. */
  description: string;
  /** The SKILL.md body. */
  body: string;
  /** Why Edith thinks this is worth having, shown to the user during review. */
  rationale: string;
  /** Note ids this was derived from, so a proposal can be traced back. */
  sources: string[];
  status: 'proposed' | 'accepted' | 'rejected';
  created: string;
  decided?: string;
  /** Where it was installed, once accepted. */
  installedAt?: string;
}

export interface ForgeCounts {
  proposed: number;
  accepted: number;
  rejected: number;
}
