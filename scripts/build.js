// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import { mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const file of ['web/index.html','web/app.js','web/style.css','assets/zhuatech-logo.jpg','src/server.js','src/db.js','src/pos.js']) {
  readFileSync(join(root, file));
}
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const entry of ['package.json','Dockerfile','compose.yaml','.env.example','README.md','LICENSE','src','web','assets','docs','scripts','tests']) {
  cpSync(join(root, entry), join(dist, entry), { recursive: true });
}
process.stdout.write(`交付文件已生成：${dist}\n`);
