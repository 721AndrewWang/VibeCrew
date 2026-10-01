import { execFileSync } from 'node:child_process';
import { ROOT } from '../helpers/server';

/** The server serves web/dist: build it so the tests exercise the current code. */
export default function globalSetup() {
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
