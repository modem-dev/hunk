import { commitReviewInfo, comparisonReviewInfo } from "@hunk/vcs/review-info";
import type {
  ExtensionReviewDescriptor,
  ExtensionVcsDiffInput,
  ExtensionVcsHistoryCommit,
  ExtensionVcsShowInput,
} from "hunkdiff/extension";
import { runSlTextAsync, type SlBackedInput } from "./commands";

const SL_REVIEW_FIELDS = 6;
const SL_REVIEW_TEMPLATE =
  [
    "{node}",
    "{node|short}",
    "{desc|firstline}",
    "{author|person}",
    "{author|email}",
    "{date|isodatesec}",
  ].join("\\0") + "\\0";

interface SlReviewQueryOptions {
  cwd: string;
  slExecutable?: string;
  signal?: AbortSignal;
}

/** Parse fixed NUL-delimited Sapling template records into shared commit fields. */
export function parseSlReviewCommits(text: string): ExtensionVcsHistoryCommit[] {
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % SL_REVIEW_FIELDS !== 0) {
    throw new Error("Sapling returned a truncated review metadata record.");
  }

  const commits: ExtensionVcsHistoryCommit[] = [];
  for (let offset = 0; offset < fields.length; offset += SL_REVIEW_FIELDS) {
    const revisionId = fields[offset]!;
    const displayId = fields[offset + 1]!;
    const subject = fields[offset + 2]!;
    const authorName = fields[offset + 3]!;
    const authorEmail = fields[offset + 4]!;
    const authoredAt = new Date(fields[offset + 5]!).toISOString();
    if (!/^[0-9a-f]{40,64}$/i.test(revisionId) || !/^[0-9a-f]{4,64}$/i.test(displayId)) {
      throw new Error("Sapling returned an invalid review commit id.");
    }
    commits.push({
      revisionId,
      displayId,
      parentRevisionIds: [],
      subject: subject || "(no commit message)",
      authorName: authorName || "Unknown author",
      ...(authorEmail ? { authorEmail } : {}),
      authoredAt,
      decorations: [],
    });
  }
  return commits;
}

/** Load at most one more commit than the review-info pane can display. */
async function loadSlReviewCommits(
  input: SlBackedInput,
  revset: string,
  options: SlReviewQueryOptions,
) {
  return parseSlReviewCommits(
    await runSlTextAsync({
      input,
      args: ["log", "-r", revset, "--limit", "9", "--template", SL_REVIEW_TEMPLATE],
      ...options,
    }),
  );
}

/** Describe one Sapling commit when a direct show ref resolves unambiguously. */
export async function createSlCommitReview(
  input: ExtensionVcsShowInput,
  ref: string,
  options: SlReviewQueryOptions,
): Promise<ExtensionReviewDescriptor | undefined> {
  const commits = await loadSlReviewCommits(input, ref, options);
  return commits.length === 1 ? commitReviewInfo("Sapling", commits[0]!) : undefined;
}

/** Describe a two-revision Sapling diff, omitting commit rows when the bounded list is incomplete. */
export async function createSlComparisonReview(
  input: ExtensionVcsDiffInput,
  from: string,
  to: string,
  options: SlReviewQueryOptions,
): Promise<ExtensionReviewDescriptor | undefined> {
  const [baseCommits, headCommits] = await Promise.all([
    loadSlReviewCommits(input, from, options),
    loadSlReviewCommits(input, to, options),
  ]);
  if (baseCommits.length !== 1 || headCommits.length !== 1) return undefined;
  const base = baseCommits[0]!.revisionId;
  const head = headCommits[0]!.revisionId;
  const commits = await loadSlReviewCommits(input, `only(${head}, ${base})`, options);
  return commits.length <= 8
    ? comparisonReviewInfo("Sapling", base, head, commits, commits.length)
    : comparisonReviewInfo("Sapling", base, head, []);
}
