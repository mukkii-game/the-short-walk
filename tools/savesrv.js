/* 音素材加工ツール用の保存サーバ
 *
 *   node tools/savesrv.js
 *
 * tools/prepare-audio.html から POST された wav を assets/sfx/ に書き出す。
 * ブラウザのダウンロードで受け取るならこのサーバは不要（ツール側にリンクも出る）。
 * 書き込み先は assets/sfx/ 配下のみに制限している。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOW = path.join(ROOT, 'assets', 'sfx');
const PORT = 8125;

fs.mkdirSync(ALLOW, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.method !== 'POST') { res.end('save server: POST {path, b64}'); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      const dest = path.resolve(ROOT, j.path);
      if (!dest.startsWith(ALLOW + path.sep)) throw new Error('assets/sfx/ の外には書けません: ' + j.path);
      const buf = Buffer.from(j.b64, 'base64');
      fs.writeFileSync(dest, buf);
      console.log('saved', path.relative(ROOT, dest), buf.length, 'bytes');
      res.end('ok');
    } catch (e) {
      res.statusCode = 400;
      res.end(String(e));
      console.error('failed:', String(e));
    }
  });
}).listen(PORT, () => console.log('save server on http://localhost:' + PORT));
