// Test only: preloaded into a Crew server (StartOptions.clock) so a test can move its clock forward,
// e.g. past the Watchdog's stuckMinutes, without waiting. The offset (ms) is read from the file in
// CREW_TEST_CLOCK_FILE, polled every 50 ms; Date.now() adds it. Timers (setTimeout, setInterval)
// still run in real time and `new Date()` is unchanged: only "how long ago" by Date.now() moves.
import fs from 'node:fs';

const file = process.env.CREW_TEST_CLOCK_FILE;
if (file) {
  const real = Date.now.bind(Date);
  let offset = 0;
  const read = () => {
    try {
      offset = Number(fs.readFileSync(file, 'utf8').trim()) || 0;
    } catch {
      offset = 0;
    }
  };
  read();
  setInterval(read, 50).unref();
  Date.now = () => real() + offset;
}
