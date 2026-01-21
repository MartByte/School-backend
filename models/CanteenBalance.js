const mongoose = require('mongoose');

const CanteenBalanceSchema = new mongoose.Schema({
    studentID: { type: Number, required: true, unique: true },
    balance: { type: Number, default: 0 }
});

// The 3rd argument 'canteen_balances' MUST match your Atlas collection name
module.exports = mongoose.model('CanteenBalance', CanteenBalanceSchema, 'canteen_balances');