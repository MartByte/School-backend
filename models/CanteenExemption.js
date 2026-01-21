const mongoose = require('mongoose');

const CanteenExemptionSchema = new mongoose.Schema({
    studentID: { type: Number, required: true },
    active: { type: Number, default: 0 }
});

module.exports = mongoose.model('CanteenExemption', CanteenExemptionSchema, 'canteen_exemptions');