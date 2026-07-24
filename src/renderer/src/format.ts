/** Formats a token count the way Claude Code's own UI does - "104k tokens" above 1,000,
 *  the exact count below (a compacted-away session, or one just started, reads oddly as "0k"). */
export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`
}
