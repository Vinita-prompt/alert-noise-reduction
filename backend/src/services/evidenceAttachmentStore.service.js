const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function storageRoot(env = process.env) {
  return path.resolve(
    env.EVIDENCE_ATTACHMENT_STORAGE_DIR
      || path.join(__dirname, '../../data/evidence-attachments'),
  );
}

function assertStorageKey(value) {
  const key = String(value || '');
  if (!SAFE_KEY.test(key)) throw new Error('Invalid evidence attachment storage key.');
  return key;
}

function createEvidenceAttachmentStore({ root = storageRoot(), filesystem = fs } = {}) {
  async function persist(attachmentId, content) {
    const key = `${assertStorageKey(attachmentId)}-${crypto.createHash('sha256').update(content).digest('hex')}`;
    await filesystem.mkdir(root, { recursive: true, mode: 0o750 });
    const finalPath = path.join(root, key);
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    try {
      await filesystem.writeFile(temporaryPath, content, { flag: 'wx', mode: 0o640 });
      await filesystem.rename(temporaryPath, finalPath);
    } catch (error) {
      await filesystem.rm(temporaryPath, { force: true }).catch(() => {});
      if (error.code !== 'EEXIST') throw error;
    }
    return { storageBackend: 'FILESYSTEM', storageKey: key };
  }

  async function read(key) {
    return filesystem.readFile(path.join(root, assertStorageKey(key)));
  }

  return { persist, read, root };
}

module.exports = {
  assertStorageKey,
  createEvidenceAttachmentStore,
  service: createEvidenceAttachmentStore(),
  storageRoot,
};
