import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@mtxt/adapters';

/**
 * A search snippet with its hits marked, keyterm-style. The index wraps each
 * hit in two control characters (lib: searchSnippets); they become <mark>
 * here, so the meeting's own text never reaches the page as markup.
 */
export function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const open = rest.indexOf(SNIPPET_OPEN);
    if (open < 0) break;
    const close = rest.indexOf(SNIPPET_CLOSE, open);
    if (close < 0) break;
    if (open > 0) parts.push(rest.slice(0, open));
    parts.push(
      <mark key={key++} className="rounded-[3px] bg-accent px-[3px] py-px text-accent-foreground">
        {rest.slice(open + 1, close)}
      </mark>,
    );
    rest = rest.slice(close + 1);
  }
  parts.push(rest.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, ''));
  return <>{parts}</>;
}
