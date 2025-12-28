const { checkInfaktDuplicate } = require('../src/infakt/api');
const logger = require('../src/utils/logger');

// Mock Logger to prevent spam
logger.info = console.log;

const mockInfaktInvoices = [
    {
        id: 123,
        number: 'ET6U76ZX-0001',
        net_price: '2032.52', // 2500 gross / 1.23 approx
        gross_price: '2500.00'
    },
    {
        id: 456,
        number: 'FV/2024/12/100',
        net_price: '100.00',
        gross_price: '123.00'
    }
];

const testCases = [
    {
        name: 'Exact Match Case',
        candidate: { number: 'ET6U76ZX-0001', total_amount: 2500.00 },
        expected: true
    },
    {
        name: 'Prefix Mismatch Case (The reported issue)',
        candidate: { number: 'Invoice-ET6U76ZX-0001', total_amount: 2500.00 },
        expected: true
    },
    {
        name: 'Different Number, Same Price (Should NOT match)',
        candidate: { number: 'DIFFERENT-NUMBER', total_amount: 2500.00 },
        expected: false
    },
    {
        name: 'Same Number, Different Price (Should NOT match)',
        candidate: { number: 'ET6U76ZX-0001', total_amount: 5000.00 },
        expected: false
    },
    {
        name: 'Substring Match but too short (Should NOT match)',
        // e.g. Infakt has "1", candidate has "11". Overlap "1" is length 1 < 5.
        // But let's test based on code min length 5.
        candidate: { number: '1234', total_amount: 100.00 },
        // We need a mock invoice for this
        expected: false
    }
];

console.log('--- Starting Verification ---');

let passed = 0;
for (const test of testCases) {
    const result = checkInfaktDuplicate(test.candidate, mockInfaktInvoices);
    if (result === test.expected) {
        console.log(`✅ ${test.name}: PASS`);
        passed++;
    } else {
        console.error(`❌ ${test.name}: FAIL (Expected ${test.expected}, got ${result})`);
    }
}

if (passed === testCases.length) {
    console.log('\nALL TESTS PASSED');
    process.exit(0);
} else {
    console.log(`\n${testCases.length - passed} TESTS FAILED`);
    process.exit(1);
}
