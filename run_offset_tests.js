require('./mocks.js');

// 🐛 bugfix（2026-07-15）：原来这四个路径是上一次会话的沙盒绝对路径
// （/home/claude/work/output/*.gs），既不存在于这份 repo 的任何一次全新
// checkout 里，也不存在于 CC 自己电脑上——本身就是这份测试基础设施的一个
// 可移植性 bug，只是表现形式跟其余几个不一样（ENOENT 而不是
// ReferenceError）。改成相对本文件自身所在目录（__dirname）动态拼接，
// 直接指向仓库里真实的 .txt 源文件——不管这个 repo 被 clone/解压到哪台
// 机器的哪个路径，只要在这个目录下执行 node run_offset_tests.js 就能跑。
const fs = require('fs');
const path = require('path');
const sheetUtilsSrc = fs.readFileSync(path.join(__dirname, '21_SheetUtils.txt'), 'utf8');
const outputSrc = fs.readFileSync(path.join(__dirname, '40_Output.txt'), 'utf8');
const engineSrc = fs.readFileSync(path.join(__dirname, '26_ReminderOffsetEngine.txt'), 'utf8');
const testSrc = fs.readFileSync(path.join(__dirname, '50_ReminderOffsetEngine_Tests.txt'), 'utf8');

eval(sheetUtilsSrc);
eval(outputSrc);
eval(engineSrc);
eval(testSrc);

const result = runReminderOffsetEngineTests();
console.log('\n=== HARNESS RESULT: ' + JSON.stringify(result) + ' ===');
if (result.fail > 0) {
  console.log('FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
