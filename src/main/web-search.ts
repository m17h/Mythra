/**
 * Public web search via DuckDuckGo’s instant-answer API (no API key; best-effort).
 * Results are approximate; the model should cite and verify critical facts.
 */
export async function searchWeb(query: string): Promise<string> {
  const q = query.trim();
  if (!q) {
    return 'Error: empty search query.';
  }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;

  let data: unknown;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OpenKiwi/0.1 (https://github.com) desktop assistant' }
    });
    if (!res.ok) {
      return `Web search request failed (HTTP ${res.status}). You can try again or share a direct link.`;
    }
    data = await res.json();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return `Web search failed: ${m}`;
  }

  const d = data as Record<string, unknown>;
  const lines: string[] = [];

  if (typeof d.Heading === 'string' && d.Heading.trim()) {
    lines.push(`Topic: ${d.Heading.trim()}`);
  }

  if (typeof d.AbstractText === 'string' && d.AbstractText.trim()) {
    lines.push(d.AbstractText.trim());
    if (typeof d.AbstractURL === 'string' && d.AbstractURL.trim()) {
      lines.push(`Source: ${d.AbstractURL.trim()}`);
    }
  }

  const related = d.RelatedTopics;
  if (Array.isArray(related) && related.length > 0) {
    lines.push('Related:');
    let count = 0;
    for (const item of related) {
      if (count >= 6) break;
      if (item && typeof item === 'object' && 'Text' in item && typeof (item as { Text: unknown }).Text === 'string') {
        lines.push(`- ${(item as { Text: string }).Text}`);
        count += 1;
      }
    }
  }

  if (lines.length === 0) {
    return [
      `DuckDuckGo returned no instant answer for: "${q}"`,
      'The topic may need a more specific query, or you can open a search manually.',
      `Example: https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    ].join('\n');
  }

  return lines.join('\n\n');
}
