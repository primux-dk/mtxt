/*
  The decisions block (docs/decisions.md, packet 5). In the body it is a
  checklist between `<!-- decisions -->` and `<!-- /decisions -->`; in the
  database it is the `decisions` rows, one per item in order. The rows are
  written from the body with every version, so ticking an item, editing its
  text in the editor or restoring an old version all end in rows that match
  the current version.

  An AI draft has no block yet: `liftDecisions` turns the draft's first
  checklist into it, and every `@Name` that is one of the meeting's
  speakers into a mention, of the colleague when the speaker is linked.
*/
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { MENTION_ID } from './extensions';
import { recapSchema } from './markdown';

export interface MeetingSpeaker {
  id: string;
  /** What the transcript calls them: the colleague's name when linked, else the label. */
  name: string;
  userId: string | null;
}

export interface DecisionRow {
  position: number;
  text: string;
  ownerUserId: string | null;
  done: boolean;
}

/** Text nodes with every `@Name` of a known speaker turned into a mention. */
function mentionText(text: string, marks: PmNode['marks'], speakers: readonly MeetingSpeaker[]) {
  const schema = recapSchema();
  // Longest name first, so "@Anne Holm" wins over "@Anne".
  const byLength = [...speakers]
    .filter((s) => s.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const out: PmNode[] = [];
  let rest = text;
  while (rest) {
    let found: { at: number; speaker: MeetingSpeaker } | null = null;
    for (const speaker of byLength) {
      const needle = `@${speaker.name}`;
      let at = rest.indexOf(needle);
      while (at !== -1) {
        const after = rest[at + needle.length];
        // A whole name: not "@Anne" inside "@Annette".
        if (!after || !/[\p{L}\p{N}]/u.test(after)) break;
        at = rest.indexOf(needle, at + 1);
      }
      if (at !== -1 && (!found || at < found.at)) found = { at, speaker };
    }
    if (!found) {
      out.push(schema.text(rest, marks));
      break;
    }
    if (found.at > 0) out.push(schema.text(rest.slice(0, found.at), marks));
    out.push(
      schema.nodes.mention!.create({
        id: found.speaker.userId ? `user:${found.speaker.userId}` : `speaker:${found.speaker.id}`,
        label: found.speaker.name,
      }),
    );
    rest = rest.slice(found.at + found.speaker.name.length + 1);
  }
  return out;
}

function withMentions(node: PmNode, speakers: readonly MeetingSpeaker[]): PmNode {
  if (node.isText) return node;
  if (node.isTextblock) {
    const children: PmNode[] = [];
    node.forEach((child) => {
      if (
        child.isText &&
        child.text?.includes('@') &&
        !child.marks.some((m) => m.type.name === 'code')
      ) {
        children.push(...mentionText(child.text, child.marks, speakers));
      } else children.push(child);
    });
    return node.copy(Fragment.from(children));
  }
  if (node.type.name === 'codeBlock') return node;
  const children: PmNode[] = [];
  node.forEach((child) => children.push(withMentions(child, speakers)));
  return node.copy(Fragment.from(children));
}

/** A task list as the decisions block: the same items, the same ticks. */
function asDecisionList(list: PmNode): PmNode {
  const schema = recapSchema();
  const items: PmNode[] = [];
  list.forEach((item) => {
    items.push(
      schema.nodes.decisionItem!.create({ checked: Boolean(item.attrs.checked) }, item.content),
    );
  });
  return schema.nodes.decisionList!.create(null, items);
}

/**
 * The AI draft made ready to store: speakers' names as mentions, and the
 * first checklist (anywhere in the document) as the decisions block, unless
 * the draft already has one.
 */
export function liftDecisions(doc: PmNode, speakers: readonly MeetingSpeaker[]): PmNode {
  const mentioned = withMentions(doc, speakers);
  let hasBlock = false;
  mentioned.descendants((n) => {
    if (n.type.name === 'decisionList') hasBlock = true;
    return !hasBlock;
  });
  return hasBlock ? mentioned : liftFirstChecklist(mentioned).node;
}

/** Where a block may stand: the document, a toggle's body, a callout. Not a list item or a table cell. */
const BLOCK_PARENTS = new Set(['doc', 'detailsContent', 'callout', 'details']);

/** The node with its first checklist (depth first) as the decisions block. */
function liftFirstChecklist(node: PmNode): { node: PmNode; done: boolean } {
  if (!BLOCK_PARENTS.has(node.type.name)) return { node, done: false };
  const children: PmNode[] = [];
  let done = false;
  node.forEach((child) => {
    if (done) children.push(child);
    else if (child.type.name === 'taskList') {
      children.push(asDecisionList(child));
      done = true;
    } else {
      const inner = liftFirstChecklist(child);
      children.push(inner.node);
      done = inner.done;
    }
  });
  return { node: done ? node.copy(Fragment.from(children)) : node, done };
}

/** An item's text: mentions as @Name, blocks joined by a space. */
function itemText(item: PmNode): string {
  return item
    .textBetween(0, item.content.size, ' ', (leaf) =>
      leaf.type.name === 'mention' ? `@${leaf.attrs.label ?? ''}` : '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The rows for a body: one per item of every decisions block, in order.
 * The owner is the item's first mention of a colleague, or of a speaker
 * linked to one.
 */
export function decisionRows(
  doc: PmNode,
  speakerUsers: ReadonlyMap<string, string | null> = new Map(),
): DecisionRow[] {
  const rows: DecisionRow[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'decisionItem') return true;
    let owner: string | null = null;
    node.descendants((leaf) => {
      if (owner || leaf.type.name !== 'mention') return !owner;
      const match = MENTION_ID.exec(String(leaf.attrs.id ?? ''));
      if (match?.[1] === 'user') owner = match[2]!;
      else if (match?.[1] === 'speaker') owner = speakerUsers.get(match[2]!) ?? null;
      return false;
    });
    rows.push({
      position: rows.length,
      text: itemText(node),
      ownerUserId: owner,
      done: Boolean(node.attrs.checked),
    });
    return false;
  });
  return rows;
}
