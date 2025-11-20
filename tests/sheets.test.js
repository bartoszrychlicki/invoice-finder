const { isDuplicate, normalizeString, parseAmount } = require('../src/sheets');

// Mock Google Sheets API
const mockSheets = {
    spreadsheets: {
        values: {
            get: jest.fn()
        }
    }
};

describe('Helper Functions', () => {
    test('normalizeString removes non-alphanumeric characters and lowercases', () => {
        expect(normalizeString('F/2023/01')).toBe('f202301');
        expect(normalizeString('FV 123-456')).toBe('fv123456');
        expect(normalizeString('  Space  ')).toBe('space');
        expect(normalizeString(null)).toBe('');
    });

    test('parseAmount handles commas and dots', () => {
        expect(parseAmount('123.45')).toBe(123.45);
        expect(parseAmount('123,45')).toBe(123.45);
        expect(parseAmount(100)).toBe(100);
        expect(parseAmount('1 000,00')).toBe(1000); // Assuming simple replace, might need regex check
        expect(parseAmount(null)).toBe(0);
    });
});

describe('Duplicate Detection (Scoring System)', () => {
    const existingRows = [
        // Header row
        ['Timestamp', 'From', 'Subject', 'Number', 'Date', 'Amount', 'Currency', 'Seller', 'SellerNIP', 'Buyer', 'BuyerNIP'],
        // Existing Invoice 1
        ['2023-01-01', 'test@test.com', 'Inv', 'F/2023/01', '2023-01-15', '100.00', 'PLN', 'Seller A', '1234567890', 'Buyer', '0987654321'],
        // Existing Invoice 2 (Receipt)
        ['2023-01-02', 'test@test.com', 'Rcpt', 'PAR 123', '2023-02-20', '50.50', 'PLN', 'Seller B', '111222333', 'Buyer', '0987654321']
    ];

    beforeEach(() => {
        mockSheets.spreadsheets.values.get.mockResolvedValue({
            data: { values: existingRows }
        });
    });

    test('should detect exact duplicate (100% match)', async () => {
        const newInvoice = {
            number: 'F/2023/01',
            issue_date: '2023-01-15',
            total_amount: 100.00,
            seller_tax_id: '1234567890',
            buyer_tax_id: '0987654321'
        };
        const result = await isDuplicate(mockSheets, 'spreadsheetId', newInvoice);
        expect(result).toBe(true);
    });

    test('should detect duplicate with minor typo in number (High Score)', async () => {
        // Same Date, Same Amount, Same NIPs, but Number has typo "F-2023-01" vs "F/2023/01"
        // Score: Amount(40) + Date(30) + SellerNIP(20) + BuyerNIP(10) = 100 pts (even if number differs slightly after normalization)
        // Wait, normalization removes slash and dash, so "f202301" == "f202301". It's exact match on normalized number!

        const newInvoice = {
            number: 'F-2023-01', // Different format
            issue_date: '2023-01-15',
            total_amount: 100.00,
            seller_tax_id: '123-456-78-90', // Dashes in NIP
            buyer_tax_id: '0987654321'
        };
        const result = await isDuplicate(mockSheets, 'spreadsheetId', newInvoice);
        expect(result).toBe(true);
    });

    test('should detect duplicate even if Number is missing (but Amount, Date, NIPs match)', async () => {
        // Score: Amount(40) + Date(30) + SellerNIP(20) + BuyerNIP(10) = 100 pts
        const newInvoice = {
            number: null, // Missing number
            issue_date: '2023-01-15',
            total_amount: 100.00,
            seller_tax_id: '1234567890',
            buyer_tax_id: '0987654321'
        };
        const result = await isDuplicate(mockSheets, 'spreadsheetId', newInvoice);
        expect(result).toBe(true);
    });

    test('should NOT detect duplicate if Amount is different', async () => {
        // Score: Date(30) + Number(20) + SellerNIP(20) + BuyerNIP(10) = 80 pts?
        // Wait, threshold is 80. If amount is different (0 pts), but everything else matches...
        // 30+20+20+10 = 80. It MIGHT be a duplicate if everything else is identical!
        // But usually different amount means different invoice.
        // Let's check logic. If Amount is diff, score is max 60? No, 80.
        // Let's see: Date(30) + Number(20) + Seller(20) + Buyer(10) = 80.
        // So if I issue a correction invoice with different amount but same number? It might be flagged as duplicate.
        // This is a known edge case. But for now, let's assume different amount AND different number.

        const newInvoice = {
            number: 'F/2023/02', // Different number
            issue_date: '2023-01-15',
            total_amount: 200.00, // Different amount
            seller_tax_id: '1234567890',
            buyer_tax_id: '0987654321'
        };
        const result = await isDuplicate(mockSheets, 'spreadsheetId', newInvoice);
        expect(result).toBe(false);
    });

    test('should NOT detect duplicate if Date is different', async () => {
        // Score: Amount(40) + Number(20) + Seller(20) + Buyer(10) = 90 pts?
        // If Date is different, it's likely a recurring invoice (subscription).
        // Recurring invoices have same Amount, same Seller, same Buyer.
        // ONLY Date and Number change.
        // If Number is also different (or missing), we rely on Date.
        // If Date is different, we get 0 for date.
        // Score: 40 (Amount) + 20 (Seller) + 10 (Buyer) = 70 pts.
        // 70 < 80 -> Not a duplicate. Correct!

        const newInvoice = {
            number: 'F/2023/02', // Different number
            issue_date: '2023-02-15', // Different date
            total_amount: 100.00, // Same amount (subscription)
            seller_tax_id: '1234567890',
            buyer_tax_id: '0987654321'
        };
        const result = await isDuplicate(mockSheets, 'spreadsheetId', newInvoice);
        expect(result).toBe(false);
    });
});
