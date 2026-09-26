// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const source = resolve(process.env.POS_DB_PATH || './data/pos.sqlite');
const target = resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(source) || existsSync(target) || source === target) {
  process.stderr.write('用法：POS_DB_PATH=./data/pos.sqlite node scripts/backup.js ./backup-YYYYMMDD.sqlite\n目标文件不得已存在。\n');
  process.exit(1);
}
const db = new DatabaseSync(source);
try {
  db.prepare('VACUUM INTO ?').run(target);
  const copy = new DatabaseSync(target);
  const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  copy.close();
  if (check !== 'ok') throw Error(`备份完整性检查失败：${check}`);
  process.stdout.write(`备份完成并通过完整性检查：${target}\n`);
} finally { db.close(); }
