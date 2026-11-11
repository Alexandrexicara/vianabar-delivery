'use strict';
const fs = require('fs');
const vm = require('vm');
const files = ['usuario.html','admin.html','cozinha.html','garcom.html','balcao.html','creator-woovi.html'];
let failures = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)];
  let index = 0;
  for (const match of scripts) {
    if (/\\bsrc\\s*=/.test(match[1])) continue;
    const code = match[2].trim();
    if (!code) continue;
    try { new vm.Script(code, { filename: file + ':inline-' + (++index) }); }
    catch (error) { failures++; process.stderr.write(file + ' inline script ' + index + ': ' + error.message + '\\n'); }
  }
}
if (failures) process.exit(1);
process.stdout.write('HTML inline scripts: syntax OK\\n');
