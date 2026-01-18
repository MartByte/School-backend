require('dotenv').config();
const axios = require('axios');

// Generate a 6-digit code
function generateResetCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Format phone number (prepend +233 if it starts with 0)
function formatPhone(phone) {
    if (phone.startsWith('0')) {
        return '+233' + phone.slice(1);
    }
    return phone;
}

async function sendResetCodeSMS(phone, code) {
    const formattedPhone = formatPhone(phone);
    const message = `Your password reset code is: ${code}`;

    const payload = {
        From: process.env.HUBTEL_SENDER_ID || 'VICTORYINFO',
        To: formattedPhone,
        Content: message,
        RegisteredDelivery: true
    };

    const authHeader = `Basic ${Buffer.from(`${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`).toString('base64')}`;

    const url = `https://smsc.hubtel.com/v1/messages/send?clientid=${process.env.HUBTEL_CLIENT_ID}&clientsecret=${process.env.HUBTEL_CLIENT_SECRET}`;

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: authHeader
            }
        });

        console.log('SMS sent:', response.data);
        return response.data;
    } catch (error) {
        console.error('SMS failed:', error.response?.data || error.message);
        throw new Error('SMS sending failed');
    }
}

module.exports = {
    generateResetCode,
    sendResetCodeSMS
};
