import { appendFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((argument) => /\.test\.tsx?$/.test(argument));
const logPath = process.env.DBLAYER_FAKE_JEST_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify(files)}\n`);

const failOn = process.env.DBLAYER_FAKE_JEST_FAIL_ON;
if (failOn && files.some((file) => file.includes(failOn))) process.exit(7);

const sleepOn = process.env.DBLAYER_FAKE_JEST_SLEEP_ON;
if (sleepOn && files.some((file) => file.includes(sleepOn))) {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
