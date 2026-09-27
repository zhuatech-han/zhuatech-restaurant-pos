/* Copyright 2026 上海如静知华信息科技有限公司 · https://www.zhuatech.cn/ · 商业咨询微信：zhuatech / zhuatech2 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 发布资料检查不替代真实业务、权限和空库部署验收。
const root = fileURLToPath(new URL("../", import.meta.url));
const readme = await readFile(resolve(root, "README.md"), "utf8");
const license = await readFile(resolve(root, "LICENSE"), "utf8");
for (const marker of ["上海如静知华信息科技有限公司", "https://www.zhuatech.cn/", "zhuatech", "zhuatech2"]) {
  assert.ok(readme.includes(marker), "README 缺少公司或联系方式");
  assert.ok(license.includes(marker), "LICENSE 缺少公司或联系方式");
}
assert.ok(readme.includes("本项目由知华科技（上海如静知华信息科技有限公司）提供公开源码学习版本"), "README 缺少公开源码学习说明");
assert.ok(/非商业/.test(license), "LICENSE 未说明非商业范围");
const paths = new Set();
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img\b[^>]*src=["']([^"']+)["']/g)) paths.add(match[1] || match[2]);
for (const path of paths) {
  assert.ok(!/^(https?:|data:|\/)/.test(path), "README 图片必须位于仓库内");
  const target = resolve(root, decodeURIComponent(path));
  assert.ok(target.startsWith(resolve(root) + sep), "README 图片不能越过仓库根目录");
  const bytes = await readFile(target);
  assert.ok(bytes.length > 100, "README 图片为空或损坏");
  assert.ok(bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "README 图片不是有效 JPEG/PNG");
}
const qrPaths = ["assets/wechat-zhuatech.png", "assets/wechat-zhuatech2.png"];
const hashes = ["a1205aeec110016ca889693892250a11d449489f64d27c714816b73c3fc645e1", "98df6f15d17f94b88bc8bc115262b264fab0cfb5e6ca9443aaaf4143c5275215"];
for (const [i, path] of qrPaths.entries()) {
  assert.ok(paths.has(path), "README 必须展示两个原有二维码");
  assert.equal(createHash("sha256").update(await readFile(resolve(root, path))).digest("hex"), hashes[i], "原有二维码内容发生变化");
}
const env = await readFile(resolve(root, ".env.example"), "utf8");
for (const line of env.split("\n")) {
  if (/^(?:[A-Z_]*(?:PASSWORD|SECRET|API_KEY|TOKEN))=/.test(line)) assert.equal(line.split("=").slice(1).join(""), "", "示例配置不应含凭证值");
}
console.log(`发布资料通过：${paths.size} 张 README 图片、原有两张二维码、非商业许可和空凭证示例。此检查不代表全部企业功能达标。`);
