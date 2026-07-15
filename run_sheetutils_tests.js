require('./mocks.js');

const fs = require('fs');
const path = require('path');
const sheetUtilsSrc = fs.readFileSync(path.join(__dirname, '21_SheetUtils.txt'), 'utf8');
const testSrc = fs.readFileSync(path.join(__dirname, '50_SheetUtils_Tests.txt'), 'utf8');

eval(sheetUtilsSrc);
eval(testSrc);

const result = runSheetUtilsTests();
console.log('\n=== HARNESS RESULT: ' + JSON.stringify(result) + ' ===');
if (result.fail > 0) {
  console.log('FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
