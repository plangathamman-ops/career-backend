/**
 * File upload validation - MIME type and magic bytes for resume/CV/docs
 * Allowed: PDF, DOC, DOCX
 */

const ALLOWED_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAGIC = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  doc: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
};

const ALLOWED_EXT = /\.(pdf|doc|docx)$/i;

export function validateDocFile(file) {
  if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
    return { valid: false, message: 'Invalid file' };
  }
  const ext = (file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.test(ext)) {
    return { valid: false, message: 'Only PDF, DOC, and DOCX files are allowed' };
  }
  const mime = file.mimetype || '';
  if (!ALLOWED_MIMES.includes(mime)) {
    return { valid: false, message: 'Invalid file type' };
  }
  if (file.buffer.length < 8) {
    return { valid: false, message: 'File too small or corrupted' };
  }
  const head = file.buffer.subarray(0, 8);
  const isPdf = head.subarray(0, 4).equals(MAGIC.pdf);
  const isDocx = head.subarray(0, 4).equals(MAGIC.docx);
  const isDoc = head.subarray(0, 4).equals(MAGIC.doc);
  if (!isPdf && !isDocx && !isDoc) {
    return { valid: false, message: 'File content does not match allowed types (PDF, DOC, DOCX)' };
  }
  return { valid: true };
}
