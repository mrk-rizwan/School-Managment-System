/**
 * Runs the route suite last. Its R57 check reads the audit rows every other suite wrote and
 * fails as vacuous on a fresh database if it starts first; Jest's default order (largest file
 * first) put it first once its tables grew.
 */
// Jest's own default sequencer, reached through jest (pnpm does not hoist it to this package).
const core = require.resolve('@jest/core', { paths: [require.resolve('jest')] });
const Sequencer = require(require.resolve('@jest/test-sequencer', { paths: [core] })).default;

const LAST = /[\\/]test[\\/]core[\\/]routes\.e2e-spec\.ts$/;

class RoutesLastSequencer extends Sequencer {
  sort(tests) {
    const sorted = super.sort(tests);
    return [...sorted.filter((t) => !LAST.test(t.path)), ...sorted.filter((t) => LAST.test(t.path))];
  }
}

module.exports = RoutesLastSequencer;
