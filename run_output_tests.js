require('./mocks.js');

const fs = require('fs');
const path = require('path');
const outputSrc = fs.readFileSync(path.join(__dirname, '40_Output.txt'), 'utf8');
const testSrc = fs.readFileSync(path.join(__dirname, '50_Output_Tests.txt'), 'utf8');

eval(outputSrc);
eval(testSrc);

const result = runOutputTests();
console.log('\n=== HARNESS RESULT: ' + JSON.stringify(result) + ' ===');
if (result.fail > 0) {
  console.log('FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
