const mongoose = require('mongoose');
const feeSchema = new mongoose.Schema({
    studentID: String,
    amount: Number,
    date: { type: Date, default: Date.now },
    collectedBy: String,
    town: String,
    paymentType: String // 'daily', 'advance', 'credit', 'exempt', 'advance_topup'
});
module.exports = mongoose.model('CanteenFee', feeSchema);