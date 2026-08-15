'use strict';
/**
 * Markdown renderer - direct serialization of the node tree, no docx
 * round-trip (canon §7), so it can't inherit docx-specific bugs. First of
 * the three renderers built, deliberately, for the fastest feedback loop
 * on whether the node tree itself is right (build-plan.md Phase 3).
 */

function renderNode(node) {
  switch (node.type) {
    case 'heading': return `${'#'.repeat(Math.min(node.level + 1, 6))} ${node.text}`;
    case 'paragraph': return node.text;
    case 'bullets': return node.items.map(i => `- ${i}`).join('\n');
    case 'checked_bullets': return node.items.map(i => `- ${i.text}${i.reason ? ` (${i.reason})` : ''}`).join('\n');
    case 'kv_list': return node.items.map(i => `**${i.label}**  ${i.value}`).join('\n\n');
    case 'truth_check': {
      const used = `**Sections used:** ${node.sectionsUsed.join(', ')}`;
      const must = node.mustNotSay.length
        ? `**What we must not say:**\n${node.mustNotSay.map(m => `- ${m.claim}${m.reason ? ` (${m.reason})` : ''}`).join('\n')}`
        : '';
      return [used, must].filter(Boolean).join('\n\n');
    }
    case 'table': {
      const header = `| ${node.header.join(' | ')} |`;
      const sep = `| ${node.header.map(() => '---').join(' | ')} |`;
      const rows = node.rows.map(r => `| ${r.join(' | ')} |`);
      return [header, sep, ...rows].join('\n');
    }
    default: return '';
  }
}

function renderMarkdown(docTree) {
  const parts = [`# ${docTree.headline}`];
  if (docTree.metaLine) parts.push(`*${docTree.metaLine}*`);
  for (const node of docTree.sections) parts.push(renderNode(node));
  if (docTree.footerNote) parts.push(`---\n\n*${docTree.footerNote}*`);
  return parts.filter(Boolean).join('\n\n') + '\n';
}

module.exports = { renderMarkdown, renderNode };
