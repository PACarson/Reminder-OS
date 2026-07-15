require('./mocks.js');

const fs = require('fs');
const path = require('path');
const eventBusSrc = fs.readFileSync(path.join(__dirname, '20_EventBus.txt'), 'utf8');
const testSrc = fs.readFileSync(path.join(__dirname, '50_EventBus_Tests.txt'), 'utf8');

eval(eventBusSrc);
eval(testSrc);

const result = runEventBusTests();
console.log('\n=== HARNESS RESULT: ' + JSON.stringify(result) + ' ===');
if (result.fail > 0) {
  console.log('FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
