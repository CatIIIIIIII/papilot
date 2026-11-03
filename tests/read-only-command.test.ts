import test from 'node:test';
import assert from 'node:assert/strict';
import { readsOnly } from '../src/server/read-only-command.ts';

const root = '/work/paper';

test('commands that only read files in the task folder are recognized', () => {
  for (const command of [
    // As OpenCode ran it while revising a thesis chapter.
    "cat -n main/chapters/04-inference-closures/overview/closures.tex | head -80; echo ---; sed -n '1,80p' main/chapters/04-inference-closures/02-*.tex 2>/dev/null | head -100",
    'ls -la', 'pwd', 'wc -l main.tex sections/*.tex', 'tail -n +20 main.tex',
    "grep -rn --include=*.tex '\\\\cite{' .", 'rg -n "closure" sections', "sed -n '120,180p;200,$p' main.tex",
    'sed -n -e 5p main.tex', 'find . -name "*.tex" -newer main.tex', 'grep -c foo a.tex | sort -n | uniq -c',
    'git status --short && git diff -- main.tex', 'git --no-pager log --oneline -5', 'git show HEAD:sections/intro.tex',
    `cat ${root}/main.tex`, 'cat sections/../main.tex', 'diff a.tex b.tex 2>&1', "echo '~/not-home' \"\\$HOME\"",
  ]) assert.equal(readsOnly(command, root), true, command);
});

test('anything that can write, run another program or read outside the folder still asks', () => {
  for (const command of [
    'latexmk main.tex', 'rm -rf build', 'cat main.tex > copy.tex', 'cat main.tex >> notes.txt', 'echo x >/tmp/x',
    'cat < main.tex', 'cat main.tex | sh', 'cat $(ls)', 'cat `ls`', 'echo "$(id)"', 'cat $HOME/.ssh/id_rsa',
    'cat ~/.ssh/id_rsa', "cat ~'/.ssh/id_rsa'", 'cat /etc/passwd', 'cat ../secret.txt', 'ls ..', 'cat .*/secret', 'cat {..,.}/secret',
    'grep -r foo /', 'grep -f/etc/passwd x', 'grep --file=~/patterns x', 'sleep 1 &', 'cat main.tex &> /dev/null',
    "sed -i 's/a/b/' main.tex", "sed -n 'w out.txt' main.tex", "sed 's/a/b/' main.tex", "sed -n '1e id' main.tex",
    'find . -name "*.aux" -delete', 'find . -exec cat {} ;', 'rg --pre ./run x', 'rg -z x', 'sort -o out.txt main.tex', 'uniq in.txt out.txt',
    'git -c core.pager=sh log', 'git checkout main', 'git diff --output=patch.diff', 'git grep -O foo', 'git log --ext-diff -p',
    'FOO=1 cat main.tex', '/bin/cat main.tex', 'xargs cat', "cat 'unterminated", 'cat main.tex\\', '| cat main.tex', '(cat main.tex)',
  ]) assert.equal(readsOnly(command, root), false, command);
});

test('a command running elsewhere reads only if that folder is in the task folder', () => {
  assert.equal(readsOnly('cat main.tex', root, `${root}/sections`), true);
  assert.equal(readsOnly('cat ../main.tex', root, `${root}/sections`), true);
  assert.equal(readsOnly('cat ../../secret', root, `${root}/sections`), false);
  assert.equal(readsOnly('cat main.tex', root, '/etc'), false);
});
