function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function adfNodeToText(node) {
  if (node === null || node === undefined) {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(adfNodeToText).filter(Boolean).join(' ');
  }

  if (typeof node !== 'object') {
    return '';
  }

  if (node.type === 'text') {
    return node.text || '';
  }

  if (node.type === 'hardBreak' || node.type === 'rule') {
    return '\n';
  }

  if (node.type === 'mention') {
    return node.attrs?.text || node.attrs?.id || '';
  }

  if (node.type === 'emoji') {
    return node.attrs?.shortName || node.attrs?.text || '';
  }

  if (node.type === 'inlineCard' || node.type === 'blockCard') {
    return node.attrs?.url || '';
  }

  if (node.text) {
    return node.text;
  }

  if (node.value) {
    return String(node.value);
  }

  if (node.name) {
    return String(node.name);
  }

  if (node.displayName) {
    return String(node.displayName);
  }

  if (node.content) {
    const text = node.content.map(adfNodeToText).filter(Boolean).join(
      ['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'codeBlock', 'blockquote'].includes(node.type)
        ? '\n'
        : ' ',
    );

    return text;
  }

  return '';
}

function adfToText(value) {
  return normalizeWhitespace(adfNodeToText(value));
}

module.exports = {
  adfToText,
};
