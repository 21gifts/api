/** Test-process clock only. Production entry points never import this module. */
import process from 'node:process';

const NativeDate = globalThis.Date;
const realNow = NativeDate.now.bind(NativeDate);
const started = realNow();
const anchor = NativeDate.parse(process.env.E2E_CLOCK_ISO ?? '2026-09-24T12:00:00.000Z');
if (!Number.isFinite(anchor)) throw new Error('Invalid E2E_CLOCK_ISO');

// Keep time moving for timeout/deadline tests, while removing the host weekday.
function TestDate(...args) {
  if (new.target)
    return args.length === 0 ? new NativeDate(TestDate.now()) : new NativeDate(...args);
  return new NativeDate(TestDate.now()).toString();
}
Object.setPrototypeOf(TestDate, NativeDate);
TestDate.prototype = NativeDate.prototype;
TestDate.now = () => anchor + realNow() - started;
globalThis.Date = TestDate;
