// BOXトラッカーの保存先。環境変数 OUT_ROOT でまるごと別の場所に切り替えられる（テスト用）。
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ROOT = process.env.OUT_ROOT ? path.resolve(process.env.OUT_ROOT) : REPO;

module.exports = {
  REPO,
  ROOT,
  CONFIG: path.join(REPO, 'config', 'box-targets.json'),
  BOX_DIR: path.join(ROOT, 'data', 'box'),
  STATE: path.join(ROOT, 'data', 'box', 'state.json'),
  PRODUCTS: path.join(ROOT, 'data', 'box', 'products.json'),
  ALIASES: path.join(REPO, 'config', 'product-aliases.json'),
  DECISIONS: path.join(ROOT, 'data', 'box', 'decisions.json'),
  INBOX_DIR: path.join(ROOT, 'data', 'box', 'manual', 'inbox'),
  DONE_DIR: path.join(ROOT, 'data', 'box', 'manual', 'done'),
  HISTORY_DIR: path.join(ROOT, 'data', 'box', 'history'),
  RUNS: path.join(ROOT, 'data', 'box', 'runs.jsonl'),
  EVENTS: path.join(ROOT, 'data', 'box', 'events.jsonl'),
  BACKUP_DIR: path.join(ROOT, 'backups'),
  DOCS_DIR: path.join(ROOT, 'docs'),
  IMG_DIR: path.join(ROOT, 'docs', 'img', 'box'),
};
