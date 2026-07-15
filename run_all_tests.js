// run_all_tests.js — runs every Node-sandbox test suite in this repo and
// prints a combined summary. Each suite runs in its own child process
// (rather than being require()'d in-process) because they eval() GAS
// source files into the global scope and would otherwise collide with
// each other (e.g. two different SheetUtils/global.Logger definitions
// in the same process).
//
// 🔧 说明：TemporalEngine 没有包含在这里——12_TemporalEngine.gs 是 Pure
// Function、零依赖，设计上就是直接贴进 GAS 编辑器手动跑
// runTemporalEngineTests()（见该文件和 50_TemporalEngine_Tests.gs 自己的
// 文件头），不是这套 Node 沙盒基础设施的一部分。

const { execFileSync } = require('child_process');
const path = require('path');

const suites = [
  'run_sheetutils_tests.js',
  'run_eventbus_tests.js',
  'run_output_tests.js',
  'run_offset_tests.js'
];

let totalPass = 0, totalFail = 0, anyFailed = false;

suites.forEach(function (suite) {
  console.log('\n----- ' + suite + ' -----');
  try {
    const out = execFileSync('node', [path.join(__dirname, suite)], { encoding: 'utf8' });
    console.log(out.trim());
    const m = out.match(/HARNESS RESULT: (\{.*\})/);
    if (m) {
      const result = JSON.parse(m[1]);
      totalPass += result.pass;
      totalFail += result.fail;
    }
  } catch (e) {
    anyFailed = true;
    console.log((e.stdout || '') + (e.stderr || ''));
    console.log(suite + ' exited with a failure.');
  }
});

console.log('\n===== ALL SUITES: ' + totalPass + ' passed, ' + totalFail + ' failed =====');
process.exit(anyFailed || totalFail > 0 ? 1 : 0);
