const config = require('../config');

/**
 * Validates if an invoice is for the user's company based on NIP or Name.
 * Supports vendor whitelisting for flexible buyer name matching.
 */
function validateBuyer(analysis, from, subject) {
    const configBuyerNip = (config.buyer_tax_id || '').replace(/[^0-9]/g, '');
    const configBuyerName = (config.buyer_name || '').toLowerCase();

    // Vendor Whitelist Logic
    let allowedNames = [configBuyerName];
    const vendorWhitelist = config.vendor_whitelist || [];

    const fromDomain = from.toLowerCase().match(/@([\w.-]+)/)?.[1];

    for (const vendor of vendorWhitelist) {
        if (!vendor.match) continue;

        const matchDomain = vendor.match.from_domain && fromDomain && fromDomain.includes(vendor.match.from_domain.toLowerCase());
        const matchSubject = vendor.match.subject_regex && new RegExp(vendor.match.subject_regex, 'i').test(subject);

        if (matchDomain || matchSubject) {
            console.log(`    -> Matched Vendor Whitelist: Matches ${matchDomain ? 'Domain' : ''} ${matchSubject ? 'Subject' : ''}`);
            if (vendor.allowed_buyer_names) {
                allowedNames = allowedNames.concat(vendor.allowed_buyer_names.map(n => n.toLowerCase()));
            }
        }
    }

    const invoiceBuyerNip = (analysis.data.buyer_tax_id || '').replace(/[^0-9]/g, '');
    const invoiceBuyerName = (analysis.data.buyer_name || '').toLowerCase();

    const nipMatches = configBuyerNip && invoiceBuyerNip === configBuyerNip;
    const nameMatches = allowedNames.some(name => name && invoiceBuyerName.includes(name));

    return {
        isValid: nipMatches || nameMatches,
        reason: nipMatches ? 'NIP matches' : (nameMatches ? 'Buyer name matches' : 'No NIP or Name match'),
        details: {
            expectedNip: config.buyer_tax_id,
            foundNip: analysis.data.buyer_tax_id,
            expectedNames: allowedNames,
            foundName: analysis.data.buyer_name
        }
    };
}

module.exports = { validateBuyer };
