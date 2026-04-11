#!/usr/bin/env node
/**
 * Generates sample-fuel.json and sample-metals.json in /data/
 * Usage: node scripts/export-sample-json.js
 */

var fs   = require('fs');
var path = require('path');

var fuelSample = [
  { city: 'Delhi',   state: 'Delhi',       petrol: 96.72,  diesel: 89.62,  price_date: '2025-01-15' },
  { city: 'Mumbai',  state: 'Maharashtra', petrol: 106.31, diesel: 94.27,  price_date: '2025-01-15' },
  { city: 'Chennai', state: 'Tamil Nadu',  petrol: 102.63, diesel: 94.24,  price_date: '2025-01-15' },
  { city: 'Kolkata', state: 'West Bengal', petrol: 106.03, diesel: 92.76,  price_date: '2025-01-15' },
];

var metalsSample = [
  { city: 'Delhi',  state: 'Delhi',       metal_type: 'gold',   price_24k: 7245.50, price_22k: 6641.67, price_18k: 4979.85, price_1g: null,  price_date: '2025-01-15' },
  { city: 'Delhi',  state: 'Delhi',       metal_type: 'silver', price_24k: null,    price_22k: null,    price_18k: null,    price_1g: 85.50, price_date: '2025-01-15' },
  { city: 'Mumbai', state: 'Maharashtra', metal_type: 'gold',   price_24k: 7290.00, price_22k: 6682.50, price_18k: 5001.88, price_1g: null,  price_date: '2025-01-15' },
  { city: 'Mumbai', state: 'Maharashtra', metal_type: 'silver', price_24k: null,    price_22k: null,    price_18k: null,    price_1g: 86.10, price_date: '2025-01-15' },
];

var outDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sample-fuel.json'),   JSON.stringify(fuelSample,   null, 2));
fs.writeFileSync(path.join(outDir, 'sample-metals.json'), JSON.stringify(metalsSample, null, 2));

console.log('Written: ' + path.join(outDir, 'sample-fuel.json'));
console.log('Written: ' + path.join(outDir, 'sample-metals.json'));
