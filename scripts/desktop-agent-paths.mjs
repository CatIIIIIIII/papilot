import fs from 'node:fs';
fs.writeFileSync('.desktop/app/agent-paths.mjs', fs.readFileSync('bin/agent-paths.mjs', 'utf8').replace('../engine/src/core/platform.mjs', './platform.mjs'));
fs.copyFileSync('engine/src/core/platform.mjs', '.desktop/app/platform.mjs');
for (const file of ['environment.html', 'environment.css', 'environment-ui.mjs', 'wsl-runtime.mjs']) fs.copyFileSync('desktop/' + file, '.desktop/app/' + file);
