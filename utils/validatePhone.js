function normalizeAndValidatePhone(phone) {
    if (!phone) return null;

    // Remove spaces and non-digit characters (optional)
    phone = phone.trim();

    // If it starts with 0, replace with +233
    if (phone.startsWith('0') && phone.length === 10) {
        phone = '+233' + phone.slice(1);
    }

    // Ensure it matches +233 followed by 9 digits
    const regex = /^\+233[2-5][0-9]{8}$/;
    return regex.test(phone) ? phone : null;
}

module.exports = normalizeAndValidatePhone;
